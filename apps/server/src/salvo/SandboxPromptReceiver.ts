// @effect-diagnostics globalTimers:off -- Fetch boundary uses cancellation to enforce a bounded request body read.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

export type SandboxPromptPrincipal = { readonly sandboxId: string };

export type SandboxPromptRequest = {
  readonly sandboxId: string;
  readonly requestId: string;
  readonly turnId: string;
  readonly model: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly reserveMicros: number;
};

export type SandboxGatewayResponse = {
  readonly gatewayProviderReceiptId: string;
  readonly text: string;
  readonly billedMicros: number;
};

export type SandboxPromptResponse = SandboxGatewayResponse & {
  readonly sandboxExecutionReceiptId: string;
  readonly requestId: string;
  readonly replayed: boolean;
};

export type SandboxPromptGatewayClient = {
  readonly execute: (input: {
    readonly grant: string;
    readonly request: Omit<SandboxPromptRequest, "sandboxId">;
  }) => Promise<SandboxGatewayResponse>;
};

export type SandboxPromptAuditEvent = {
  readonly event: "accepted" | "completed" | "replayed" | "rejected" | "gateway_failed";
  readonly sandboxId: string;
  readonly requestId: string;
  readonly reason?: SandboxPromptReceiverError["code"];
  readonly sandboxExecutionReceiptId?: string;
  readonly gatewayProviderReceiptId?: string;
};

export class SandboxPromptReceiverError extends Error {
  readonly code:
    | "invalid_request"
    | "authentication_required"
    | "sandbox_mismatch"
    | "invalid_grant"
    | "conflicting_replay"
    | "gateway_failed";

  constructor(code: SandboxPromptReceiverError["code"]) {
    super(code);
    this.code = code;
  }
}

type ReceiptRow = {
  sandbox_id: string;
  fingerprint: string;
  execution_receipt_id: string;
  gateway_receipt_id: string;
  response_text: string;
  billed_micros: number;
};

const validIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
const requestKeys = new Set([
  "sandboxId",
  "requestId",
  "turnId",
  "model",
  "prompt",
  "maxOutputTokens",
  "reserveMicros",
]);
const validRequest = (value: unknown): value is SandboxPromptRequest => {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<SandboxPromptRequest>;
  const keys = Object.keys(value);
  return (
    keys.length === requestKeys.size &&
    keys.every((key) => requestKeys.has(key)) &&
    validIdentifier(input.sandboxId) &&
    validIdentifier(input.requestId) &&
    validIdentifier(input.turnId) &&
    validIdentifier(input.model) &&
    typeof input.prompt === "string" &&
    input.prompt.length > 0 &&
    input.prompt.length <= 1_000_000 &&
    Number.isSafeInteger(input.maxOutputTokens) &&
    input.maxOutputTokens! > 0 &&
    input.maxOutputTokens! <= 100_000 &&
    Number.isSafeInteger(input.reserveMicros) &&
    input.reserveMicros! > 0
  );
};
const fingerprint = (request: SandboxPromptRequest, grant: string) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        request.sandboxId,
        request.requestId,
        request.turnId,
        request.model,
        request.prompt,
        request.maxOutputTokens,
        request.reserveMicros,
        NodeCrypto.createHash("sha256").update(grant).digest("hex"),
      ]),
    )
    .digest("hex");

/** Durable sandbox-side boundary. Only completed gateway calls become replayable receipts. */
export class SandboxPromptReceiver implements Disposable {
  readonly #database: NodeSqlite.DatabaseSync;
  readonly #inflight = new Map<
    string,
    { fingerprint: string; promise: Promise<SandboxPromptResponse> }
  >();
  readonly options: {
    readonly filename: string;
    readonly gateway: SandboxPromptGatewayClient;
    readonly authorizeGrant: (
      grant: string,
      binding: { readonly sandboxId: string; readonly requestId: string },
    ) => Promise<boolean>;
    readonly audit?: (event: SandboxPromptAuditEvent) => void;
    readonly makeReceiptId?: () => string;
  };

  constructor(options: {
    readonly filename: string;
    readonly gateway: SandboxPromptGatewayClient;
    readonly authorizeGrant: (
      grant: string,
      binding: { readonly sandboxId: string; readonly requestId: string },
    ) => Promise<boolean>;
    readonly audit?: (event: SandboxPromptAuditEvent) => void;
    readonly makeReceiptId?: () => string;
  }) {
    this.options = options;
    this.#database = new NodeSqlite.DatabaseSync(options.filename);
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS salvo_sandbox_execution_receipts (
        request_id TEXT PRIMARY KEY NOT NULL,
        sandbox_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        execution_receipt_id TEXT UNIQUE NOT NULL,
        gateway_receipt_id TEXT NOT NULL,
        response_text TEXT NOT NULL,
        billed_micros INTEGER NOT NULL
      ) STRICT;
    `);
  }

  async execute(
    principal: SandboxPromptPrincipal,
    grant: string,
    value: unknown,
  ): Promise<SandboxPromptResponse> {
    const requestId =
      value &&
      typeof value === "object" &&
      typeof (value as { requestId?: unknown }).requestId === "string"
        ? (value as { requestId: string }).requestId.slice(0, 200)
        : "invalid";
    const sandboxId = validIdentifier(principal.sandboxId) ? principal.sandboxId : "invalid";
    try {
      if (!validRequest(value)) throw new SandboxPromptReceiverError("invalid_request");
      const request = value;
      if (principal.sandboxId !== request.sandboxId)
        throw new SandboxPromptReceiverError("sandbox_mismatch");
      if (
        !(await this.options.authorizeGrant(grant, {
          sandboxId: request.sandboxId,
          requestId: request.requestId,
        }))
      ) {
        throw new SandboxPromptReceiverError("invalid_grant");
      }
      const digest = fingerprint(request, grant);
      const completed = this.#receipt(request.requestId);
      if (completed) return this.#replay(completed, request, digest);
      const active = this.#inflight.get(request.requestId);
      if (active) {
        if (active.fingerprint !== digest)
          throw new SandboxPromptReceiverError("conflicting_replay");
        return active.promise.then((result) => ({ ...result, replayed: true }));
      }
      const promise = this.#callGateway(request, grant, digest);
      this.#inflight.set(request.requestId, { fingerprint: digest, promise });
      try {
        return await promise;
      } finally {
        this.#inflight.delete(request.requestId);
      }
    } catch (cause) {
      const error =
        cause instanceof SandboxPromptReceiverError
          ? cause
          : new SandboxPromptReceiverError("gateway_failed");
      this.options.audit?.({
        event: error.code === "gateway_failed" ? "gateway_failed" : "rejected",
        sandboxId,
        requestId,
        reason: error.code,
      });
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
  [Symbol.dispose](): void {
    this.close();
  }

  async #callGateway(
    request: SandboxPromptRequest,
    grant: string,
    digest: string,
  ): Promise<SandboxPromptResponse> {
    this.options.audit?.({
      event: "accepted",
      sandboxId: request.sandboxId,
      requestId: request.requestId,
    });
    let gateway: SandboxGatewayResponse;
    try {
      const { sandboxId: _, ...gatewayRequest } = request;
      gateway = await this.options.gateway.execute({ grant, request: gatewayRequest });
    } catch {
      throw new SandboxPromptReceiverError("gateway_failed");
    }
    if (
      !validIdentifier(gateway.gatewayProviderReceiptId) ||
      typeof gateway.text !== "string" ||
      !Number.isSafeInteger(gateway.billedMicros) ||
      gateway.billedMicros < 0
    ) {
      throw new SandboxPromptReceiverError("gateway_failed");
    }
    const receiptId = (this.options.makeReceiptId ?? NodeCrypto.randomUUID)();
    this.#database
      .prepare(`INSERT INTO salvo_sandbox_execution_receipts
      (request_id, sandbox_id, fingerprint, execution_receipt_id, gateway_receipt_id, response_text, billed_micros)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        request.requestId,
        request.sandboxId,
        digest,
        receiptId,
        gateway.gatewayProviderReceiptId,
        gateway.text,
        gateway.billedMicros,
      );
    const response = {
      requestId: request.requestId,
      sandboxExecutionReceiptId: receiptId,
      gatewayProviderReceiptId: gateway.gatewayProviderReceiptId,
      text: gateway.text,
      billedMicros: gateway.billedMicros,
      replayed: false,
    } satisfies SandboxPromptResponse;
    this.options.audit?.({
      event: "completed",
      sandboxId: request.sandboxId,
      requestId: request.requestId,
      sandboxExecutionReceiptId: receiptId,
      gatewayProviderReceiptId: gateway.gatewayProviderReceiptId,
    });
    return response;
  }

  #receipt(requestId: string): ReceiptRow | undefined {
    return this.#database
      .prepare(`SELECT sandbox_id, fingerprint, execution_receipt_id,
      gateway_receipt_id, response_text, billed_micros FROM salvo_sandbox_execution_receipts WHERE request_id = ?`)
      .get(requestId) as ReceiptRow | undefined;
  }

  #replay(row: ReceiptRow, request: SandboxPromptRequest, digest: string): SandboxPromptResponse {
    if (row.sandbox_id !== request.sandboxId || row.fingerprint !== digest) {
      throw new SandboxPromptReceiverError("conflicting_replay");
    }
    this.options.audit?.({
      event: "replayed",
      sandboxId: request.sandboxId,
      requestId: request.requestId,
      sandboxExecutionReceiptId: row.execution_receipt_id,
      gatewayProviderReceiptId: row.gateway_receipt_id,
    });
    return {
      requestId: request.requestId,
      sandboxExecutionReceiptId: row.execution_receipt_id,
      gatewayProviderReceiptId: row.gateway_receipt_id,
      text: row.response_text,
      billedMicros: row.billed_micros,
      replayed: true,
    };
  }
}

const json = (status: number, body: Readonly<Record<string, unknown>>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Mount at a private relay route such as POST /salvo/sandbox/prompt. */
export const makeSandboxPromptFetchHandler =
  (options: {
    readonly receiver: SandboxPromptReceiver;
    readonly authenticate: (request: Request) => Promise<SandboxPromptPrincipal | null>;
    readonly maxBodyBytes?: number;
    readonly requestTimeoutMs?: number;
  }) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json(405, { code: "method_not_allowed" });
    const principal = await options.authenticate(request);
    if (!principal) return json(401, { code: "authentication_required" });
    const grant = request.headers.get("salvo-inference-grant");
    if (!grant) return json(401, { code: "invalid_grant" });
    const maxBodyBytes = options.maxBodyBytes ?? 1_100_000;
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes)
      return json(413, { code: "request_too_large" });
    let body: unknown;
    try {
      const text = await readBoundedBody(
        request,
        maxBodyBytes,
        options.requestTimeoutMs ?? 120_000,
      );
      body = JSON.parse(text);
    } catch (cause) {
      return json(cause === "request_too_large" ? 413 : cause === "request_timeout" ? 504 : 400, {
        code: typeof cause === "string" ? cause : "invalid_request",
      });
    }
    try {
      return json(200, await options.receiver.execute(principal, grant, body));
    } catch (cause) {
      const code = cause instanceof SandboxPromptReceiverError ? cause.code : "gateway_failed";
      const status =
        code === "sandbox_mismatch" || code === "invalid_grant"
          ? 403
          : code === "gateway_failed"
            ? 502
            : code === "conflicting_replay"
              ? 409
              : 400;
      return json(status, { code });
    }
  };

const readBoundedBody = async (
  request: Request,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> => {
  if (!request.body) throw "invalid_request";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const timeout = setTimeout(() => {
    void reader.cancel("request_timeout");
  }, timeoutMs);
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw "request_too_large";
      }
      chunks.push(result.value);
    }
  } catch (cause) {
    if (cause === "request_too_large") throw cause;
    throw "request_timeout";
  } finally {
    clearTimeout(timeout);
  }
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};
