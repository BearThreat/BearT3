import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import { type SponsoredInferenceBudgetConfig } from "./SponsoredInferenceBudget.js";
import { SponsoredInferenceBudgetRepository } from "./SponsoredInferenceBudgetRepository.js";

export type SponsoredInferencePrincipal = { readonly userId: string };

export type SponsoredInferenceRequest = {
  readonly requestId: string;
  readonly turnId: string;
  readonly model: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly reserveMicros: number;
};

export type SponsoredInferenceResponse = {
  readonly requestId: string;
  readonly text: string;
  readonly billedMicros: number;
  readonly replayed: boolean;
};

export type SponsoredInferenceProvider = {
  readonly execute: (input: {
    readonly idempotencyKey: string;
    readonly model: string;
    readonly prompt: string;
    readonly maxOutputTokens: number;
  }) => Promise<{ readonly text: string; readonly billedMicros: number }>;
};

export type SponsoredInferenceAuditEvent = {
  readonly type: "accepted" | "completed" | "rejected" | "failed";
  readonly requestId: string;
  readonly userId: string;
  readonly reason?: SponsoredInferenceGatewayError["code"];
};

export class SponsoredInferenceGatewayError extends Error {
  readonly code:
    | "invalid_request"
    | "invalid_grant"
    | "grant_expired"
    | "grant_revoked"
    | "global_stop"
    | "budget_denied"
    | "provider_failed"
    | "provider_over_budget"
    | "request_in_progress"
    | "conflicting_replay";

  constructor(code: SponsoredInferenceGatewayError["code"]) {
    super(code);
    this.code = code;
  }
}

type GrantPayload = {
  readonly version: 1;
  readonly purpose: "sponsored-inference";
  readonly grantId: string;
  readonly userId: string;
  readonly expiresAt: number;
};

type RequestRow = {
  request_id: string;
  user_id: string;
  fingerprint: string;
  state: "running" | "completed" | "failed";
  response_text: string | null;
  billed_micros: number | null;
};

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");
const fingerprint = (input: SponsoredInferenceRequest) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        input.turnId,
        input.model,
        input.prompt,
        input.maxOutputTokens,
        input.reserveMicros,
      ]),
    )
    .digest("hex");
const signature = (payload: string, secret: Buffer) =>
  base64url(NodeCrypto.createHmac("sha256", secret).update(payload).digest());

const validIdentifier = (value: string) => value.length > 0 && value.length <= 200;
const requestFields = new Set([
  "requestId",
  "turnId",
  "model",
  "prompt",
  "maxOutputTokens",
  "reserveMicros",
]);
const validateRequest = (input: SponsoredInferenceRequest) =>
  input !== null &&
  typeof input === "object" &&
  Object.keys(input).every((key) => requestFields.has(key)) &&
  Object.keys(input).length === requestFields.size &&
  validIdentifier(input.requestId) &&
  validIdentifier(input.turnId) &&
  validIdentifier(input.model) &&
  input.prompt.length > 0 &&
  input.prompt.length <= 1_000_000 &&
  Number.isSafeInteger(input.maxOutputTokens) &&
  input.maxOutputTokens > 0 &&
  input.maxOutputTokens <= 100_000 &&
  Number.isSafeInteger(input.reserveMicros) &&
  input.reserveMicros > 0;

export const issueSponsoredInferenceGrant = (input: {
  readonly secret: Buffer;
  readonly grantId: string;
  readonly userId: string;
  readonly expiresAt: number;
}): string => {
  if (
    !validIdentifier(input.grantId) ||
    !validIdentifier(input.userId) ||
    !Number.isSafeInteger(input.expiresAt)
  ) {
    throw new Error("invalid grant fields");
  }
  const payload: GrantPayload = {
    version: 1,
    purpose: "sponsored-inference",
    grantId: input.grantId,
    userId: input.userId,
    expiresAt: input.expiresAt,
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${signature(encoded, input.secret)}`;
};

export class SponsoredInferenceGateway implements Disposable {
  readonly #database: NodeSqlite.DatabaseSync;
  readonly #budget: SponsoredInferenceBudgetRepository;
  readonly options: {
    readonly filename: string;
    readonly signingSecret: Buffer;
    readonly budget: SponsoredInferenceBudgetConfig;
    readonly allowedModels: ReadonlySet<string>;
    readonly provider: SponsoredInferenceProvider;
    readonly now?: () => number;
    readonly audit?: (event: SponsoredInferenceAuditEvent) => void;
  };

  constructor(options: {
    readonly filename: string;
    readonly signingSecret: Buffer;
    readonly budget: SponsoredInferenceBudgetConfig;
    readonly allowedModels: ReadonlySet<string>;
    readonly provider: SponsoredInferenceProvider;
    readonly now?: () => number;
    readonly audit?: (event: SponsoredInferenceAuditEvent) => void;
  }) {
    this.options = options;
    if (options.signingSecret.byteLength < 32)
      throw new Error("signing secret must be at least 32 bytes");
    this.#database = new NodeSqlite.DatabaseSync(options.filename);
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS salvo_sponsored_inference_control (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), stopped INTEGER NOT NULL CHECK (stopped IN (0, 1))
      ) STRICT;
      INSERT OR IGNORE INTO salvo_sponsored_inference_control (singleton, stopped) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS salvo_sponsored_inference_revocations (
        grant_id TEXT PRIMARY KEY NOT NULL, revoked_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS salvo_sponsored_inference_requests (
        request_id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
        response_text TEXT, billed_micros INTEGER
      ) STRICT;
    `);
    this.#budget = new SponsoredInferenceBudgetRepository(options.filename);
  }

  setGlobalStop(stopped: boolean): void {
    this.#database
      .prepare("UPDATE salvo_sponsored_inference_control SET stopped = ? WHERE singleton = 1")
      .run(stopped ? 1 : 0);
  }

  revoke(grantId: string): void {
    this.#database
      .prepare(
        "INSERT OR IGNORE INTO salvo_sponsored_inference_revocations (grant_id, revoked_at_ms) VALUES (?, ?)",
      )
      .run(grantId, this.#now());
  }

  async execute(
    principal: SponsoredInferencePrincipal,
    grant: string,
    input: SponsoredInferenceRequest,
  ): Promise<SponsoredInferenceResponse> {
    let attributedUser = principal.userId;
    const auditRequestId =
      input !== null && typeof input === "object" && typeof input.requestId === "string"
        ? input.requestId.slice(0, 200)
        : "invalid";
    try {
      if (
        !validIdentifier(principal.userId) ||
        !validateRequest(input) ||
        !this.options.allowedModels.has(input.model)
      )
        throw new SponsoredInferenceGatewayError("invalid_request");
      const payload = this.#verifyGrant(grant);
      attributedUser = payload.userId;
      if (payload.userId !== principal.userId)
        throw new SponsoredInferenceGatewayError("invalid_grant");
      if (this.#isStopped()) throw new SponsoredInferenceGatewayError("global_stop");
      if (this.#isRevoked(payload.grantId))
        throw new SponsoredInferenceGatewayError("grant_revoked");

      const requestFingerprint = fingerprint(input);
      const existing = this.#request(input.requestId);
      if (existing) {
        if (existing.user_id !== principal.userId || existing.fingerprint !== requestFingerprint) {
          throw new SponsoredInferenceGatewayError("conflicting_replay");
        }
        if (existing.state === "completed")
          return {
            requestId: input.requestId,
            text: existing.response_text!,
            billedMicros: existing.billed_micros!,
            replayed: true,
          };
        if (existing.state === "failed")
          throw new SponsoredInferenceGatewayError("provider_failed");
        throw new SponsoredInferenceGatewayError("request_in_progress");
      }

      const reserved = this.#budget.reserve(this.options.budget, {
        id: input.requestId,
        userId: principal.userId,
        turnId: input.turnId,
        amountMicros: input.reserveMicros,
      });
      if (!reserved.ok) throw new SponsoredInferenceGatewayError("budget_denied");
      const claimed = this.#database
        .prepare(`INSERT OR IGNORE INTO salvo_sponsored_inference_requests
        (request_id, user_id, fingerprint, state) VALUES (?, ?, ?, 'running')`)
        .run(input.requestId, principal.userId, requestFingerprint);
      if (claimed.changes !== 1 && !existing)
        throw new SponsoredInferenceGatewayError("request_in_progress");
      this.#audit({ type: "accepted", requestId: input.requestId, userId: principal.userId });

      let result: Awaited<ReturnType<SponsoredInferenceProvider["execute"]>>;
      try {
        result = await this.options.provider.execute({
          idempotencyKey: input.requestId,
          model: input.model,
          prompt: input.prompt,
          maxOutputTokens: input.maxOutputTokens,
        });
      } catch {
        this.#budget.release(input.requestId);
        this.#fail(input.requestId);
        throw new SponsoredInferenceGatewayError("provider_failed");
      }
      if (
        typeof result.text !== "string" ||
        result.text.length > 4_000_000 ||
        !Number.isSafeInteger(result.billedMicros) ||
        result.billedMicros < 0 ||
        result.billedMicros > input.reserveMicros
      ) {
        this.#budget.release(input.requestId);
        this.#fail(input.requestId);
        throw new SponsoredInferenceGatewayError("provider_over_budget");
      }
      const committed = this.#budget.commit(input.requestId, result.billedMicros);
      if (!committed.ok) throw new SponsoredInferenceGatewayError("provider_failed");
      this.#database
        .prepare(`UPDATE salvo_sponsored_inference_requests
        SET state = 'completed', response_text = ?, billed_micros = ? WHERE request_id = ?`)
        .run(result.text, result.billedMicros, input.requestId);
      this.#audit({ type: "completed", requestId: input.requestId, userId: principal.userId });
      return {
        requestId: input.requestId,
        text: result.text,
        billedMicros: result.billedMicros,
        replayed: false,
      };
    } catch (cause) {
      const error =
        cause instanceof SponsoredInferenceGatewayError
          ? cause
          : new SponsoredInferenceGatewayError("invalid_grant");
      this.#audit({
        type: error.code === "provider_failed" ? "failed" : "rejected",
        requestId: auditRequestId,
        userId: attributedUser,
        reason: error.code,
      });
      throw error;
    }
  }

  close(): void {
    this.#budget.close();
    this.#database.close();
  }
  [Symbol.dispose](): void {
    this.close();
  }
  #now(): number {
    return (this.options.now ?? Date.now)();
  }
  #audit(event: SponsoredInferenceAuditEvent): void {
    this.options.audit?.(event);
  }
  #isStopped(): boolean {
    return (
      this.#database
        .prepare("SELECT stopped FROM salvo_sponsored_inference_control WHERE singleton = 1")
        .get()!.stopped === 1
    );
  }
  #isRevoked(grantId: string): boolean {
    return (
      this.#database
        .prepare("SELECT 1 AS found FROM salvo_sponsored_inference_revocations WHERE grant_id = ?")
        .get(grantId) !== undefined
    );
  }
  #request(id: string): RequestRow | undefined {
    return this.#database
      .prepare(
        "SELECT request_id, user_id, fingerprint, state, response_text, billed_micros FROM salvo_sponsored_inference_requests WHERE request_id = ?",
      )
      .get(id) as RequestRow | undefined;
  }
  #fail(id: string): void {
    this.#database
      .prepare(
        "UPDATE salvo_sponsored_inference_requests SET state = 'failed' WHERE request_id = ?",
      )
      .run(id);
  }

  #verifyGrant(grant: string): GrantPayload {
    const [encoded, supplied, extra] = grant.split(".");
    if (!encoded || !supplied || extra) throw new SponsoredInferenceGatewayError("invalid_grant");
    const expected = signature(encoded, this.options.signingSecret);
    const left = Buffer.from(supplied);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !NodeCrypto.timingSafeEqual(left, right))
      throw new SponsoredInferenceGatewayError("invalid_grant");
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new SponsoredInferenceGatewayError("invalid_grant");
    }
    if (!payload || typeof payload !== "object")
      throw new SponsoredInferenceGatewayError("invalid_grant");
    const candidate = payload as Partial<GrantPayload>;
    if (
      candidate.version !== 1 ||
      candidate.purpose !== "sponsored-inference" ||
      typeof candidate.grantId !== "string" ||
      typeof candidate.userId !== "string" ||
      !validIdentifier(candidate.grantId) ||
      !validIdentifier(candidate.userId) ||
      typeof candidate.expiresAt !== "number" ||
      !Number.isSafeInteger(candidate.expiresAt)
    )
      throw new SponsoredInferenceGatewayError("invalid_grant");
    if (candidate.expiresAt <= this.#now())
      throw new SponsoredInferenceGatewayError("grant_expired");
    return candidate as GrantPayload;
  }
}
