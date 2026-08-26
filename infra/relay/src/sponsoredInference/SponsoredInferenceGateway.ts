import { and, eq, sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import {
  salvoSponsoredInferenceAudits as audits,
  salvoSponsoredInferenceControl as control,
  salvoSponsoredInferenceGrants as grants,
  salvoSponsoredInferenceRequests as requests,
  salvoSponsoredInferenceUsers as users,
} from "../persistence/schema.ts";
import { CanaryBudgetAuthority } from "../canary/CanaryBudgetAuthority.ts";

export type SponsoredInferenceCaps = {
  readonly pilotMicros: number;
  readonly userMicros: number;
  readonly turnMicros: number;
};
export class SponsoredInferenceProviderError extends Schema.TaggedErrorClass<SponsoredInferenceProviderError>()(
  "SponsoredInferenceProviderError",
  { cause: Schema.Defect() },
) {}
export type SponsoredInferenceProvider = {
  readonly execute: (input: {
    readonly idempotencyKey: string;
    readonly model: string;
    readonly prompt: string;
    readonly maxOutputTokens: number;
  }) => Effect.Effect<
    { readonly text: string; readonly billedMicros: number },
    SponsoredInferenceProviderError
  >;
};
export class SponsoredInferenceUnavailable extends Schema.TaggedErrorClass<SponsoredInferenceUnavailable>()(
  "SponsoredInferenceUnavailable",
  {
    code: Schema.Literals([
      "invalid_request",
      "invalid_grant",
      "grant_expired",
      "grant_revoked",
      "global_stop",
      "budget_denied",
      "provider_failed",
      "provider_over_budget",
      "request_in_progress",
      "conflicting_replay",
      "not_configured",
      "persistence_failed",
    ]),
  },
) {}
export { SponsoredInferenceUnavailable as SponsoredInferenceError };
export type SponsoredInferenceGrant = {
  readonly token: string;
  readonly grantId?: string;
  readonly userId: string;
  readonly sandboxId: string;
  readonly expiresAt?: string;
  readonly expiresAtMs?: number;
};
export type SponsoredInferenceRequest = {
  readonly grant: SponsoredInferenceGrant;
  readonly userId: string;
  readonly sandboxId: string;
  readonly requestId: string;
  readonly turnId?: string;
  readonly model?: string;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
  readonly reserveMicros?: number;
};
export type SponsoredInferenceResponse = {
  readonly requestId: string;
  readonly text?: string;
  readonly billedMicros?: number;
  readonly replayed?: boolean;
  readonly providerReceiptId?: string;
  readonly acceptedAt?: string;
};
export class SponsoredInferenceRuntimeConfig extends Context.Service<
  SponsoredInferenceRuntimeConfig,
  {
    readonly provider: SponsoredInferenceProvider;
    readonly caps: SponsoredInferenceCaps;
    readonly allowedModels: ReadonlySet<string>;
    readonly grantTtlMs: number;
  }
>()("t3code-relay/sponsoredInference/SponsoredInferenceGateway/SponsoredInferenceRuntimeConfig") {}
export class SponsoredInferenceGateway extends Context.Service<
  SponsoredInferenceGateway,
  {
    readonly issueGrant: (input: {
      readonly userId: string;
      readonly sandboxId: string;
      readonly ttlMs?: number;
    }) => Effect.Effect<SponsoredInferenceGrant, SponsoredInferenceUnavailable>;
    readonly execute: (
      input: SponsoredInferenceRequest,
    ) => Effect.Effect<SponsoredInferenceResponse, SponsoredInferenceUnavailable>;
    readonly revoke?: (grantId: string) => Effect.Effect<void, SponsoredInferenceUnavailable>;
    readonly setGlobalStop?: (
      stopped: boolean,
    ) => Effect.Effect<void, SponsoredInferenceUnavailable>;
  }
>()("t3code-relay/sponsoredInference/SponsoredInferenceGateway") {}

const failure = (code: SponsoredInferenceUnavailable["code"]) =>
  Effect.fail(new SponsoredInferenceUnavailable({ code }));
const validId = (value: string) => value.length > 0 && value.length <= 191;
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const rawRows = <T>(result: unknown): ReadonlyArray<T> =>
  Array.isArray(result)
    ? (result as ReadonlyArray<T>)
    : ((result as { readonly rows?: ReadonlyArray<T> }).rows ?? []);

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const transactions = yield* RelayDb.RelayTransactions;
  const config = yield* SponsoredInferenceRuntimeConfig;
  const crypto = yield* Crypto.Crypto;
  const canaryBudget = yield* CanaryBudgetAuthority;
  const persist = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(() => new SponsoredInferenceUnavailable({ code: "persistence_failed" })),
    );
  const currentTransactionDb = PgDrizzle.makeWithDefaults().pipe(
    Effect.provideService(PgClient.PgClient, db.$client),
  );
  const cryptoFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(() => new SponsoredInferenceUnavailable({ code: "persistence_failed" })),
    );
  const digest = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.map(hex), cryptoFailure);
  const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const audit = (
    input: Required<SponsoredInferenceRequest>,
    eventType: "accepted" | "completed" | "rejected" | "failed",
    reason?: string,
  ) =>
    Effect.gen(function* () {
      yield* db
        .insert(audits)
        .values({
          auditId: yield* crypto.randomUUIDv4.pipe(cryptoFailure),
          requestId: input.requestId.slice(0, 191),
          userId: input.userId.slice(0, 191),
          eventType,
          reason,
          detailsJson: {
            sandboxId: input.sandboxId,
            turnId: input.turnId,
            model: input.model,
            maxOutputTokens: input.maxOutputTokens,
            reserveMicros: input.reserveMicros,
          },
          createdAt: yield* timestamp,
        });
    }).pipe(persist);
  const release = (input: Required<SponsoredInferenceRequest>) =>
    transactions
      .withTransaction(
        Effect.gen(function* () {
          const transactionDb = yield* currentTransactionDb;
          const updatedAt = yield* timestamp;
          const changed = yield* transactionDb
            .update(requests)
            .set({ status: "failed", updatedAt })
            .where(and(eq(requests.requestId, input.requestId), eq(requests.status, "running")))
            .returning({ requestId: requests.requestId });
          if (changed.length === 0) return;
          yield* transactionDb
            .update(users)
            .set({
              reservedMicros: sql`${users.reservedMicros} - ${input.reserveMicros}`,
              updatedAt,
            })
            .where(eq(users.userId, input.userId));
          yield* transactionDb
            .update(control)
            .set({
              reservedMicros: sql`${control.reservedMicros} - ${input.reserveMicros}`,
              updatedAt,
            })
            .where(eq(control.singleton, 1));
        }),
      )
      .pipe(persist);
  return SponsoredInferenceGateway.of({
    issueGrant: Effect.fn("salvo.sponsored.issue_grant")(function* (input) {
      const ttl = input.ttlMs ?? config.grantTtlMs;
      if (
        !validId(input.userId) ||
        !validId(input.sandboxId) ||
        !Number.isSafeInteger(ttl) ||
        ttl <= 0 ||
        ttl > config.grantTtlMs
      )
        return yield* failure("invalid_request");
      const token = hex(yield* crypto.randomBytes(32).pipe(cryptoFailure));
      const grantId = yield* crypto.randomUUIDv4.pipe(cryptoFailure);
      const current = yield* DateTime.now;
      const expiresAtMs = current.epochMilliseconds + ttl;
      const expiresAt = DateTime.formatIso(DateTime.addDuration(current, ttl));
      yield* db
        .insert(grants)
        .values({
          grantId,
          tokenHash: yield* digest(token),
          userId: input.userId,
          sandboxId: input.sandboxId,
          expiresAt,
          revokedAt: null,
          createdAt: DateTime.formatIso(current),
        })
        .pipe(persist);
      return {
        token,
        grantId,
        userId: input.userId,
        sandboxId: input.sandboxId,
        expiresAt,
        expiresAtMs,
      };
    }),
    execute: Effect.fn("salvo.sponsored.execute")(function* (rawInput) {
      const input = {
        ...rawInput,
        grant: rawInput.grant,
        turnId: rawInput.turnId ?? rawInput.requestId,
        model: rawInput.model ?? "salvo-default",
        maxOutputTokens: rawInput.maxOutputTokens ?? 4096,
        reserveMicros: rawInput.reserveMicros ?? config.caps.turnMicros,
      } satisfies Required<SponsoredInferenceRequest>;
      if (
        !validId(input.userId) ||
        !validId(input.sandboxId) ||
        !validId(input.requestId) ||
        !validId(input.turnId) ||
        !config.allowedModels.has(input.model) ||
        input.prompt.length === 0 ||
        input.prompt.length > 1_000_000 ||
        !Number.isSafeInteger(input.maxOutputTokens) ||
        input.maxOutputTokens <= 0 ||
        input.maxOutputTokens > 100_000 ||
        !Number.isSafeInteger(input.reserveMicros) ||
        input.reserveMicros <= 0
      )
        return yield* failure("invalid_request");
      const tokenHash = yield* digest(input.grant.token);
      const fingerprint = yield* digest(
        [
          input.userId,
          input.sandboxId,
          input.turnId,
          input.model,
          input.prompt,
          `${input.maxOutputTokens}`,
          `${input.reserveMicros}`,
        ]
          .map((part) => `${part.length}:${part}`)
          .join(""),
      );
      const claim = yield* transactions
        .withTransaction(
          Effect.gen(function* () {
            const transactionDb = yield* currentTransactionDb;
            const c = rawRows<{ stopped: boolean; reserved_micros: number; billed_micros: number }>(
              yield* transactionDb.execute(
                sql`select * from salvo_sponsored_inference_control where singleton = 1 for update`,
              ),
            )[0];
            if (!c || c.stopped) return { kind: "error", code: "global_stop" } as const;
            const grant = (yield* transactionDb
              .select()
              .from(grants)
              .where(eq(grants.tokenHash, tokenHash))
              .limit(1))[0];
            if (!grant || grant.userId !== input.userId || grant.sandboxId !== input.sandboxId)
              return { kind: "error", code: "invalid_grant" } as const;
            if (grant.revokedAt) return { kind: "error", code: "grant_revoked" } as const;
            if (grant.expiresAt <= (yield* timestamp))
              return { kind: "error", code: "grant_expired" } as const;
            const prior = (yield* transactionDb
              .select()
              .from(requests)
              .where(eq(requests.requestId, input.requestId))
              .limit(1))[0];
            if (prior) {
              if (prior.userId !== input.userId || prior.fingerprint !== fingerprint)
                return { kind: "error", code: "conflicting_replay" } as const;
              if (prior.status === "completed") return { kind: "replay", row: prior } as const;
              if (prior.status === "failed")
                return { kind: "error", code: "provider_failed" } as const;
              return { kind: "error", code: "request_in_progress" } as const;
            }
            if (input.reserveMicros > config.caps.turnMicros)
              return { kind: "error", code: "budget_denied" } as const;
            yield* transactionDb
              .insert(users)
              .values({
                userId: input.userId,
                reservedMicros: 0,
                billedMicros: 0,
                updatedAt: yield* timestamp,
              })
              .onConflictDoNothing({ target: users.userId });
            const u = rawRows<{ reserved_micros: number; billed_micros: number }>(
              yield* transactionDb.execute(
                sql`select * from salvo_sponsored_inference_users where user_id = ${input.userId} for update`,
              ),
            )[0]!;
            if (
              u.reserved_micros + u.billed_micros + input.reserveMicros > config.caps.userMicros ||
              c.reserved_micros + c.billed_micros + input.reserveMicros > config.caps.pilotMicros
            )
              return { kind: "error", code: "budget_denied" } as const;
            const createdAt = yield* timestamp;
            yield* transactionDb
              .insert(requests)
              .values({
                requestId: input.requestId,
                userId: input.userId,
                sandboxId: input.sandboxId,
                turnId: input.turnId,
                model: input.model,
                fingerprint,
                status: "running",
                reservedMicros: input.reserveMicros,
                billedMicros: null,
                responseText: null,
                createdAt,
                updatedAt: createdAt,
              });
            yield* transactionDb
              .update(users)
              .set({
                reservedMicros: sql`${users.reservedMicros} + ${input.reserveMicros}`,
                updatedAt: createdAt,
              })
              .where(eq(users.userId, input.userId));
            yield* transactionDb
              .update(control)
              .set({
                reservedMicros: sql`${control.reservedMicros} + ${input.reserveMicros}`,
                updatedAt: createdAt,
              })
              .where(eq(control.singleton, 1));
            return { kind: "claimed" } as const;
          }),
        )
        .pipe(persist);
      if (claim.kind === "error") {
        yield* audit(input, "rejected", claim.code);
        return yield* failure(claim.code);
      }
      if (claim.kind === "replay")
        return {
          requestId: input.requestId,
          text: claim.row.responseText!,
          billedMicros: claim.row.billedMicros!,
          replayed: true,
          providerReceiptId: input.requestId,
          acceptedAt: claim.row.updatedAt,
        };
      const canaryReservationId = `openai:${(yield* digest(input.requestId)).slice(0, 64)}`;
      const canaryClaim = yield* canaryBudget
        .reserve({
          reservationId: canaryReservationId,
          kind: "openai",
          userId: input.userId,
          fingerprint,
          micros: input.reserveMicros,
        })
        .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      if (!canaryClaim) {
        yield* release(input);
        yield* audit(input, "rejected", "budget_denied");
        return yield* failure("budget_denied");
      }
      yield* audit(input, "accepted");
      const providerResult = yield* config.provider
        .execute({
          idempotencyKey: input.requestId,
          model: input.model,
          prompt: input.prompt,
          maxOutputTokens: input.maxOutputTokens,
        })
        .pipe(Effect.match({ onFailure: () => null, onSuccess: (value) => value }));
      if (providerResult === null) {
        yield* Effect.all([
          release(input),
          canaryBudget
            .release(canaryReservationId)
            .pipe(
              Effect.mapError(
                () => new SponsoredInferenceUnavailable({ code: "persistence_failed" }),
              ),
            ),
        ]);
        yield* audit(input, "failed", "provider_failed");
        return yield* failure("provider_failed");
      }
      const result = providerResult;
      if (
        typeof result.text !== "string" ||
        result.text.length > 4_000_000 ||
        !Number.isSafeInteger(result.billedMicros) ||
        result.billedMicros < 0 ||
        result.billedMicros > input.reserveMicros
      ) {
        yield* Effect.all([
          release(input),
          canaryBudget
            .release(canaryReservationId)
            .pipe(
              Effect.mapError(
                () => new SponsoredInferenceUnavailable({ code: "persistence_failed" }),
              ),
            ),
        ]);
        yield* audit(input, "failed", "provider_over_budget");
        return yield* failure("provider_over_budget");
      }
      yield* transactions
        .withTransaction(
          Effect.gen(function* () {
            const transactionDb = yield* currentTransactionDb;
            const updatedAt = yield* timestamp;
            yield* transactionDb
              .update(requests)
              .set({
                status: "completed",
                responseText: result.text,
                billedMicros: result.billedMicros,
                updatedAt,
              })
              .where(and(eq(requests.requestId, input.requestId), eq(requests.status, "running")));
            yield* transactionDb
              .update(users)
              .set({
                reservedMicros: sql`${users.reservedMicros} - ${input.reserveMicros}`,
                billedMicros: sql`${users.billedMicros} + ${result.billedMicros}`,
                updatedAt,
              })
              .where(eq(users.userId, input.userId));
            yield* transactionDb
              .update(control)
              .set({
                reservedMicros: sql`${control.reservedMicros} - ${input.reserveMicros}`,
                billedMicros: sql`${control.billedMicros} + ${result.billedMicros}`,
                updatedAt,
              })
              .where(eq(control.singleton, 1));
          }),
        )
        .pipe(persist);
      yield* canaryBudget
        .settle({ reservationId: canaryReservationId, actualMicros: result.billedMicros })
        .pipe(
          Effect.mapError(() => new SponsoredInferenceUnavailable({ code: "persistence_failed" })),
        );
      yield* audit(input, "completed");
      return {
        requestId: input.requestId,
        text: result.text,
        billedMicros: result.billedMicros,
        replayed: false,
        providerReceiptId: input.requestId,
        acceptedAt: yield* timestamp,
      };
    }),
    revoke: (grantId) =>
      timestamp.pipe(
        Effect.flatMap((revokedAt) =>
          db.update(grants).set({ revokedAt }).where(eq(grants.grantId, grantId)),
        ),
        persist,
        Effect.asVoid,
      ),
    setGlobalStop: (stopped) =>
      timestamp.pipe(
        Effect.flatMap((updatedAt) =>
          db.update(control).set({ stopped, updatedAt }).where(eq(control.singleton, 1)),
        ),
        persist,
        Effect.asVoid,
      ),
  });
});
export const layer = Layer.effect(SponsoredInferenceGateway, make);
export const layerUnavailable = Layer.succeed(
  SponsoredInferenceGateway,
  SponsoredInferenceGateway.of({
    issueGrant: () => failure("not_configured"),
    execute: () => failure("not_configured"),
    revoke: () => failure("not_configured"),
    setGlobalStop: () => failure("not_configured"),
  }),
);

/** Small compatibility harness. Durable behavior is exercised through `layer`; this never ships. */
export function makeInMemory(options: {
  readonly provider: {
    readonly execute: (input: {
      readonly userId: string;
      readonly sandboxId: string;
      readonly requestId: string;
      readonly prompt: string;
    }) => Effect.Effect<{
      readonly requestId: string;
      readonly providerReceiptId: string;
      readonly acceptedAt: string;
    }>;
  };
  readonly nowMs: () => number;
  readonly token: () => string;
  readonly ttlMs?: number;
}) {
  const issued = new Map<string, SponsoredInferenceGrant>();
  const revoked = new Set<string>();
  let stopped = false;
  const service = SponsoredInferenceGateway.of({
    issueGrant: ({ userId, sandboxId }) =>
      Effect.sync(() => {
        const token = options.token();
        const grant = {
          token,
          grantId: token,
          userId,
          sandboxId,
          expiresAtMs: options.nowMs() + (options.ttlMs ?? 60_000),
        };
        issued.set(token, grant);
        return grant;
      }),
    execute: (input) => {
      const grant = input.grant;
      if (
        !grant ||
        stopped ||
        revoked.has(grant.token) ||
        grant.userId !== input.userId ||
        grant.sandboxId !== input.sandboxId ||
        (grant.expiresAtMs ?? 0) <= options.nowMs()
      )
        return failure("invalid_grant");
      return options.provider.execute({
        userId: input.userId,
        sandboxId: input.sandboxId,
        requestId: input.requestId,
        prompt: input.prompt,
      });
    },
    revoke: (grantId) =>
      Effect.sync(() => {
        revoked.add(grantId);
      }),
    setGlobalStop: (value) =>
      Effect.sync(() => {
        stopped = value;
      }),
  });
  return {
    service,
    revoke: (token: string) => revoked.add(token),
    setGlobalStop: (value: boolean) => {
      stopped = value;
    },
  };
}
