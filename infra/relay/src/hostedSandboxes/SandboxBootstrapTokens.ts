// @effect-diagnostics globalDate:off globalErrorInEffectFailure:off globalErrorInEffectCatch:off runEffectInsideEffect:off deterministicKeys:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RelayDb from "../db.ts";
import {
  salvoHostedSandboxes,
  salvoSandboxBootstrapTokens as rows,
  salvoSandboxLifecycleHistory,
} from "../persistence/schema.ts";

export type SandboxBootstrapTokenRecord = {
  readonly tokenHash: string;
  readonly sandboxId: string;
  readonly userId: string;
  readonly clientToken: string;
  readonly expiresAtMs: number;
  readonly consumedAtMs: number | null;
};

export type SandboxBootstrapTokenRepository = {
  readonly insert: (record: SandboxBootstrapTokenRecord) => Promise<void>;
  /** Atomically marks an unconsumed, unexpired matching row consumed. */
  readonly consume: (input: {
    tokenHash: string;
    sandboxId: string;
    userId: string;
    clientToken: string;
    nowMs: number;
  }) => Promise<boolean>;
};

const digest = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");
const valid = (value: string, max: number) => value.length > 0 && value.length <= max;

/** One-time capability issuer. Only a SHA-256 digest is persisted. */
export const makeSandboxBootstrapTokens = (
  repository: SandboxBootstrapTokenRepository,
  options: {
    readonly now?: () => number;
    readonly randomBytes?: (size: number) => Buffer;
    readonly ttlMs?: number;
  } = {},
) => {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? NodeCrypto.randomBytes;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 10 * 60_000)
    throw new Error("invalid_bootstrap_ttl");
  return {
    issue: async (input: { sandboxId: string; userId: string; clientToken: string }) => {
      if (!valid(input.sandboxId, 64) || !valid(input.userId, 191) || !valid(input.clientToken, 64))
        throw new Error("invalid_bootstrap_binding");
      const token = randomBytes(32).toString("hex");
      const issuedAtMs = now();
      const expiresAtMs = issuedAtMs + ttlMs;
      await repository.insert({
        ...input,
        tokenHash: digest(token),
        expiresAtMs,
        consumedAtMs: null,
      });
      return { token, expiresAtMs };
    },
    consume: async (input: {
      token: string;
      sandboxId: string;
      userId: string;
      clientToken: string;
    }) => {
      if (!/^[a-f0-9]{64}$/i.test(input.token)) return false;
      return repository.consume({ ...input, tokenHash: digest(input.token), nowMs: now() });
    },
  };
};

export type SandboxBootstrapConfig = {
  readonly masterKey: Buffer;
  readonly bootstrapOrigin: string;
  readonly inferenceGatewayUrl: string;
  readonly codexModel: string;
  readonly codexMaxOutputTokens: number;
  readonly codexReserveMicros: number;
  readonly provisionTunnel: (
    sandboxId: string,
  ) => Promise<{ token: string; endpoint: string; tunnelId: string }>;
  readonly retireTunnel: (
    sandboxId: string,
    tunnelId: string,
  ) => Promise<{ retired: boolean; attempts: number }>;
  readonly ttlMs?: number;
  readonly controlTtlMs?: number;
};

export class SandboxBootstrapCredentials extends Context.Service<
  SandboxBootstrapCredentials,
  {
    readonly issue: (input: {
      sandboxId: string;
      userId: string;
      clientToken: string;
    }) => Effect.Effect<{ token: string; bootstrapUrl: string; expiresAt: string }, Error>;
    readonly redeem: (input: {
      token: string;
      sandboxId: string;
      userId: string;
      clientToken: string;
    }) => Effect.Effect<
      { controlSecret: string; environment: string; tunnelToken: string; tunnelEndpoint: string },
      Error
    >;
    readonly authenticate: (
      controlSecret: string,
    ) => Effect.Effect<{ sandboxId: string; userId: string } | null, Error>;
    readonly resolve: (
      sandboxId: string,
    ) => Effect.Effect<
      {
        sandboxId: string;
        userId: string;
        providerRef: string;
        controlSecret: string;
        tunnelEndpoint: string;
      } | null,
      Error
    >;
    readonly revoke: (input: {
      sandboxId: string;
      userId: string;
      reason: "stop" | "hibernate" | "rotate" | "failed";
    }) => Effect.Effect<{ revoked: number; tunnelsRetired: number }, Error>;
    readonly listExpiring: (input: {
      cutoff: string;
      limit: number;
    }) => Effect.Effect<
      ReadonlyArray<{ sandboxId: string; userId: string; providerRef: string }>,
      Error
    >;
  }
>()("salvo/SandboxBootstrapCredentials") {}

export const layerUnavailable = Layer.succeed(
  SandboxBootstrapCredentials,
  SandboxBootstrapCredentials.of({
    issue: () => Effect.fail(new Error("sandbox_bootstrap_not_configured")),
    redeem: () => Effect.fail(new Error("sandbox_bootstrap_not_configured")),
    authenticate: () => Effect.succeed(null),
    resolve: () => Effect.succeed(null),
    revoke: () => Effect.succeed({ revoked: 0, tunnelsRetired: 0 }),
    listExpiring: () => Effect.succeed([]),
  }),
);

const encrypt = (key: Buffer, cleartext: string) => {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(cleartext, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
};
const decrypt = (key: Buffer, value: string) => {
  const parts = value.split(".").map((part) => Buffer.from(part, "base64url"));
  if (parts.length !== 3 || parts[0]!.length !== 12 || parts[1]!.length !== 16)
    throw new Error("invalid_secret_ciphertext");
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, parts[0]!);
  decipher.setAuthTag(parts[1]!);
  return Buffer.concat([decipher.update(parts[2]!), decipher.final()]).toString("utf8");
};

export const layerPostgres = (config: SandboxBootstrapConfig) =>
  Layer.effect(
    SandboxBootstrapCredentials,
    Effect.gen(function* () {
      if (config.masterKey.length !== 32)
        return yield* Effect.fail(new Error("invalid_bootstrap_master_key"));
      const db = yield* RelayDb.RelayDb;
      const ttlMs = config.ttlMs ?? 5 * 60_000;
      const controlTtlMs = config.controlTtlMs ?? 12 * 60 * 60_000;
      if (
        !Number.isSafeInteger(controlTtlMs) ||
        controlTtlMs < 60_000 ||
        controlTtlMs > 24 * 60 * 60_000
      )
        return yield* Effect.fail(new Error("invalid_control_ttl"));
      const revoke = (input: {
        sandboxId: string;
        userId: string;
        reason: "stop" | "hibernate" | "rotate" | "failed";
      }) =>
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const sandbox = (yield* db
            .select({ status: salvoHostedSandboxes.status })
            .from(salvoHostedSandboxes)
            .where(
              and(
                eq(salvoHostedSandboxes.sandboxId, input.sandboxId),
                eq(salvoHostedSandboxes.userId, input.userId),
              ),
            )
            .limit(1))[0];
          if (!sandbox) return yield* Effect.fail(new Error("revoke_sandbox_not_owned"));
          const active = yield* db
            .select({ tokenHash: rows.tokenHash, tunnelId: rows.tunnelId })
            .from(rows)
            .where(
              and(
                eq(rows.sandboxId, input.sandboxId),
                eq(rows.userId, input.userId),
                isNull(rows.revokedAt),
              ),
            );
          if (active.length === 0) return { revoked: 0, tunnelsRetired: 0 };
          yield* db
            .update(rows)
            .set({ revokedAt: now })
            .where(
              inArray(
                rows.tokenHash,
                active.map((row) => row.tokenHash),
              ),
            );
          let tunnelsRetired = 0;
          for (const tunnelId of new Set(active.map((row) => row.tunnelId))) {
            const result = yield* Effect.tryPromise({
              try: () => config.retireTunnel(input.sandboxId, tunnelId),
              catch: (cause) => new Error("sandbox_tunnel_retire_failed", { cause }),
            }).pipe(
              Effect.tapError((cause) =>
                db
                  .insert(salvoSandboxLifecycleHistory)
                  .values({
                    eventId: NodeCrypto.randomUUID(),
                    sandboxId: input.sandboxId,
                    userId: input.userId,
                    event: "control-cleanup-failed",
                    detail: JSON.stringify({
                      reason: input.reason,
                      tunnelId: digest(tunnelId).slice(0, 16),
                      error: cause.message,
                    }),
                    createdAt: now,
                  })
                  .pipe(Effect.ignore),
              ),
            );
            if (result.retired) tunnelsRetired++;
          }
          yield* db
            .insert(salvoSandboxLifecycleHistory)
            .values({
              eventId: NodeCrypto.randomUUID(),
              sandboxId: input.sandboxId,
              userId: input.userId,
              event: "control-revoked",
              detail: JSON.stringify({
                reason: input.reason,
                credentials: active.length,
                tunnelsRetired,
              }),
              createdAt: now,
            });
          return { revoked: active.length, tunnelsRetired };
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof Error ? cause : new Error("bootstrap_revoke_failed"),
          ),
        );
      return SandboxBootstrapCredentials.of({
        issue: (input) =>
          Effect.gen(function* () {
            if (
              !valid(input.sandboxId, 64) ||
              !valid(input.userId, 191) ||
              !valid(input.clientToken, 64)
            )
              return yield* Effect.fail(new Error("invalid_bootstrap_binding"));
            if (input.clientToken !== `salvo-${input.sandboxId}`.slice(0, 64))
              return yield* Effect.fail(new Error("invalid_bootstrap_client_token"));
            const owner = (yield* db
              .select({ userId: salvoHostedSandboxes.userId })
              .from(salvoHostedSandboxes)
              .where(
                and(
                  eq(salvoHostedSandboxes.sandboxId, input.sandboxId),
                  eq(salvoHostedSandboxes.userId, input.userId),
                  inArray(salvoHostedSandboxes.status, ["starting", "ready"]),
                ),
              )
              .limit(1))[0];
            if (!owner)
              return yield* Effect.fail(new Error("bootstrap_sandbox_not_active_or_owned"));
            yield* revoke({ sandboxId: input.sandboxId, userId: input.userId, reason: "rotate" });
            const token = NodeCrypto.randomBytes(32).toString("hex");
            const controlSecret = NodeCrypto.randomBytes(32).toString("base64url");
            const tunnel = yield* Effect.tryPromise({
              try: () => config.provisionTunnel(input.sandboxId),
              catch: () => new Error("sandbox_tunnel_provision_failed"),
            });
            const now = yield* DateTime.now;
            const expiresAt = DateTime.formatIso(DateTime.addDuration(now, ttlMs));
            const controlExpiresAt = DateTime.formatIso(DateTime.addDuration(now, controlTtlMs));
            const generation =
              (yield* db
                .select({ generation: rows.generation })
                .from(rows)
                .where(eq(rows.sandboxId, input.sandboxId))
                .orderBy(desc(rows.generation))
                .limit(1))[0]?.generation ?? 0;
            yield* db
              .insert(rows)
              .values({
                tokenHash: digest(token),
                sandboxId: input.sandboxId,
                userId: input.userId,
                clientToken: input.clientToken,
                secretCiphertext: encrypt(
                  config.masterKey,
                  JSON.stringify({
                    controlSecret,
                    tunnelToken: tunnel.token,
                    tunnelEndpoint: tunnel.endpoint,
                  }),
                ),
                secretHash: digest(controlSecret),
                expiresAt,
                controlExpiresAt,
                consumedAt: null,
                revokedAt: null,
                tunnelId: tunnel.tunnelId,
                generation: generation + 1,
                createdAt: DateTime.formatIso(now),
              });
            return {
              token,
              bootstrapUrl: new URL("/v1/bootstrap/redeem", config.bootstrapOrigin).href,
              expiresAt,
            };
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error("bootstrap_issue_failed"),
            ),
          ),
        redeem: (input) =>
          Effect.gen(function* () {
            if (!/^[a-f0-9]{64}$/i.test(input.token))
              return yield* Effect.fail(new Error("invalid_bootstrap_token"));
            const now = DateTime.formatIso(yield* DateTime.now);
            const activeOwner = (yield* db
              .select({ sandboxId: salvoHostedSandboxes.sandboxId })
              .from(salvoHostedSandboxes)
              .where(
                and(
                  eq(salvoHostedSandboxes.sandboxId, input.sandboxId),
                  eq(salvoHostedSandboxes.userId, input.userId),
                  inArray(salvoHostedSandboxes.status, ["starting", "ready"]),
                ),
              )
              .limit(1))[0];
            if (!activeOwner)
              return yield* Effect.fail(new Error("bootstrap_sandbox_not_active_or_owned"));
            const claimed = yield* db
              .update(rows)
              .set({ consumedAt: now })
              .where(
                and(
                  eq(rows.tokenHash, digest(input.token)),
                  eq(rows.sandboxId, input.sandboxId),
                  eq(rows.userId, input.userId),
                  eq(rows.clientToken, input.clientToken),
                  isNull(rows.consumedAt),
                  isNull(rows.revokedAt),
                  gt(rows.expiresAt, now),
                  gt(rows.controlExpiresAt, now),
                ),
              )
              .returning({ secretCiphertext: rows.secretCiphertext });
            if (claimed.length !== 1)
              return yield* Effect.fail(new Error("bootstrap_token_rejected"));
            const credential = JSON.parse(
              decrypt(config.masterKey, claimed[0]!.secretCiphertext),
            ) as Record<string, unknown>;
            const controlSecret = credential.controlSecret;
            if (
              typeof controlSecret !== "string" ||
              typeof credential.tunnelToken !== "string" ||
              typeof credential.tunnelEndpoint !== "string"
            )
              return yield* Effect.fail(new Error("invalid_bootstrap_credential"));
            const hash = NodeCrypto.createHash("sha256").update(controlSecret).digest("hex");
            const environment =
              [
                "SALVO_SANDBOX_RECEIVER_ENABLED=true",
                `SALVO_SANDBOX_ID=${input.sandboxId}`,
                "SALVO_CONTROL_SECRET_FILE=/etc/salvo/control-secret",
                `SALVO_CONTROL_SECRET_SHA256=${hash}`,
                `SALVO_INFERENCE_GATEWAY_URL=${config.inferenceGatewayUrl}`,
                `SALVO_CODEX_MODEL=${config.codexModel}`,
                `SALVO_CODEX_MAX_OUTPUT_TOKENS=${config.codexMaxOutputTokens}`,
                `SALVO_CODEX_RESERVE_MICROS=${config.codexReserveMicros}`,
                "SALVO_RECEIPT_DATABASE_PATH=/var/lib/salvo/runtime/receipts.sqlite",
              ].join("\n") + "\n";
            return {
              controlSecret,
              environment,
              tunnelToken: credential.tunnelToken,
              tunnelEndpoint: credential.tunnelEndpoint,
            };
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error("bootstrap_redeem_failed"),
            ),
          ),
        authenticate: (controlSecret) =>
          Effect.gen(function* () {
            if (!valid(controlSecret, 256)) return null;
            const now = DateTime.formatIso(yield* DateTime.now);
            const matches = yield* db
              .select({
                sandboxId: rows.sandboxId,
                userId: rows.userId,
                consumedAt: rows.consumedAt,
              })
              .from(rows)
              .innerJoin(
                salvoHostedSandboxes,
                and(
                  eq(salvoHostedSandboxes.sandboxId, rows.sandboxId),
                  eq(salvoHostedSandboxes.userId, rows.userId),
                ),
              )
              .where(
                and(
                  eq(rows.secretHash, digest(controlSecret)),
                  isNull(rows.revokedAt),
                  gt(rows.controlExpiresAt, now),
                  inArray(salvoHostedSandboxes.status, ["starting", "ready"]),
                ),
              )
              .limit(2);
            if (matches.length !== 1 || matches[0]!.consumedAt === null) return null;
            return { sandboxId: matches[0]!.sandboxId, userId: matches[0]!.userId };
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error("bootstrap_authenticate_failed"),
            ),
          ),
        resolve: (sandboxId) =>
          Effect.gen(function* () {
            if (!valid(sandboxId, 64)) return null;
            const sandbox = (yield* db
              .select({
                userId: salvoHostedSandboxes.userId,
                providerRef: salvoHostedSandboxes.providerRef,
              })
              .from(salvoHostedSandboxes)
              .where(
                and(
                  eq(salvoHostedSandboxes.sandboxId, sandboxId),
                  inArray(salvoHostedSandboxes.status, ["starting", "ready"]),
                ),
              )
              .limit(1))[0];
            if (!sandbox?.providerRef) return null;
            const credentialRow = (yield* db
              .select({ secretCiphertext: rows.secretCiphertext })
              .from(rows)
              .where(
                and(
                  eq(rows.sandboxId, sandboxId),
                  eq(rows.userId, sandbox.userId),
                  isNotNull(rows.consumedAt),
                  isNull(rows.revokedAt),
                  gt(rows.controlExpiresAt, DateTime.formatIso(yield* DateTime.now)),
                ),
              )
              .orderBy(desc(rows.createdAt))
              .limit(1))[0];
            if (!credentialRow) return null;
            const credential = JSON.parse(
              decrypt(config.masterKey, credentialRow.secretCiphertext),
            ) as Record<string, unknown>;
            if (
              typeof credential.controlSecret !== "string" ||
              typeof credential.tunnelEndpoint !== "string"
            )
              return null;
            return {
              sandboxId,
              userId: sandbox.userId,
              providerRef: sandbox.providerRef,
              controlSecret: credential.controlSecret,
              tunnelEndpoint: credential.tunnelEndpoint,
            };
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error("bootstrap_resolve_failed"),
            ),
          ),
        revoke,
        listExpiring: (input) =>
          Effect.gen(function* () {
            const found = yield* db
              .select({
                sandboxId: rows.sandboxId,
                userId: rows.userId,
                providerRef: salvoHostedSandboxes.providerRef,
              })
              .from(rows)
              .innerJoin(
                salvoHostedSandboxes,
                and(
                  eq(salvoHostedSandboxes.sandboxId, rows.sandboxId),
                  eq(salvoHostedSandboxes.userId, rows.userId),
                ),
              )
              .where(
                and(
                  isNotNull(rows.consumedAt),
                  isNull(rows.revokedAt),
                  inArray(salvoHostedSandboxes.status, ["ready"]),
                  isNotNull(salvoHostedSandboxes.providerRef),
                  lt(rows.controlExpiresAt, input.cutoff),
                ),
              )
              .orderBy(rows.controlExpiresAt)
              .limit(Math.min(Math.max(input.limit, 1), 100));
            return found.flatMap((row) =>
              row.providerRef
                ? [{ sandboxId: row.sandboxId, userId: row.userId, providerRef: row.providerRef }]
                : [],
            );
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof Error ? cause : new Error("bootstrap_expiry_scan_failed"),
            ),
          ),
      });
    }),
  );
