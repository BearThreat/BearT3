import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CanaryBudgetDenied, makeInMemory } from "./CanaryBudgetAuthority.ts";

const fingerprint = (value: string) =>
  Buffer.from(value).toString("hex").padEnd(64, "a").slice(0, 64);
const readings = (now: number, aws = 0, openai = 0) =>
  Effect.succeed([
    { provider: "aws" as const, billedMicros: aws, observedAtMs: now, source: "aws-cost-explorer" },
    {
      provider: "openai" as const,
      billedMicros: openai,
      observedAtMs: now,
      source: "openai-usage",
    },
  ] as const);

describe("Salvo combined canary budget authority", () => {
  it.effect("serializes AWS and OpenAI reservations under one 10 USD cap", () => {
    const now = 1_777_000_000_000;
    const budget = makeInMemory({
      nowMs: () => now,
      readAuthoritative: () => readings(now, 1_000_000, 1_000_000),
    });
    return Effect.gen(function* () {
      const attempts = yield* Effect.all(
        Array.from({ length: 10 }, (_, index) =>
          budget.service
            .reserve({
              reservationId: `reservation-${index}`,
              kind: index % 2 === 0 ? "aws" : "openai",
              userId: `user-${index}`,
              fingerprint: fingerprint(`${index}`),
              micros: 1_000_000,
            })
            .pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );
      expect(attempts.filter((entry) => entry._tag === "Success")).toHaveLength(8);
      expect(attempts.filter((entry) => entry._tag === "Failure")).toHaveLength(2);
      expect(
        [...budget.snapshot().reservations.values()]
          .filter((entry) => entry.status !== "released")
          .reduce((sum, entry) => sum + entry.reservedMicros, 0),
      ).toBe(8_000_000);
    });
  });

  it.effect("replays the same reservation and rejects a changed replay", () => {
    const now = 1_777_000_000_000;
    const budget = makeInMemory({ nowMs: () => now, readAuthoritative: () => readings(now) });
    const input = {
      reservationId: "same",
      kind: "aws" as const,
      userId: "operator",
      fingerprint: fingerprint("one"),
      micros: 2_000_000,
    };
    return Effect.gen(function* () {
      expect((yield* budget.service.reserve(input)).replayed).toBe(false);
      expect((yield* budget.service.reserve(input)).replayed).toBe(true);
      const error = yield* Effect.flip(budget.service.reserve({ ...input, micros: 3_000_000 }));
      expect(error).toMatchObject({ code: "conflicting_replay" });
    });
  });

  it.effect("fails closed on missing or stale authoritative provider readings", () => {
    const now = 1_777_000_000_000;
    const unavailable = makeInMemory({
      nowMs: () => now,
      readAuthoritative: () =>
        Effect.fail(new CanaryBudgetDenied({ code: "authoritative_unavailable" })),
    });
    const stale = makeInMemory({
      nowMs: () => now,
      readAuthoritative: () => readings(now - 300_001),
    });
    const input = {
      reservationId: "one",
      kind: "openai" as const,
      userId: "operator",
      fingerprint: fingerprint("one"),
      micros: 1,
    };
    return Effect.gen(function* () {
      expect(yield* Effect.flip(unavailable.service.reserve(input))).toMatchObject({
        code: "authoritative_unavailable",
      });
      expect(yield* Effect.flip(stale.service.reserve(input))).toMatchObject({
        code: "authoritative_stale",
      });
    });
  });

  it.effect(
    "recovers a forced stop by releasing failed active liability before explicit restart",
    () => {
      const now = 1_777_000_000_000;
      const budget = makeInMemory({ nowMs: () => now, readAuthoritative: () => readings(now) });
      const input = {
        reservationId: "failed-aws",
        kind: "aws" as const,
        userId: "operator",
        fingerprint: fingerprint("failed"),
        micros: 9_000_000,
      };
      return Effect.gen(function* () {
        yield* budget.service.reserve(input);
        yield* budget.service.setStopped(true);
        const stopped = yield* Effect.flip(
          budget.service.reserve({
            ...input,
            reservationId: "blocked",
            fingerprint: fingerprint("blocked"),
          }),
        );
        expect(stopped).toMatchObject({ code: "stopped" });
        yield* budget.service.release(input.reservationId);
        yield* budget.service.setStopped(false);
        yield* budget.service.reserve({
          ...input,
          reservationId: "recovered",
          fingerprint: fingerprint("recovered"),
        });
        expect(budget.snapshot().reservations.get("failed-aws")?.status).toBe("released");
      });
    },
  );

  it.effect("keeps settled provider liability reserved until authoritative reconciliation", () => {
    const now = 1_777_000_000_000;
    const budget = makeInMemory({ nowMs: () => now, readAuthoritative: () => readings(now) });
    return Effect.gen(function* () {
      yield* budget.service.reserve({
        reservationId: "openai-turn",
        kind: "openai",
        userId: "operator",
        fingerprint: fingerprint("turn"),
        micros: 2_000_000,
      });
      yield* budget.service.settle({ reservationId: "openai-turn", actualMicros: 1_000_000 });
      const error = yield* Effect.flip(budget.service.release("openai-turn"));
      expect(error._tag).toBe("CanaryBudgetDenied");
      expect(budget.snapshot().reservations.get("openai-turn")).toMatchObject({
        status: "settled",
        actualMicros: 1_000_000,
      });
    });
  });

  it.effect("allows only an operator to reconcile and unstop below the strict cap", () => {
    const now = 1_777_000_000_000;
    const budget = makeInMemory({
      nowMs: () => now,
      readAuthoritative: () => readings(now, 4_000_000, 5_000_000),
      stopped: true,
      operatorUserIds: new Set(["operator"]),
    });
    return Effect.gen(function* () {
      expect(yield* Effect.flip(budget.service.reconcileAndUnstop("intruder"))).toMatchObject({
        code: "non_operator",
      });
      expect(yield* budget.service.reconcileAndUnstop("operator")).toMatchObject({
        stopped: false,
        authoritativeBilledMicros: 9_000_000,
      });
      yield* budget.service.stop("operator");
      expect((yield* budget.service.status("operator")).stopped).toBe(true);
      const atCap = makeInMemory({
        nowMs: () => now,
        readAuthoritative: () => readings(now, 5_000_000, 5_000_000),
        stopped: true,
        operatorUserIds: new Set(["operator"]),
      });
      expect(yield* Effect.flip(atCap.service.reconcileAndUnstop("operator"))).toMatchObject({
        code: "cap_exceeded",
      });
      expect(atCap.snapshot().stopped).toBe(true);
    });
  });
});
