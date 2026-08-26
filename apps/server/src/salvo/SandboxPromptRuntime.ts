// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off -- Standalone Node runtime boundary, not an Effect service.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import {
  SandboxPromptReceiver,
  makeSandboxPromptFetchHandler,
  type SandboxPromptPrincipal,
} from "./SandboxPromptReceiver.js";
import { CodexTurnRunner } from "./CodexTurnRunner.js";

export type SandboxPromptRuntimeConfig = {
  readonly sandboxId: string;
  readonly databasePath: string;
  readonly controlSecret: Uint8Array;
  readonly gatewayUrl: URL;
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly codexPath: string;
  readonly workspacePath: string;
  readonly codexHome: string;
  readonly skillsPath: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly reserveMicros: number;
};

const required = (env: NodeJS.ProcessEnv, key: string) => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`missing_${key.toLowerCase()}`);
  return value;
};
const equal = (left: Uint8Array, right: Uint8Array) =>
  left.byteLength === right.byteLength && NodeCrypto.timingSafeEqual(left, right);

export const loadSandboxPromptRuntimeConfig = (
  env: NodeJS.ProcessEnv,
): SandboxPromptRuntimeConfig => {
  if (env.SALVO_SANDBOX_RECEIVER_ENABLED !== "true")
    throw new Error("salvo_sandbox_receiver_disabled");
  const secretPath = NodePath.resolve(required(env, "SALVO_CONTROL_SECRET_FILE"));
  const secret = NodeFS.readFileSync(secretPath);
  const expectedHash = required(env, "SALVO_CONTROL_SECRET_SHA256").toLowerCase();
  const actualHash = NodeCrypto.createHash("sha256").update(secret).digest("hex");
  if (!equal(Buffer.from(actualHash), Buffer.from(expectedHash)))
    throw new Error("control_secret_hash_mismatch");
  if (secret.byteLength < 32 || secret.toString("utf8").trim() !== secret.toString("utf8"))
    throw new Error("invalid_control_secret");
  const gatewayUrl = new URL(required(env, "SALVO_INFERENCE_GATEWAY_URL"));
  if (gatewayUrl.protocol !== "https:" && env.NODE_ENV !== "test")
    throw new Error("gateway_must_use_https");
  const databasePath = NodePath.resolve(required(env, "SALVO_RECEIPT_DATABASE_PATH"));
  if (env.NODE_ENV !== "test" && !databasePath.startsWith("/var/lib/salvo/"))
    throw new Error("receipt_database_must_be_on_persistent_root_volume");
  const port = Number(env.SALVO_RECEIVER_PORT ?? 4318);
  const maxBodyBytes = Number(env.SALVO_RECEIVER_MAX_BODY_BYTES ?? 1_100_000);
  const requestTimeoutMs = Number(env.SALVO_RECEIVER_TIMEOUT_MS ?? 120_000);
  const maxOutputTokens = Number(required(env, "SALVO_CODEX_MAX_OUTPUT_TOKENS"));
  const reserveMicros = Number(required(env, "SALVO_CODEX_RESERVE_MICROS"));
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 120_000 ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    !Number.isSafeInteger(reserveMicros) ||
    reserveMicros < 1
  )
    throw new Error("invalid_receiver_bounds");
  return {
    sandboxId: required(env, "SALVO_SANDBOX_ID"),
    databasePath,
    controlSecret: secret,
    gatewayUrl,
    host: env.SALVO_RECEIVER_HOST ?? "127.0.0.1",
    port,
    maxBodyBytes,
    requestTimeoutMs,
    codexPath: env.SALVO_CODEX_PATH ?? "/opt/salvo/runtime/bin/codex",
    workspacePath: env.SALVO_WORKSPACE_PATH ?? "/var/lib/salvo/workspace",
    codexHome: env.SALVO_CODEX_HOME ?? "/var/lib/salvo/codex",
    skillsPath: env.SALVO_SKILLS_PATH ?? "/opt/salvo/skills",
    model: required(env, "SALVO_CODEX_MODEL"),
    maxOutputTokens,
    reserveMicros,
  };
};

const authenticate =
  (secret: Uint8Array, sandboxId: string) =>
  async (request: Request): Promise<SandboxPromptPrincipal | null> => {
    const value = request.headers.get("authorization");
    if (!value?.startsWith("Bearer ")) return null;
    return equal(Buffer.from(value.slice(7)), secret) ? { sandboxId } : null;
  };

const authorizeGrant =
  (secret: Uint8Array) =>
  async (grant: string, binding: { sandboxId: string; requestId: string }) => {
    // Sponsored grants are opaque relay tokens. The relay gateway performs their
    // durable sandbox/user/request binding check; the sandbox only rejects malformed input.
    if (/^[a-f0-9]{64}$/i.test(grant)) return true;
    const [version, encoded, signature, extra] = grant.split(".");
    if (version !== "v1" || !encoded || !signature || extra) return false;
    const expected = NodeCrypto.createHmac("sha256", secret)
      .update(`${version}.${encoded}`)
      .digest("base64url");
    if (!equal(Buffer.from(signature), Buffer.from(expected))) return false;
    try {
      const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;
      return (
        claims.sandboxId === binding.sandboxId &&
        claims.requestId === binding.requestId &&
        typeof claims.expiresAt === "number" &&
        claims.expiresAt > Date.now()
      );
    } catch {
      return false;
    }
  };

export const makeSandboxPromptRuntime = (
  config: SandboxPromptRuntimeConfig,
  dependencies: {
    readonly executeGateway?: (input: {
      readonly grant: string;
      readonly request: Record<string, unknown>;
    }) => Promise<{ gatewayProviderReceiptId: string; text: string; billedMicros: number }>;
  } = {},
) => {
  NodeFS.mkdirSync(NodePath.dirname(config.databasePath), { recursive: true, mode: 0o750 });
  let ready = true;
  let closing = false;
  const inflight = new Set<Promise<unknown>>();
  const codex = dependencies.executeGateway
    ? null
    : new CodexTurnRunner({
        codexPath: config.codexPath,
        workspacePath: config.workspacePath,
        codexHome: config.codexHome,
        skillsPath: config.skillsPath,
        proxyBaseUrl: new URL("/v1", config.gatewayUrl).href,
        turnCredential: Buffer.from(config.controlSecret).toString("utf8"),
        model: config.model,
        maxOutputTokens: config.maxOutputTokens,
        reserveMicros: config.reserveMicros,
        timeoutMs: config.requestTimeoutMs,
      });
  const receiver = new SandboxPromptReceiver({
    filename: config.databasePath,
    authorizeGrant: authorizeGrant(config.controlSecret),
    gateway: {
      execute: async ({ grant, request }) =>
        dependencies.executeGateway?.({ grant, request }) ?? codex!.execute({ grant, request }),
    },
  });
  const prompt = makeSandboxPromptFetchHandler({
    receiver,
    authenticate: authenticate(config.controlSecret, config.sandboxId),
    maxBodyBytes: config.maxBodyBytes,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const fetchHandler = async (request: Request) => {
    const path = new URL(request.url).pathname;
    const healthPath = `/v1/sandboxes/${encodeURIComponent(config.sandboxId)}/health`;
    const promptPath = `/v1/sandboxes/${encodeURIComponent(config.sandboxId)}/prompts`;
    if (path === "/ready" || path === healthPath) {
      if (
        path === healthPath &&
        !(await authenticate(config.controlSecret, config.sandboxId)(request))
      ) {
        return new Response(JSON.stringify({ code: "authentication_required" }), {
          status: 401,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      return ready && !closing
        ? new Response(JSON.stringify({ ready: true, sandboxId: config.sandboxId }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({ ready: false }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
    }
    if (path !== "/salvo/sandbox/prompt" && path !== promptPath)
      return new Response("Not Found", { status: 404 });
    if (closing) return new Response(JSON.stringify({ code: "shutting_down" }), { status: 503 });
    let normalized = request;
    if (path === promptPath) {
      let value: Record<string, unknown>;
      try {
        value = (await request.json()) as Record<string, unknown>;
      } catch {
        return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });
      }
      const grant =
        value.inferenceGrant && typeof value.inferenceGrant === "object"
          ? (value.inferenceGrant as Record<string, unknown>).token
          : undefined;
      normalized = new Request(request.url, {
        method: "POST",
        headers: {
          ...Object.fromEntries(request.headers),
          ...(typeof grant === "string" ? { "salvo-inference-grant": grant } : {}),
        },
        body: JSON.stringify({
          sandboxId: value.sandboxId,
          requestId: value.requestId,
          turnId: value.requestId,
          model: config.model,
          prompt: value.prompt,
          maxOutputTokens: config.maxOutputTokens,
          reserveMicros: config.reserveMicros,
        }),
      });
    }
    const operation = prompt(normalized);
    inflight.add(operation);
    try {
      const response = await operation;
      if (path !== promptPath || !response.ok) return response;
      const receipt = (await response.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          ...receipt,
          sandboxId: config.sandboxId,
          acceptedAt: new Date().toISOString(),
        }),
        {
          status: response.status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        },
      );
    } finally {
      inflight.delete(operation);
    }
  };
  return {
    fetch: fetchHandler,
    isReady: () => ready && !closing,
    close: async () => {
      closing = true;
      ready = false;
      await Promise.allSettled(inflight);
      receiver.close();
    },
  };
};

const toRequest = async (request: NodeHttp.IncomingMessage) => {
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request;
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(`http://${request.headers.host ?? "127.0.0.1"}${request.url ?? "/"}`, {
    method: request.method,
    headers,
    body: body as never,
    duplex: body ? "half" : undefined,
  } as RequestInit);
};

export const serveSandboxPromptRuntime = (config: SandboxPromptRuntimeConfig) => {
  const runtime = makeSandboxPromptRuntime(config);
  const server = NodeHttp.createServer(async (incoming, outgoing) => {
    const response = await runtime.fetch(await toRequest(incoming));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(config.port, config.host);
  const close = async () => {
    await runtime.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  return { runtime, server, close };
};
