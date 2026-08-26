import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { HostedSandboxPersistenceRecord } from "../hostedSandboxes/HostedSandboxRepository.ts";
import type { BoundProbeRequest, Gate } from "./GauntletProbe.ts";
import {
  COMBINED_CANARY_CAP_MICROS,
  makeAdapter,
  type BudgetSnapshot,
} from "./GauntletProbeLive.ts";

const scenarioId = "adapter-20260825-a";
const request = (gate: Gate, pass: BoundProbeRequest["pass"] = "clean"): BoundProbeRequest => ({
  gate,
  pass,
  scenarioId,
  nonce: "d9428888-122b-4ae3-9f1b-37682d8d00e0",
  fixtures: {
    userIds: [`${scenarioId}-user-a`, `${scenarioId}-user-b`],
    sandboxIds: [`${scenarioId}-box-a`, `${scenarioId}-box-b`],
  },
  forcedFailure: pass === "forced-failure",
  sourceRevision: "revision-20260825",
  runtimeImageId: "ami-salvo-20260825",
  skillReleaseHash: "ab".repeat(32),
  infrastructurePlanHash: "cd".repeat(32),
  gauntletSpecHash: "ef".repeat(32),
  evidenceCollectorId: "salvo-probe.v1",
});

const record = (userId: string, sandboxId: string): HostedSandboxPersistenceRecord => ({
  userId,
  sandboxId,
  requestId: `request-${sandboxId}`,
  status: "ready",
  providerRef: `provider-${sandboxId}`,
  endpoint: `https://${sandboxId}.invalid`,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:01.000Z",
});

const setup = (
  options: {
    readonly operators?: ReadonlySet<string>;
    readonly records?: readonly HostedSandboxPersistenceRecord[];
    readonly reserve?: boolean;
    readonly ready?: boolean;
    readonly budget?: BudgetSnapshot;
  } = {},
) => {
  const records = options.records ?? [];
  return makeAdapter({
    operatorUserIds: options.operators ?? new Set(),
    reserve: () => Effect.succeed(options.reserve ?? true),
    loadOwned: ({ userId, sandboxId }) =>
      Effect.succeed(
        records.find((entry) => entry.userId === userId && entry.sandboxId === sandboxId) ?? null,
      ),
    health: () =>
      Effect.succeed({
        ready: options.ready ?? true,
        endpoint: options.ready === false ? null : "https://sandbox.invalid",
      }),
    readBudget: () =>
      Effect.succeed(
        options.budget ?? {
          configuredPilotCapMicros: 5_000_000,
          stopped: false,
          reservedMicros: 100_000,
          billedMicros: 200_000,
          fixtureUsersObserved: 2,
          fixtureRunningReservedMicros: 100_000,
          fixtureUserReservedMicros: 100_000,
          conflictingReplayDenials: 1,
          budgetDenials: 1,
          providerUsage: [
            {
              provider: "aws",
              source: "unavailable",
              authoritative: false,
              billedMicros: null,
              observedAt: null,
            },
            {
              provider: "openai",
              source: "relay-ledger-not-provider-billing",
              authoritative: false,
              billedMicros: null,
              observedAt: null,
            },
          ],
        },
      ),
  });
};

describe("GauntletProbeLive", () => {
  it.effect("reports only the operator-fixture fact it can prove", () =>
    Effect.gen(function* () {
      const probe = request("instant-onboarding");
      const adapter = setup({ operators: new Set(probe.fixtures.userIds) });
      const report = yield* adapter.run(probe);
      expect(report.observations).toEqual([
        expect.objectContaining({ checkId: "operator-only-fixtures", result: "pass" }),
      ]);
      expect(report.metrics).toMatchObject({ operatorFixtureCount: 2 });
      expect(report.failureInjected).toBe(false);
    }),
  );

  it.effect("passes an observed ownership matrix and fails a cross-owner leak", () =>
    Effect.gen(function* () {
      const probe = request("user-isolation");
      const [userA, userB] = probe.fixtures.userIds;
      const [sandboxA, sandboxB] = probe.fixtures.sandboxIds;
      const owned = [record(userA, sandboxA), record(userB, sandboxB)];
      const clean = yield* setup({ records: owned }).run(probe);
      expect(clean.observations).toEqual([
        expect.objectContaining({ checkId: "authorization-matrix", result: "pass" }),
      ]);
      const leaked = yield* setup({ records: [...owned, record(userA, sandboxB)] }).run(probe);
      expect(leaked.observations).toEqual([
        expect.objectContaining({ checkId: "authorization-matrix", result: "fail" }),
      ]);
      expect(leaked.metrics).toMatchObject({ crossUserLeaks: 1 });
    }),
  );

  it.effect("stays inconclusive when fixture ownership is not observable", () =>
    Effect.gen(function* () {
      const report = yield* setup().run(request("user-isolation"));
      expect(report.observations).toEqual([
        expect.objectContaining({ checkId: "authorization-matrix", result: "inconclusive" }),
      ]);
    }),
  );

  it.effect("checks provider state only for a clean pass with two bound fixtures", () =>
    Effect.gen(function* () {
      const probe = request("operator-control");
      const records = probe.fixtures.userIds.map((userId, index) =>
        record(userId, probe.fixtures.sandboxIds[index]!),
      );
      const clean = yield* setup({ records }).run(probe);
      expect(clean.observations).toEqual([
        expect.objectContaining({ checkId: "provider-compute-state", result: "pass" }),
        expect.objectContaining({ checkId: "managed-endpoint-dns", result: "inconclusive" }),
      ]);
      const forced = yield* setup({ records }).run(request("operator-control", "forced-failure"));
      expect(forced.observations).toEqual([]);
      expect(forced.failureInjected).toBe(false);
      expect(forced.recoveryVerified).toBe(false);
    }),
  );

  it.effect(
    "proves local budget controls but leaves provider billing inconclusive without authoritative readers",
    () =>
      Effect.gen(function* () {
        const report = yield* setup().run(request("budget-caps"));
        expect(report.observations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ checkId: "atomic-reservation", result: "pass" }),
            expect.objectContaining({ checkId: "replay", result: "pass" }),
            expect.objectContaining({ checkId: "resource-abuse", result: "pass" }),
            expect.objectContaining({ checkId: "pilot-hard-stop", result: "inconclusive" }),
            expect.objectContaining({
              checkId: "independent-billable-resource-query",
              result: "inconclusive",
            }),
          ]),
        );
        expect(report.metrics).toMatchObject({
          capUsd: 10,
          reservedUsd: 0.1,
          billedUsd: 0.2,
          providerUsageAuthoritative: false,
        });
      }),
  );

  it.effect("fails a configured pilot cap above the combined USD 10 canary ceiling", () =>
    Effect.gen(function* () {
      const budget: BudgetSnapshot = {
        configuredPilotCapMicros: COMBINED_CANARY_CAP_MICROS + 1,
        stopped: false,
        reservedMicros: 0,
        billedMicros: 0,
        fixtureUsersObserved: 2,
        fixtureRunningReservedMicros: 0,
        fixtureUserReservedMicros: 0,
        conflictingReplayDenials: 0,
        budgetDenials: 0,
        providerUsage: [],
      };
      const report = yield* setup({ budget }).run(request("budget-caps"));
      expect(report.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ checkId: "atomic-reservation", result: "fail" }),
        ]),
      );
    }),
  );

  it.effect(
    "accepts combined provider usage only when AWS and OpenAI sources are authoritative",
    () =>
      Effect.gen(function* () {
        const budget: BudgetSnapshot = {
          configuredPilotCapMicros: COMBINED_CANARY_CAP_MICROS,
          stopped: true,
          reservedMicros: 0,
          billedMicros: 0,
          fixtureUsersObserved: 2,
          fixtureRunningReservedMicros: 0,
          fixtureUserReservedMicros: 0,
          conflictingReplayDenials: 1,
          budgetDenials: 1,
          providerUsage: [
            {
              provider: "aws",
              source: "aws-cost-explorer",
              authoritative: true,
              billedMicros: 2_000_000,
              observedAt: "2026-08-25T00:00:00Z",
            },
            {
              provider: "openai",
              source: "openai-usage-api",
              authoritative: true,
              billedMicros: 3_000_000,
              observedAt: "2026-08-25T00:00:00Z",
            },
          ],
        };
        const report = yield* setup({ budget }).run(request("budget-caps", "forced-failure"));
        expect(report.observations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ checkId: "pilot-hard-stop", result: "pass" }),
            expect.objectContaining({
              checkId: "independent-billable-resource-query",
              result: "pass",
            }),
          ]),
        );
        expect(report.failureInjected).toBe(false);
        expect(report.recoveryVerified).toBe(false);
      }),
  );
});
