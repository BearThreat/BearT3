// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  loadSandboxPromptRuntimeConfig,
  makeSandboxPromptRuntime,
  type SandboxPromptRuntimeConfig,
} from "./SandboxPromptRuntime.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});
const setup = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "salvo-runtime-"));
  dirs.push(dir);
  const secret = Buffer.from("test-control-secret");
  const config: SandboxPromptRuntimeConfig = {
    sandboxId: "sandbox-a",
    databasePath: NodePath.join(dir, "receipts.sqlite"),
    controlSecret: secret,
    gatewayUrl: new URL("https://gateway.test/execute"),
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 2048,
    requestTimeoutMs: 1_000,
    codexPath: "/opt/salvo/runtime/bin/codex",
    workspacePath: NodePath.join(dir, "workspace"),
    codexHome: NodePath.join(dir, "codex"),
    skillsPath: NodePath.join(dir, "skills"),
    model: "codex-mini",
    maxOutputTokens: 100,
    reserveMicros: 1_000,
  };
  const claims = Buffer.from(
    JSON.stringify({
      sandboxId: "sandbox-a",
      requestId: "request-1",
      expiresAt: Date.now() + 60_000,
    }),
  ).toString("base64url");
  const signature = NodeCrypto.createHmac("sha256", secret)
    .update(`v1.${claims}`)
    .digest("base64url");
  const grant = `v1.${claims}.${signature}`;
  const input = {
    sandboxId: "sandbox-a",
    requestId: "request-1",
    turnId: "turn-1",
    model: "codex-mini",
    prompt: "hello",
    maxOutputTokens: 100,
    reserveMicros: 1000,
  };
  const request = (authorization = "Bearer test-control-secret") =>
    new Request("http://127.0.0.1/salvo/sandbox/prompt", {
      method: "POST",
      headers: {
        authorization,
        "salvo-inference-grant": grant,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
  return { dir, config, request };
};

describe("SandboxPromptRuntime", () => {
  test("fails closed when disabled or when the runtime secret hash is wrong", () => {
    expect(() => loadSandboxPromptRuntimeConfig({})).toThrow("salvo_sandbox_receiver_disabled");
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "salvo-runtime-config-"));
    dirs.push(dir);
    const secretPath = NodePath.join(dir, "control-secret");
    NodeFS.writeFileSync(secretPath, "secret");
    expect(() =>
      loadSandboxPromptRuntimeConfig({
        SALVO_SANDBOX_RECEIVER_ENABLED: "true",
        SALVO_CONTROL_SECRET_FILE: secretPath,
        SALVO_CONTROL_SECRET_SHA256: "0".repeat(64),
        SALVO_INFERENCE_GATEWAY_URL: "https://gateway.test",
        SALVO_RECEIPT_DATABASE_PATH: NodePath.join(dir, "db.sqlite"),
        SALVO_SANDBOX_ID: "sandbox-a",
      }),
    ).toThrow("control_secret_hash_mismatch");
  });

  test("requires control-plane authentication and reports ready only after the database opens", async () => {
    const context = setup();
    const runtime = makeSandboxPromptRuntime(context.config, {
      executeGateway: async () => ({
        gatewayProviderReceiptId: "gw-1",
        text: "ok",
        billedMicros: 1,
      }),
    });
    expect((await runtime.fetch(new Request("http://127.0.0.1/ready"))).status).toBe(200);
    expect((await runtime.fetch(context.request("Bearer wrong"))).status).toBe(401);
    expect((await runtime.fetch(context.request())).status).toBe(200);
    await runtime.close();
    expect(runtime.isReady()).toBe(false);
    expect((await runtime.fetch(new Request("http://127.0.0.1/ready"))).status).toBe(503);
  });

  test("serves authenticated lifecycle health and prompt routes with bound receipts", async () => {
    const context = setup();
    const runtime = makeSandboxPromptRuntime(context.config, {
      executeGateway: async () => ({
        gatewayProviderReceiptId: "gw-1",
        text: "ok",
        billedMicros: 1,
      }),
    });
    const healthUrl = "http://127.0.0.1/v1/sandboxes/sandbox-a/health";
    expect((await runtime.fetch(new Request(healthUrl))).status).toBe(401);
    expect(
      (
        await runtime.fetch(
          new Request(healthUrl, { headers: { authorization: "Bearer test-control-secret" } }),
        )
      ).status,
    ).toBe(200);
    const prompt = new Request("http://127.0.0.1/v1/sandboxes/sandbox-a/prompts", {
      method: "POST",
      headers: { authorization: "Bearer test-control-secret", "content-type": "application/json" },
      body: JSON.stringify({
        sandboxId: "sandbox-a",
        userId: "user-a",
        requestId: "request-opaque",
        prompt: "hello",
        inferenceGrant: { token: "ab".repeat(32) },
      }),
    });
    const response = await runtime.fetch(prompt);
    const receipt = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(receipt.sandboxId).toBe("sandbox-a");
    expect(receipt.requestId).toBe("request-opaque");
    expect(typeof receipt.sandboxExecutionReceiptId).toBe("string");
    expect(typeof receipt.acceptedAt).toBe("string");
    await runtime.close();
  });

  test("replays a durable receipt after runtime restart", async () => {
    const context = setup();
    let calls = 0;
    const first = makeSandboxPromptRuntime(context.config, {
      executeGateway: async () => {
        calls++;
        return { gatewayProviderReceiptId: "gw-1", text: "ok", billedMicros: 1 };
      },
    });
    const original = (await (await first.fetch(context.request())).json()) as Record<
      string,
      unknown
    >;
    await first.close();
    const restarted = makeSandboxPromptRuntime(context.config, {
      executeGateway: async () => {
        calls++;
        throw new Error("unexpected");
      },
    });
    const replay = (await (await restarted.fetch(context.request())).json()) as Record<
      string,
      unknown
    >;
    expect(calls).toBe(1);
    expect(replay.sandboxExecutionReceiptId).toBe(original.sandboxExecutionReceiptId);
    expect(replay.replayed).toBe(true);
    await restarted.close();
  });

  test("stops readiness first and drains an active prompt before closing", async () => {
    const context = setup();
    let release!: () => void;
    let entered!: () => void;
    const gatewayEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runtime = makeSandboxPromptRuntime(context.config, {
      executeGateway: async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { gatewayProviderReceiptId: "gw-1", text: "ok", billedMicros: 1 };
      },
    });
    const active = runtime.fetch(context.request());
    await gatewayEntered;
    const closing = runtime.close();
    expect(runtime.isReady()).toBe(false);
    release();
    expect((await active).status).toBe(200);
    await closing;
  });
});
