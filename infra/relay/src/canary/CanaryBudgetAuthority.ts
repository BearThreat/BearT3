// @effect-diagnostics globalDate:off -- In-memory test model emits an ISO timestamp from its injected clock.
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { eq, sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as PgClient from "@effect/sql-pg/PgClient";

import * as RelayDb from "../db.ts";
import {
  salvoCanaryBudgetControl as control,
  salvoCanaryBudgetReservations as reservations,
} from "../persistence/schema.ts";

export const COMBINED_CANARY_CAP_MICROS = 10_000_000;

export type CanaryLiabilityKind = "aws" | "openai";
export type AuthoritativeLiabilityReading = {
  readonly provider: CanaryLiabilityKind;
  readonly billedMicros: number;
  readonly observedAtMs: number;
  readonly source: string;
};

export class AuthoritativeLiabilityReader extends Context.Service<
  AuthoritativeLiabilityReader,
  {
    readonly read: () => Effect.Effect<
      readonly [AuthoritativeLiabilityReading, AuthoritativeLiabilityReading],
      CanaryBudgetDenied
    >;
  }
>()("t3code-relay/canary/CanaryBudgetAuthority/AuthoritativeLiabilityReader") {}

export class CanaryBudgetDenied extends Schema.TaggedErrorClass<CanaryBudgetDenied>()(
  "CanaryBudgetDenied",
  {
    code: Schema.Literals([
      "stopped",
      "invalid",
      "non_operator",
      "conflicting_replay",
      "cap_exceeded",
      "authoritative_unavailable",
      "authoritative_stale",
      "persistence_failed",
    ]),
  },
) {}

export type CanaryBudgetReservation = {
  readonly reservationId: string;
  readonly kind: CanaryLiabilityKind;
  readonly userId: string;
  readonly reservedMicros: number;
  readonly replayed: boolean;
};

export type CanaryBudgetStatus = {
  readonly stopped: boolean;
  readonly capMicros: number;
  readonly reservedMicros: number;
  readonly authoritativeBilledMicros: number;
  readonly authoritativeObservedAt: string | null;
};

export class CanaryBudgetAuthority extends Context.Service<
  CanaryBudgetAuthority,
  {
    readonly reserve: (input: {
      reservationId: string;
      kind: CanaryLiabilityKind;
      userId: string;
      fingerprint: string;
      micros: number;
    }) => Effect.Effect<CanaryBudgetReservation, CanaryBudgetDenied>;
    /** Settlement remains reserved until an authoritative billing reconciliation exists. */
    readonly settle: (input: {
      reservationId: string;
      actualMicros: number;
    }) => Effect.Effect<void, CanaryBudgetDenied>;
    readonly release: (reservationId: string) => Effect.Effect<void, CanaryBudgetDenied>;
    readonly setStopped: (stopped: boolean) => Effect.Effect<void, CanaryBudgetDenied>;
    readonly status: (userId: string) => Effect.Effect<CanaryBudgetStatus, CanaryBudgetDenied>;
    readonly stop: (userId: string) => Effect.Effect<CanaryBudgetStatus, CanaryBudgetDenied>;
    readonly reconcileAndUnstop: (
      userId: string,
    ) => Effect.Effect<CanaryBudgetStatus, CanaryBudgetDenied>;
  }
>()("t3code-relay/canary/CanaryBudgetAuthority") {}

const denied = (code: CanaryBudgetDenied["code"]) => Effect.fail(new CanaryBudgetDenied({ code }));

export type InMemoryBudgetOptions = {
  readonly nowMs: () => number;
  readonly readAuthoritative: () => Effect.Effect<
    readonly [AuthoritativeLiabilityReading, AuthoritativeLiabilityReading],
    CanaryBudgetDenied
  >;
  readonly maxReadingAgeMs?: number;
  readonly capMicros?: number;
  readonly stopped?: boolean;
  readonly operatorUserIds?: ReadonlySet<string>;
};

/** Deterministic model of the same serialized reservation contract used by Postgres. */
export const makeInMemory = (options: InMemoryBudgetOptions) => {
  const reservations = new Map<
    string,
    {
      kind: CanaryLiabilityKind;
      userId: string;
      fingerprint: string;
      reservedMicros: number;
      status: "active" | "settled" | "released";
      actualMicros: number | null;
    }
  >();
  let stopped = options.stopped ?? false;
  let queue = Promise.resolve();
  const serialized = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: () => {
        const result = queue.then(run, run);
        queue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
      catch: (error) =>
        Schema.is(CanaryBudgetDenied)(error)
          ? error
          : new CanaryBudgetDenied({ code: "persistence_failed" }),
    });
  const authoritative = Effect.fn("salvo.canary.authoritative_read")(function* () {
    const readings = yield* options
      .readAuthoritative()
      .pipe(Effect.mapError(() => new CanaryBudgetDenied({ code: "authoritative_unavailable" })));
    if (
      readings.length !== 2 ||
      new Set(readings.map((entry) => entry.provider)).size !== 2 ||
      readings.some(
        (entry) =>
          !Number.isSafeInteger(entry.billedMicros) || entry.billedMicros < 0 || !entry.source,
      )
    )
      return yield* denied("authoritative_unavailable");
    if (
      readings.some(
        (entry) =>
          options.nowMs() - entry.observedAtMs > (options.maxReadingAgeMs ?? 300_000) ||
          entry.observedAtMs > options.nowMs() + 5_000,
      )
    )
      return yield* denied("authoritative_stale");
    return readings.reduce((sum, entry) => sum + entry.billedMicros, 0);
  });
  const service = CanaryBudgetAuthority.of({
    reserve: (input) =>
      Effect.gen(function* () {
        if (
          !input.reservationId ||
          !input.userId ||
          !/^[a-f0-9]{64}$/u.test(input.fingerprint) ||
          !Number.isSafeInteger(input.micros) ||
          input.micros <= 0
        )
          return yield* denied("invalid");
        if (options.operatorUserIds && !options.operatorUserIds.has(input.userId))
          return yield* denied("non_operator");
        const billedMicros = yield* authoritative();
        return yield* serialized(async () => {
          if (stopped) throw new CanaryBudgetDenied({ code: "stopped" });
          const prior = reservations.get(input.reservationId);
          if (prior) {
            if (
              prior.kind !== input.kind ||
              prior.userId !== input.userId ||
              prior.fingerprint !== input.fingerprint ||
              prior.reservedMicros !== input.micros
            )
              throw new CanaryBudgetDenied({ code: "conflicting_replay" });
            if (prior.status === "released")
              throw new CanaryBudgetDenied({ code: "conflicting_replay" });
            return { ...input, reservedMicros: input.micros, replayed: true };
          }
          const reserved = [...reservations.values()]
            .filter((entry) => entry.status !== "released")
            .reduce(
              (sum, entry) =>
                sum +
                (entry.status === "settled"
                  ? (entry.actualMicros ?? entry.reservedMicros)
                  : entry.reservedMicros),
              0,
            );
          if (
            reserved + billedMicros + input.micros >
            (options.capMicros ?? COMBINED_CANARY_CAP_MICROS)
          )
            throw new CanaryBudgetDenied({ code: "cap_exceeded" });
          reservations.set(input.reservationId, {
            kind: input.kind,
            userId: input.userId,
            fingerprint: input.fingerprint,
            reservedMicros: input.micros,
            status: "active",
            actualMicros: null,
          });
          return { ...input, reservedMicros: input.micros, replayed: false };
        });
      }),
    settle: ({ reservationId, actualMicros }) =>
      serialized(async () => {
        const row = reservations.get(reservationId);
        if (
          !row ||
          !Number.isSafeInteger(actualMicros) ||
          actualMicros < 0 ||
          actualMicros > row.reservedMicros ||
          row.status === "released"
        )
          throw new CanaryBudgetDenied({ code: "invalid" });
        if (row.status === "settled" && row.actualMicros !== actualMicros)
          throw new CanaryBudgetDenied({ code: "conflicting_replay" });
        reservations.set(reservationId, { ...row, status: "settled", actualMicros });
      }),
    release: (reservationId) =>
      serialized(async () => {
        const row = reservations.get(reservationId);
        if (row?.status === "settled") throw new CanaryBudgetDenied({ code: "invalid" });
        if (row) reservations.set(reservationId, { ...row, status: "released" });
      }),
    setStopped: (value) =>
      serialized(async () => {
        stopped = value;
      }),
    status: (userId) =>
      serialized(async () => {
        if (!options.operatorUserIds?.has(userId))
          throw new CanaryBudgetDenied({ code: "non_operator" });
        const reservedMicros = [...reservations.values()]
          .filter((entry) => entry.status !== "released")
          .reduce(
            (sum, entry) =>
              sum +
              (entry.status === "settled"
                ? (entry.actualMicros ?? entry.reservedMicros)
                : entry.reservedMicros),
            0,
          );
        return {
          stopped,
          capMicros: options.capMicros ?? COMBINED_CANARY_CAP_MICROS,
          reservedMicros,
          authoritativeBilledMicros: 0,
          authoritativeObservedAt: null,
        };
      }),
    stop: (userId) =>
      serialized(async () => {
        if (!options.operatorUserIds?.has(userId))
          throw new CanaryBudgetDenied({ code: "non_operator" });
        stopped = true;
        const reservedMicros = [...reservations.values()]
          .filter((entry) => entry.status !== "released")
          .reduce(
            (sum, entry) =>
              sum +
              (entry.status === "settled"
                ? (entry.actualMicros ?? entry.reservedMicros)
                : entry.reservedMicros),
            0,
          );
        return {
          stopped,
          capMicros: options.capMicros ?? COMBINED_CANARY_CAP_MICROS,
          reservedMicros,
          authoritativeBilledMicros: 0,
          authoritativeObservedAt: null,
        };
      }),
    reconcileAndUnstop: (userId) =>
      Effect.gen(function* () {
        if (!options.operatorUserIds?.has(userId)) return yield* denied("non_operator");
        const billedMicros = yield* authoritative();
        return yield* serialized(async () => {
          const reservedMicros = [...reservations.values()]
            .filter((entry) => entry.status !== "released")
            .reduce(
              (sum, entry) =>
                sum +
                (entry.status === "settled"
                  ? (entry.actualMicros ?? entry.reservedMicros)
                  : entry.reservedMicros),
              0,
            );
          if (billedMicros + reservedMicros >= (options.capMicros ?? COMBINED_CANARY_CAP_MICROS))
            throw new CanaryBudgetDenied({ code: "cap_exceeded" });
          stopped = false;
          return {
            stopped,
            capMicros: options.capMicros ?? COMBINED_CANARY_CAP_MICROS,
            reservedMicros,
            authoritativeBilledMicros: billedMicros,
            authoritativeObservedAt: new Date(options.nowMs()).toISOString(),
          };
        });
      }),
  });
  return { service, snapshot: () => ({ stopped, reservations: new Map(reservations) }) };
};

const rawRows = <T>(value: unknown): ReadonlyArray<T> =>
  Array.isArray(value)
    ? (value as ReadonlyArray<T>)
    : ((value as { readonly rows?: ReadonlyArray<T> }).rows ?? []);

export type PostgresBudgetOptions = {
  readonly operatorUserIds: ReadonlySet<string>;
  readonly maxReadingAgeMs?: number;
  readonly nowMs?: () => number;
};

/** Postgres is the serialization boundary shared by every paid canary path. */
export const makePostgres = (options: PostgresBudgetOptions) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    const transactions = yield* RelayDb.RelayTransactions;
    const reader = yield* AuthoritativeLiabilityReader;
    const txDb = PgDrizzle.makeWithDefaults().pipe(
      Effect.provideService(PgClient.PgClient, db.$client),
    );
    const persist = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((error) =>
          Schema.is(CanaryBudgetDenied)(error)
            ? error
            : new CanaryBudgetDenied({ code: "persistence_failed" }),
        ),
      );
    const readAuthoritative = Effect.fn("salvo.canary.authoritative_read")(function* () {
      const entries = yield* reader
        .read()
        .pipe(Effect.mapError(() => new CanaryBudgetDenied({ code: "authoritative_unavailable" })));
      const now = (options.nowMs ?? Date.now)();
      if (
        entries.length !== 2 ||
        new Set(entries.map((entry) => entry.provider)).size !== 2 ||
        entries.some(
          (entry) =>
            !Number.isSafeInteger(entry.billedMicros) || entry.billedMicros < 0 || !entry.source,
        )
      )
        return yield* denied("authoritative_unavailable");
      if (
        entries.some(
          (entry) =>
            now - entry.observedAtMs > (options.maxReadingAgeMs ?? 300_000) ||
            entry.observedAtMs > now + 5_000,
        )
      )
        return yield* denied("authoritative_stale");
      return {
        billedMicros: entries.reduce((sum, entry) => sum + entry.billedMicros, 0),
        observedAtMs: Math.min(...entries.map((entry) => entry.observedAtMs)),
      };
    });
    type TransactionDb = Effect.Success<typeof txDb>;
    const readStatus = (tx: TransactionDb) =>
      Effect.gen(function* () {
        const state = rawRows<{
          stopped: boolean;
          cap_micros: number;
          authoritative_billed_micros: number;
          authoritative_observed_at: string | null;
        }>(
          yield* tx.execute(
            sql`select * from salvo_canary_budget_control where singleton = 1 for update`,
          ),
        )[0];
        if (!state) return yield* denied("persistence_failed");
        const reservedMicros =
          rawRows<{ liability_micros: number }>(
            yield* tx.execute(
              sql`select coalesce(sum(case when status = 'settled' then coalesce(actual_micros, reserved_micros) else reserved_micros end), 0)::bigint as liability_micros from salvo_canary_budget_reservations where status <> 'released'`,
            ),
          )[0]?.liability_micros ?? 0;
        return {
          stopped: state.stopped,
          capMicros: state.cap_micros,
          reservedMicros,
          authoritativeBilledMicros: state.authoritative_billed_micros,
          authoritativeObservedAt: state.authoritative_observed_at,
        };
      });
    return CanaryBudgetAuthority.of({
      reserve: (input) =>
        Effect.gen(function* () {
          if (
            !input.reservationId ||
            input.reservationId.length > 191 ||
            !input.userId ||
            !/^[a-f0-9]{64}$/u.test(input.fingerprint) ||
            !Number.isSafeInteger(input.micros) ||
            input.micros <= 0
          )
            return yield* denied("invalid");
          if (!options.operatorUserIds.has(input.userId)) return yield* denied("non_operator");
          const authoritative = yield* readAuthoritative();
          return yield* transactions
            .withTransaction(
              Effect.gen(function* () {
                const tx = yield* txDb;
                const state = rawRows<{
                  stopped: boolean;
                  cap_micros: number;
                  authoritative_observed_at: string | null;
                }>(
                  yield* tx.execute(
                    sql`select * from salvo_canary_budget_control where singleton = 1 for update`,
                  ),
                )[0];
                if (!state) return yield* denied("persistence_failed");
                if (state.stopped) return yield* denied("stopped");
                const prior = (yield* tx
                  .select()
                  .from(reservations)
                  .where(eq(reservations.reservationId, input.reservationId))
                  .limit(1))[0];
                if (prior) {
                  if (
                    prior.kind !== input.kind ||
                    prior.userId !== input.userId ||
                    prior.fingerprint !== input.fingerprint ||
                    prior.reservedMicros !== input.micros ||
                    prior.status === "released"
                  )
                    return yield* denied("conflicting_replay");
                  return {
                    reservationId: input.reservationId,
                    kind: input.kind,
                    userId: input.userId,
                    reservedMicros: input.micros,
                    replayed: true,
                  };
                }
                const liability =
                  rawRows<{ liability_micros: number }>(
                    yield* tx.execute(
                      sql`select coalesce(sum(case when status = 'settled' then coalesce(actual_micros, reserved_micros) else reserved_micros end), 0)::bigint as liability_micros from salvo_canary_budget_reservations where status <> 'released'`,
                    ),
                  )[0]?.liability_micros ?? 0;
                if (authoritative.billedMicros + liability + input.micros > state.cap_micros)
                  return yield* denied("cap_exceeded");
                const now = DateTime.formatIso(yield* DateTime.now);
                yield* tx
                  .update(control)
                  .set({
                    authoritativeBilledMicros: authoritative.billedMicros,
                    authoritativeObservedAt: DateTime.formatIso(
                      DateTime.makeUnsafe(authoritative.observedAtMs),
                    ),
                    updatedAt: now,
                  })
                  .where(eq(control.singleton, 1));
                yield* tx
                  .insert(reservations)
                  .values({
                    reservationId: input.reservationId,
                    kind: input.kind,
                    userId: input.userId,
                    fingerprint: input.fingerprint,
                    reservedMicros: input.micros,
                    status: "active",
                    actualMicros: null,
                    createdAt: now,
                    updatedAt: now,
                  });
                return {
                  reservationId: input.reservationId,
                  kind: input.kind,
                  userId: input.userId,
                  reservedMicros: input.micros,
                  replayed: false,
                };
              }),
            )
            .pipe(persist);
        }),
      settle: ({ reservationId, actualMicros }) =>
        transactions
          .withTransaction(
            Effect.gen(function* () {
              const tx = yield* txDb;
              const row = (yield* tx
                .select()
                .from(reservations)
                .where(eq(reservations.reservationId, reservationId))
                .limit(1))[0];
              if (
                !row ||
                !Number.isSafeInteger(actualMicros) ||
                actualMicros < 0 ||
                actualMicros > row.reservedMicros ||
                row.status === "released"
              )
                return yield* denied("invalid");
              if (row.status === "settled" && row.actualMicros !== actualMicros)
                return yield* denied("conflicting_replay");
              if (row.status === "active")
                yield* tx
                  .update(reservations)
                  .set({
                    status: "settled",
                    actualMicros,
                    updatedAt: DateTime.formatIso(yield* DateTime.now),
                  })
                  .where(eq(reservations.reservationId, reservationId));
            }),
          )
          .pipe(persist),
      release: (reservationId) =>
        transactions
          .withTransaction(
            Effect.gen(function* () {
              const tx = yield* txDb;
              const row = (yield* tx
                .select()
                .from(reservations)
                .where(eq(reservations.reservationId, reservationId))
                .limit(1))[0];
              if (row?.status === "settled") return yield* denied("invalid");
              if (row?.status === "active")
                yield* tx
                  .update(reservations)
                  .set({ status: "released", updatedAt: DateTime.formatIso(yield* DateTime.now) })
                  .where(eq(reservations.reservationId, reservationId));
            }),
          )
          .pipe(persist),
      setStopped: (stopped) =>
        transactions
          .withTransaction(
            Effect.gen(function* () {
              const tx = yield* txDb;
              yield* tx
                .update(control)
                .set({ stopped, updatedAt: DateTime.formatIso(yield* DateTime.now) })
                .where(eq(control.singleton, 1));
            }),
          )
          .pipe(persist),
      status: (userId) => {
        if (!options.operatorUserIds.has(userId)) return denied("non_operator");
        return transactions
          .withTransaction(
            Effect.gen(function* () {
              return yield* readStatus(yield* txDb);
            }),
          )
          .pipe(persist);
      },
      stop: (userId) => {
        if (!options.operatorUserIds.has(userId)) return denied("non_operator");
        return transactions
          .withTransaction(
            Effect.gen(function* () {
              const tx = yield* txDb;
              yield* tx
                .update(control)
                .set({ stopped: true, updatedAt: DateTime.formatIso(yield* DateTime.now) })
                .where(eq(control.singleton, 1));
              return yield* readStatus(tx);
            }),
          )
          .pipe(persist);
      },
      reconcileAndUnstop: (userId) =>
        Effect.gen(function* () {
          if (!options.operatorUserIds.has(userId)) return yield* denied("non_operator");
          const authoritative = yield* readAuthoritative();
          return yield* transactions
            .withTransaction(
              Effect.gen(function* () {
                const tx = yield* txDb;
                const status = yield* readStatus(tx);
                if (authoritative.billedMicros + status.reservedMicros >= status.capMicros)
                  return yield* denied("cap_exceeded");
                const observedAt = DateTime.formatIso(
                  DateTime.makeUnsafe(authoritative.observedAtMs),
                );
                yield* tx
                  .update(control)
                  .set({
                    stopped: false,
                    authoritativeBilledMicros: authoritative.billedMicros,
                    authoritativeObservedAt: observedAt,
                    updatedAt: DateTime.formatIso(yield* DateTime.now),
                  })
                  .where(eq(control.singleton, 1));
                return {
                  ...status,
                  stopped: false,
                  authoritativeBilledMicros: authoritative.billedMicros,
                  authoritativeObservedAt: observedAt,
                };
              }),
            )
            .pipe(persist);
        }),
    });
  });

export const layerPostgres = (options: PostgresBudgetOptions) =>
  Layer.effect(CanaryBudgetAuthority, makePostgres(options));

export const authoritativeReaderUnavailable = Layer.succeed(
  AuthoritativeLiabilityReader,
  AuthoritativeLiabilityReader.of({
    read: () => denied("authoritative_unavailable"),
  }),
);

export const layerDisabled = Layer.succeed(
  CanaryBudgetAuthority,
  CanaryBudgetAuthority.of({
    reserve: (input) => Effect.succeed({ ...input, reservedMicros: input.micros, replayed: false }),
    settle: () => Effect.void,
    release: () => Effect.void,
    setStopped: () => Effect.void,
    status: () =>
      Effect.succeed({
        stopped: false,
        capMicros: COMBINED_CANARY_CAP_MICROS,
        reservedMicros: 0,
        authoritativeBilledMicros: 0,
        authoritativeObservedAt: null,
      }),
    stop: () =>
      Effect.succeed({
        stopped: true,
        capMicros: COMBINED_CANARY_CAP_MICROS,
        reservedMicros: 0,
        authoritativeBilledMicros: 0,
        authoritativeObservedAt: null,
      }),
    reconcileAndUnstop: () =>
      Effect.succeed({
        stopped: false,
        capMicros: COMBINED_CANARY_CAP_MICROS,
        reservedMicros: 0,
        authoritativeBilledMicros: 0,
        authoritativeObservedAt: null,
      }),
  }),
);

export const layerUnavailable = Layer.succeed(
  CanaryBudgetAuthority,
  CanaryBudgetAuthority.of({
    reserve: () => denied("authoritative_unavailable"),
    settle: () => denied("authoritative_unavailable"),
    release: () => denied("authoritative_unavailable"),
    setStopped: () => denied("authoritative_unavailable"),
    status: () => denied("authoritative_unavailable"),
    stop: () => denied("authoritative_unavailable"),
    reconcileAndUnstop: () => denied("authoritative_unavailable"),
  }),
);
