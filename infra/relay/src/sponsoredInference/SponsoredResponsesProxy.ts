// @effect-diagnostics globalDate:off globalErrorInEffectFailure:off runEffectInsideEffect:off
import * as NodeCrypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RelayDb from "../db.ts";
import { CanaryBudgetAuthority, type CanaryBudgetDenied } from "../canary/CanaryBudgetAuthority.ts";
import {
  salvoSponsoredInferenceControl as control,
  salvoSponsoredInferenceGrants as grants,
  salvoSponsoredInferenceUsers as users,
  salvoSponsoredResponseCalls as calls,
} from "../persistence/schema.ts";

export type ResponsesProxyConfig = {
  readonly apiKey: string;
  readonly upstreamUrl: string;
  readonly allowedModels: ReadonlySet<string>;
  readonly maxOutputTokens: number;
  readonly turnMicros: number;
  readonly userMicros: number;
  readonly pilotMicros: number;
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch;
};
export const MAX_RESPONSES_REQUEST_BYTES = 1_100_000;
export const MAX_RESPONSES_CAPTURE_BYTES = 4_000_000;
const MAX_JSON_DEPTH = 32;
const RUNNING_LEASE_MS = 130_000;
const allowedTopLevel = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "prompt_cache_key",
  "previous_response_id",
  "text",
  "metadata",
  "temperature",
  "top_p",
  "truncation",
  "user",
  "max_output_tokens",
  "service_tier",
  "safety_identifier",
  "background",
]);
export class SponsoredResponsesProxyError extends Error {
  readonly code:
    | "invalid_request"
    | "invalid_grant"
    | "grant_expired"
    | "grant_revoked"
    | "global_stop"
    | "budget_denied"
    | "request_in_progress"
    | "conflicting_replay"
    | "upstream_failed"
    | "usage_missing"
    | "persistence_failed";
  constructor(code: SponsoredResponsesProxyError["code"]) {
    super(code);
    this.code = code;
  }
}
export class SponsoredResponsesProxyConfig extends Context.Service<
  SponsoredResponsesProxyConfig,
  ResponsesProxyConfig
>()("t3code-relay/sponsoredInference/SponsoredResponsesProxy/SponsoredResponsesProxyConfig") {}
export class SponsoredResponsesProxy extends Context.Service<
  SponsoredResponsesProxy,
  {
    readonly execute: (input: {
      userId: string;
      sandboxId: string;
      parentRequestId: string;
      grantToken: string;
      body: unknown;
    }) => Effect.Effect<Response, SponsoredResponsesProxyError>;
  }
>()("t3code-relay/sponsoredInference/SponsoredResponsesProxy") {}

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
          .join(",")}}`
      : JSON.stringify(value);
const rows = <T>(value: unknown): ReadonlyArray<T> =>
  Array.isArray(value)
    ? (value as ReadonlyArray<T>)
    : ((value as { rows?: ReadonlyArray<T> }).rows ?? []);
const failure = (code: SponsoredResponsesProxyError["code"]) =>
  Effect.fail(new SponsoredResponsesProxyError(code));
const boundedJson = (value: unknown, depth = 0): boolean => {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.length <= 10_000 && value.every((item) => boundedJson(item, depth + 1));
  return (
    typeof value === "object" &&
    Object.keys(value).length <= 1_000 &&
    Object.values(value as Record<string, unknown>).every((item) => boundedJson(item, depth + 1))
  );
};
const usageFromSse = (bytes: Uint8Array) => {
  const text = new TextDecoder().decode(bytes);
  let usage: { input_tokens: number; output_tokens: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      const response = event.response as Record<string, unknown> | undefined;
      const candidate = response?.usage as Record<string, unknown> | undefined;
      if (
        (event.type === "response.completed" || event.type === "response.done") &&
        Number.isSafeInteger(candidate?.input_tokens) &&
        Number.isSafeInteger(candidate?.output_tokens)
      )
        usage = candidate as { input_tokens: number; output_tokens: number };
    } catch {
      /* Non-JSON SSE fields pass through unchanged. */
    }
  }
  return usage;
};

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const transactions = yield* RelayDb.RelayTransactions;
  const config = yield* SponsoredResponsesProxyConfig;
  const runtimeContext = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(runtimeContext);
  const canaryBudget = yield* CanaryBudgetAuthority;
  const transactionDb = PgDrizzle.makeWithDefaults().pipe(
    Effect.provideService(PgClient.PgClient, db.$client),
  );
  const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const maximumBill = Math.ceil(
    (MAX_RESPONSES_REQUEST_BYTES * config.inputMicrosPerMillionTokens +
      config.maxOutputTokens * config.outputMicrosPerMillionTokens) /
      1_000_000,
  );
  if (maximumBill > config.turnMicros)
    return yield* Effect.die(new Error("salvo_turn_reserve_cannot_cover_worst_case"));
  const persist = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        Object.assign(new SponsoredResponsesProxyError("persistence_failed"), { cause }),
      ),
    );
  const canary = <A, R>(effect: Effect.Effect<A, CanaryBudgetDenied, R>) =>
    effect.pipe(Effect.mapError(() => new SponsoredResponsesProxyError("budget_denied")));
  const settle = (
    input: { callId: string; userId: string; reserve: number; leaseExpiresAt: string },
    completed: { billed: number; bytes: Uint8Array; contentType: string } | null,
  ) =>
    transactions
      .withTransaction(
        Effect.gen(function* () {
          const tx = yield* transactionDb;
          const now = yield* timestamp;
          const changed = yield* tx
            .update(calls)
            .set(
              completed
                ? {
                    status: "completed",
                    billedMicros: completed.billed,
                    responseBase64: Buffer.from(completed.bytes).toString("base64"),
                    responseContentType: completed.contentType,
                    updatedAt: now,
                  }
                : { status: "failed", updatedAt: now },
            )
            .where(
              and(
                eq(calls.callId, input.callId),
                eq(calls.status, "running"),
                eq(calls.leaseExpiresAt, input.leaseExpiresAt),
              ),
            )
            .returning({ callId: calls.callId });
          if (!changed.length) return;
          yield* tx
            .update(users)
            .set({
              reservedMicros: sql`${users.reservedMicros} - ${input.reserve}`,
              ...(completed
                ? { billedMicros: sql`${users.billedMicros} + ${completed.billed}` }
                : {}),
              updatedAt: now,
            })
            .where(eq(users.userId, input.userId));
          yield* tx
            .update(control)
            .set({
              reservedMicros: sql`${control.reservedMicros} - ${input.reserve}`,
              ...(completed
                ? { billedMicros: sql`${control.billedMicros} + ${completed.billed}` }
                : {}),
              updatedAt: now,
            })
            .where(eq(control.singleton, 1));
        }),
      )
      .pipe(persist);
  return SponsoredResponsesProxy.of({
    execute: (input) =>
      Effect.gen(function* () {
        if (
          !input.parentRequestId ||
          input.parentRequestId.length > 191 ||
          !input.userId ||
          !input.sandboxId ||
          !input.body ||
          typeof input.body !== "object" ||
          !boundedJson(input.body)
        )
          return yield* failure("invalid_request");
        const supplied = input.body as Record<string, unknown>;
        const model = supplied.model;
        if (
          Object.keys(supplied).some((key) => !allowedTopLevel.has(key)) ||
          typeof model !== "string" ||
          !config.allowedModels.has(model) ||
          supplied.stream !== true
        )
          return yield* failure("invalid_request");
        const body = {
          ...supplied,
          model,
          stream: true,
          max_output_tokens: config.maxOutputTokens,
        };
        const serialized = stable(body);
        if (Buffer.byteLength(serialized) > MAX_RESPONSES_REQUEST_BYTES)
          return yield* failure("invalid_request");
        const fingerprint = digest(serialized);
        const callId = digest(`${input.parentRequestId}:${fingerprint}`);
        const reserve = maximumBill;
        const claim = yield* transactions
          .withTransaction(
            Effect.gen(function* () {
              const tx = yield* transactionDb;
              const state = rows<{
                stopped: boolean;
                reserved_micros: number;
                billed_micros: number;
              }>(
                yield* tx.execute(
                  sql`select * from salvo_sponsored_inference_control where singleton = 1 for update`,
                ),
              )[0];
              if (!state || state.stopped) return { kind: "error", code: "global_stop" } as const;
              const tokenHash = digest(input.grantToken);
              const grant = (yield* tx
                .select()
                .from(grants)
                .where(eq(grants.tokenHash, tokenHash))
                .limit(1))[0];
              if (!grant || grant.userId !== input.userId || grant.sandboxId !== input.sandboxId)
                return { kind: "error", code: "invalid_grant" } as const;
              if (grant.revokedAt) return { kind: "error", code: "grant_revoked" } as const;
              if (grant.expiresAt <= (yield* timestamp))
                return { kind: "error", code: "grant_expired" } as const;
              const prior = (yield* tx
                .select()
                .from(calls)
                .where(eq(calls.callId, callId))
                .limit(1))[0];
              if (prior) {
                if (
                  prior.fingerprint !== fingerprint ||
                  prior.userId !== input.userId ||
                  prior.sandboxId !== input.sandboxId
                )
                  return { kind: "error", code: "conflicting_replay" } as const;
                if (
                  prior.status === "completed" &&
                  prior.responseBase64 &&
                  prior.responseContentType
                )
                  return { kind: "replay", row: prior } as const;
                const now = yield* timestamp;
                if (
                  prior.status === "running" &&
                  prior.leaseExpiresAt &&
                  prior.leaseExpiresAt > now
                )
                  return { kind: "error", code: "request_in_progress" } as const;
                if (prior.status === "running") {
                  yield* tx
                    .update(users)
                    .set({
                      reservedMicros: sql`greatest(0, ${users.reservedMicros} - ${prior.reservedMicros})`,
                      updatedAt: now,
                    })
                    .where(eq(users.userId, prior.userId));
                  yield* tx
                    .update(control)
                    .set({
                      reservedMicros: sql`greatest(0, ${control.reservedMicros} - ${prior.reservedMicros})`,
                      updatedAt: now,
                    })
                    .where(eq(control.singleton, 1));
                }
                yield* tx.delete(calls).where(eq(calls.callId, callId));
              }
              yield* tx
                .insert(users)
                .values({
                  userId: input.userId,
                  reservedMicros: 0,
                  billedMicros: 0,
                  updatedAt: yield* timestamp,
                })
                .onConflictDoNothing({ target: users.userId });
              const user = rows<{ reserved_micros: number; billed_micros: number }>(
                yield* tx.execute(
                  sql`select * from salvo_sponsored_inference_users where user_id = ${input.userId} for update`,
                ),
              )[0]!;
              if (
                reserve > config.turnMicros ||
                user.reserved_micros + user.billed_micros + reserve > config.userMicros ||
                state.reserved_micros + state.billed_micros + reserve > config.pilotMicros
              )
                return { kind: "error", code: "budget_denied" } as const;
              const now = yield* timestamp;
              const leaseExpiresAt = DateTime.formatIso(
                DateTime.addDuration(yield* DateTime.now, RUNNING_LEASE_MS),
              );
              yield* tx
                .insert(calls)
                .values({
                  callId,
                  parentRequestId: input.parentRequestId,
                  userId: input.userId,
                  sandboxId: input.sandboxId,
                  fingerprint,
                  status: "running",
                  reservedMicros: reserve,
                  billedMicros: null,
                  responseBase64: null,
                  responseContentType: null,
                  leaseExpiresAt,
                  createdAt: now,
                  updatedAt: now,
                });
              yield* tx
                .update(users)
                .set({ reservedMicros: sql`${users.reservedMicros} + ${reserve}`, updatedAt: now })
                .where(eq(users.userId, input.userId));
              yield* tx
                .update(control)
                .set({
                  reservedMicros: sql`${control.reservedMicros} + ${reserve}`,
                  updatedAt: now,
                })
                .where(eq(control.singleton, 1));
              return { kind: "claimed", leaseExpiresAt } as const;
            }),
          )
          .pipe(persist);
        if (claim.kind === "error") return yield* failure(claim.code);
        if (claim.kind === "replay")
          return new Response(Buffer.from(claim.row.responseBase64!, "base64"), {
            status: 200,
            headers: {
              "content-type": claim.row.responseContentType!,
              "cache-control": "no-store",
              "x-salvo-replayed": "true",
            },
          });
        const settlement = {
          callId,
          userId: input.userId,
          reserve,
          leaseExpiresAt: claim.leaseExpiresAt,
        };
        const canaryReservationId = `openai:${callId}`;
        const canaryReserved = yield* canary(
          canaryBudget.reserve({
            reservationId: canaryReservationId,
            kind: "openai",
            userId: input.userId,
            fingerprint,
            micros: reserve,
          }),
        ).pipe(Effect.result);
        if (canaryReserved._tag === "Failure") {
          yield* settle(settlement, null);
          return yield* failure("budget_denied");
        }
        const attempted = yield* Effect.tryPromise({
          try: () =>
            config.fetch(config.upstreamUrl, {
              method: "POST",
              signal: AbortSignal.timeout(config.timeoutMs),
              headers: {
                authorization: `Bearer ${config.apiKey}`,
                "content-type": "application/json",
                accept: "text/event-stream",
              },
              body: serialized,
            }),
          catch: () => new SponsoredResponsesProxyError("upstream_failed"),
        }).pipe(Effect.option);
        if (attempted._tag === "None") {
          yield* Effect.all([
            settle(settlement, null),
            canary(canaryBudget.release(canaryReservationId)),
          ]);
          return yield* failure("upstream_failed");
        }
        const upstream = attempted.value;
        if (!upstream.ok || !upstream.body) {
          yield* Effect.all([
            settle(settlement, null),
            canary(canaryBudget.release(canaryReservationId)),
          ]);
          return yield* failure("upstream_failed");
        }
        const contentType = upstream.headers.get("content-type") ?? "text/event-stream";
        if (!contentType.toLowerCase().startsWith("text/event-stream")) {
          yield* Effect.all([
            settle(settlement, null),
            canary(canaryBudget.release(canaryReservationId)),
          ]);
          return yield* failure("upstream_failed");
        }
        const reader = upstream.body.getReader();
        const captured: Uint8Array[] = [];
        let capturedBytes = 0;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const item = await reader.read();
              if (!item.done) {
                capturedBytes += item.value.length;
                if (capturedBytes > MAX_RESPONSES_CAPTURE_BYTES) {
                  await reader.cancel();
                  await run(
                    Effect.all([
                      settle(settlement, null),
                      canary(canaryBudget.release(canaryReservationId)),
                    ]),
                  );
                  controller.error(new Error("responses_stream_too_large"));
                  return;
                }
                captured.push(item.value);
                controller.enqueue(item.value);
                return;
              }
              const length = captured.reduce((sum, chunk) => sum + chunk.length, 0);
              const all = new Uint8Array(length);
              let offset = 0;
              for (const chunk of captured) {
                all.set(chunk, offset);
                offset += chunk.length;
              }
              const usage = usageFromSse(all);
              if (!usage)
                await run(
                  Effect.all([
                    settle(settlement, null),
                    canary(canaryBudget.release(canaryReservationId)),
                  ]),
                );
              else {
                const billed = Math.ceil(
                  (usage.input_tokens * config.inputMicrosPerMillionTokens +
                    usage.output_tokens * config.outputMicrosPerMillionTokens) /
                    1_000_000,
                );
                if (billed <= reserve)
                  await run(
                    Effect.all([
                      settle(settlement, { billed, bytes: all, contentType }),
                      canary(
                        canaryBudget.settle({
                          reservationId: canaryReservationId,
                          actualMicros: billed,
                        }),
                      ),
                    ]),
                  );
                else
                  await run(
                    Effect.all([
                      settle(settlement, null),
                      canary(canaryBudget.release(canaryReservationId)),
                    ]),
                  );
              }
              controller.close();
            } catch (error) {
              await run(
                Effect.all([
                  settle(settlement, null),
                  canary(canaryBudget.release(canaryReservationId)),
                ]),
              );
              controller.error(error);
            }
          },
          async cancel() {
            await reader.cancel();
            await run(
              Effect.all([
                settle(settlement, null),
                canary(canaryBudget.release(canaryReservationId)),
              ]),
            );
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": contentType, "cache-control": "no-store" },
        });
      }),
  });
});
export const layer = Layer.effect(SponsoredResponsesProxy, make);
export const layerUnavailable = Layer.succeed(
  SponsoredResponsesProxy,
  SponsoredResponsesProxy.of({ execute: () => failure("upstream_failed") }),
);
