// @effect-diagnostics globalDate:off -- Provider observation milliseconds are projected as ISO evidence.
import * as NodeCrypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RelayConfiguration } from "../Config.ts";
import * as RelayDb from "../db.ts";
import { HostedSandboxProvider } from "../hostedSandboxes/HostedSandboxProvider.ts";
import {
  HostedSandboxRepository,
  type HostedSandboxPersistenceRecord,
} from "../hostedSandboxes/HostedSandboxRepository.ts";
import {
  salvoCanaryBudgetControl,
  salvoCanaryBudgetReservations,
  salvoGauntletProbeReservations,
  salvoSponsoredInferenceAudits,
} from "../persistence/schema.ts";
import { AuthoritativeLiabilityReader } from "../canary/CanaryBudgetAuthority.ts";
import {
  GauntletProbeAdapter,
  type AdapterReport,
  type BoundProbeRequest,
  type DeterministicProbeAdapter,
  type ProbeObservation,
} from "./GauntletProbe.ts";

type Dependencies = {
  readonly operatorUserIds: ReadonlySet<string>;
  readonly reserve: (request: BoundProbeRequest) => Effect.Effect<boolean, GauntletProbeLiveError>;
  readonly loadOwned: (input: {
    readonly userId: string;
    readonly sandboxId: string;
  }) => Effect.Effect<HostedSandboxPersistenceRecord | null, GauntletProbeLiveError>;
  readonly health: (input: {
    readonly sandboxId: string;
    readonly providerRef: string;
  }) => Effect.Effect<
    { readonly ready: boolean; readonly endpoint: string | null },
    GauntletProbeLiveError
  >;
  readonly readBudget: (
    request: BoundProbeRequest,
  ) => Effect.Effect<BudgetSnapshot, GauntletProbeLiveError>;
  readonly readDnsSnapshot?: (
    hostnames: readonly string[],
  ) => Effect.Effect<readonly DnsSnapshot[], GauntletProbeLiveError>;
};

export type DnsSnapshot = {
  readonly hostname: string;
  readonly target: string;
  readonly observedAt: string;
};

export type ProviderUsage = {
  readonly provider: "aws" | "openai";
  readonly source: string;
  readonly authoritative: boolean;
  readonly billedMicros: number | null;
  readonly observedAt: string | null;
};

export type BudgetSnapshot = {
  readonly configuredPilotCapMicros: number | null;
  readonly stopped: boolean | null;
  readonly reservedMicros: number;
  readonly billedMicros: number;
  readonly fixtureUsersObserved: number;
  readonly fixtureRunningReservedMicros: number;
  readonly fixtureUserReservedMicros: number;
  readonly conflictingReplayDenials: number;
  readonly budgetDenials: number;
  readonly providerUsage: readonly ProviderUsage[];
};

export const COMBINED_CANARY_CAP_MICROS = 10_000_000;

export class GauntletProbeLiveError extends Schema.TaggedErrorClass<GauntletProbeLiveError>()(
  "GauntletProbeLiveError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const digest = (parts: readonly string[]) =>
  NodeCrypto.createHash("sha256")
    .update(parts.map((part) => `${part.length}:${part}`).join("|"))
    .digest("hex");
const observation = (
  request: BoundProbeRequest,
  checkId: string,
  result: ProbeObservation["result"],
  evidence: readonly string[],
): ProbeObservation => ({
  checkId,
  result,
  observationId: `obs-${digest([request.sourceRevision, request.runtimeImageId, request.skillReleaseHash, request.infrastructurePlanHash, request.gauntletSpecHash, request.evidenceCollectorId, request.scenarioId, checkId, ...evidence]).slice(0, 32)}`,
});

export const makeAdapter = (dependencies: Dependencies): DeterministicProbeAdapter => ({
  gates: new Set(["instant-onboarding", "user-isolation", "operator-control", "budget-caps"]),
  reserveFresh: dependencies.reserve,
  run: (request) =>
    Effect.gen(function* () {
      const observations: ProbeObservation[] = [];
      const metrics: Record<string, unknown> = {};

      if (request.gate === "instant-onboarding") {
        const operatorFixtureCount = request.fixtures.userIds.filter((userId) =>
          dependencies.operatorUserIds.has(userId),
        ).length;
        metrics.operatorFixtureCount = operatorFixtureCount;
        observations.push(
          observation(
            request,
            "operator-only-fixtures",
            operatorFixtureCount === 2 ? "pass" : "fail",
            [`operators:${operatorFixtureCount}`],
          ),
        );
      }

      if (request.gate === "user-isolation") {
        const [userA, userB] = request.fixtures.userIds;
        const [sandboxA, sandboxB] = request.fixtures.sandboxIds;
        const [ownA, ownB, crossA, crossB] = yield* Effect.all([
          dependencies.loadOwned({ userId: userA, sandboxId: sandboxA }),
          dependencies.loadOwned({ userId: userB, sandboxId: sandboxB }),
          dependencies.loadOwned({ userId: userA, sandboxId: sandboxB }),
          dependencies.loadOwned({ userId: userB, sandboxId: sandboxA }),
        ]);
        metrics.ownedFixturesObserved = Number(ownA !== null) + Number(ownB !== null);
        metrics.crossUserLeaks = Number(crossA !== null) + Number(crossB !== null);
        observations.push(
          observation(
            request,
            "authorization-matrix",
            ownA === null || ownB === null
              ? "inconclusive"
              : crossA !== null || crossB !== null
                ? "fail"
                : "pass",
            [
              `own:${Number(ownA !== null) + Number(ownB !== null)}`,
              `cross:${Number(crossA !== null) + Number(crossB !== null)}`,
            ],
          ),
        );
      }

      if (request.gate === "operator-control" && request.pass === "clean") {
        const records = yield* Effect.all(
          request.fixtures.userIds.map((userId, index) =>
            dependencies.loadOwned({ userId, sandboxId: request.fixtures.sandboxIds[index]! }),
          ),
        );
        const health = yield* Effect.all(
          records.map((record) =>
            record?.providerRef
              ? dependencies
                  .health({ sandboxId: record.sandboxId, providerRef: record.providerRef })
                  .pipe(
                    Effect.map((value) => ({ observed: true, ...value })),
                    Effect.orElseSucceed(() => ({ observed: false, ready: false, endpoint: null })),
                  )
              : Effect.succeed({ observed: false, ready: false, endpoint: null }),
          ),
        );
        const observed = health.filter((entry) => entry.observed).length;
        const ready = health.filter(
          (entry) => entry.observed && entry.ready && entry.endpoint !== null,
        ).length;
        metrics.providerStatesObserved = observed;
        metrics.readyProviderStates = ready;
        observations.push(
          observation(
            request,
            "provider-compute-state",
            observed < 2 ? "inconclusive" : ready === 2 ? "pass" : "fail",
            [`observed:${observed}`, `ready:${ready}`],
          ),
        );
        const hostnames = health.flatMap((entry) =>
          entry.endpoint ? [new URL(entry.endpoint).hostname] : [],
        );
        const dns =
          dependencies.readDnsSnapshot && hostnames.length === 2
            ? yield* dependencies.readDnsSnapshot(hostnames).pipe(Effect.orElseSucceed(() => []))
            : [];
        observations.push(
          observation(
            request,
            "managed-endpoint-dns",
            dns.length !== 2
              ? "inconclusive"
              : dns.every((entry) => hostnames.includes(entry.hostname) && entry.target.length > 0)
                ? "pass"
                : "fail",
            [`requested:${hostnames.length}`, `observed:${dns.length}`],
          ),
        );
      }

      if (request.gate === "budget-caps") {
        const budget = yield* dependencies.readBudget(request);
        const configuredCapSafe =
          budget.configuredPilotCapMicros !== null &&
          budget.configuredPilotCapMicros <= COMBINED_CANARY_CAP_MICROS;
        const ledgerConsistent =
          budget.fixtureUsersObserved === 2 &&
          budget.fixtureRunningReservedMicros === budget.fixtureUserReservedMicros;
        const localWithinCap =
          budget.reservedMicros >= 0 &&
          budget.billedMicros >= 0 &&
          budget.reservedMicros + budget.billedMicros <= COMBINED_CANARY_CAP_MICROS;
        const atomicResult =
          budget.configuredPilotCapMicros === null ||
          budget.stopped === null ||
          budget.fixtureUsersObserved < 2
            ? "inconclusive"
            : configuredCapSafe && ledgerConsistent && localWithinCap
              ? "pass"
              : "fail";
        observations.push(
          observation(request, "atomic-reservation", atomicResult, [
            `configured:${budget.configuredPilotCapMicros ?? "unavailable"}`,
            `running:${budget.fixtureRunningReservedMicros}`,
            `users:${budget.fixtureUserReservedMicros}`,
            `control:${budget.reservedMicros}:${budget.billedMicros}`,
          ]),
        );
        observations.push(
          observation(
            request,
            "replay",
            budget.conflictingReplayDenials > 0 ? "pass" : "inconclusive",
            [`denials:${budget.conflictingReplayDenials}`],
          ),
        );
        observations.push(
          observation(
            request,
            "resource-abuse",
            budget.budgetDenials > 0 ? "pass" : "inconclusive",
            [`denials:${budget.budgetDenials}`],
          ),
        );
        const hardStopResult =
          request.pass !== "forced-failure"
            ? "inconclusive"
            : budget.stopped === null
              ? "inconclusive"
              : budget.stopped && budget.reservedMicros === 0
                ? "pass"
                : "fail";
        observations.push(
          observation(request, "pilot-hard-stop", hardStopResult, [
            `stopped:${budget.stopped ?? "unavailable"}`,
            `reserved:${budget.reservedMicros}`,
          ]),
        );
        const authoritative = budget.providerUsage.filter(
          (usage) => usage.authoritative && usage.billedMicros !== null,
        );
        const allProvidersAuthoritative =
          authoritative.some((usage) => usage.provider === "aws") &&
          authoritative.some((usage) => usage.provider === "openai");
        const authoritativeBilledMicros = authoritative.reduce(
          (sum, usage) => sum + (usage.billedMicros ?? 0),
          0,
        );
        const providerResult = !allProvidersAuthoritative
          ? "inconclusive"
          : authoritativeBilledMicros + budget.reservedMicros <= COMBINED_CANARY_CAP_MICROS
            ? "pass"
            : "fail";
        observations.push(
          observation(
            request,
            "independent-billable-resource-query",
            providerResult,
            budget.providerUsage.map(
              (usage) =>
                `${usage.provider}:${usage.source}:${usage.authoritative}:${usage.billedMicros ?? "unavailable"}`,
            ),
          ),
        );
        metrics.capUsd = COMBINED_CANARY_CAP_MICROS / 1_000_000;
        metrics.reservedUsd = budget.reservedMicros / 1_000_000;
        metrics.billedUsd =
          (allProvidersAuthoritative ? authoritativeBilledMicros : budget.billedMicros) / 1_000_000;
        metrics.providerUsage = budget.providerUsage;
        metrics.providerUsageAuthoritative = allProvidersAuthoritative;
        metrics.configuredPilotCapUsd =
          budget.configuredPilotCapMicros === null
            ? null
            : budget.configuredPilotCapMicros / 1_000_000;
      }

      return {
        observations,
        metrics,
        failureInjected: false,
        recoveryVerified: false,
        requestId: `gauntlet-${digest([request.sourceRevision, request.nonce]).slice(0, 24)}`,
      } satisfies AdapterReport;
    }),
});

export const layer = (options: { readonly pilotCapMicros: number | null }) =>
  Layer.effect(
    GauntletProbeAdapter,
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      const repository = yield* HostedSandboxRepository;
      const provider = yield* HostedSandboxProvider;
      const configuration = yield* RelayConfiguration;
      const authoritativeReader = yield* AuthoritativeLiabilityReader;
      return makeAdapter({
        operatorUserIds: configuration.salvoOperatorUserIds ?? new Set(),
        reserve: (request) =>
          Effect.gen(function* () {
            const fixtureSetHash = digest(
              [...request.fixtures.userIds, ...request.fixtures.sandboxIds].toSorted(),
            );
            const reservationId = digest([request.sourceRevision, request.nonce]);
            const rows = yield* db
              .insert(salvoGauntletProbeReservations)
              .values({
                reservationId,
                deploymentRevision: request.sourceRevision,
                nonce: request.nonce,
                fixtureSetHash,
                scenarioId: request.scenarioId,
                createdAt: DateTime.formatIso(yield* DateTime.now),
              })
              .onConflictDoNothing()
              .returning({ reservationId: salvoGauntletProbeReservations.reservationId });
            return rows.length === 1;
          }).pipe(
            Effect.mapError((cause) => new GauntletProbeLiveError({ operation: "reserve", cause })),
          ),
        loadOwned: (input) =>
          repository
            .loadOwned(input)
            .pipe(
              Effect.mapError(
                (cause) => new GauntletProbeLiveError({ operation: "load-owned", cause }),
              ),
            ),
        health: (input) =>
          provider
            .health(input)
            .pipe(
              Effect.mapError(
                (cause) => new GauntletProbeLiveError({ operation: "provider-health", cause }),
              ),
            ),
        readBudget: (request) =>
          Effect.gen(function* () {
            const fixtureReservations = yield* db
              .select({
                userId: salvoCanaryBudgetReservations.userId,
                status: salvoCanaryBudgetReservations.status,
                reservedMicros: salvoCanaryBudgetReservations.reservedMicros,
                actualMicros: salvoCanaryBudgetReservations.actualMicros,
              })
              .from(salvoCanaryBudgetReservations)
              .where(inArray(salvoCanaryBudgetReservations.userId, [...request.fixtures.userIds]));
            const allReservations = yield* db
              .select({
                status: salvoCanaryBudgetReservations.status,
                reservedMicros: salvoCanaryBudgetReservations.reservedMicros,
                actualMicros: salvoCanaryBudgetReservations.actualMicros,
              })
              .from(salvoCanaryBudgetReservations);
            const controls = yield* db
              .select({
                stopped: salvoCanaryBudgetControl.stopped,
                billedMicros: salvoCanaryBudgetControl.authoritativeBilledMicros,
              })
              .from(salvoCanaryBudgetControl)
              .where(eq(salvoCanaryBudgetControl.singleton, 1))
              .limit(1);
            const audits = yield* db
              .select({ reason: salvoSponsoredInferenceAudits.reason })
              .from(salvoSponsoredInferenceAudits)
              .where(inArray(salvoSponsoredInferenceAudits.userId, [...request.fixtures.userIds]));
            const control = controls[0];
            const providerUsage = yield* authoritativeReader.read().pipe(
              Effect.map((readings) =>
                readings.map(
                  (reading) =>
                    ({
                      provider: reading.provider,
                      source: reading.source,
                      authoritative: true,
                      billedMicros: reading.billedMicros,
                      observedAt: new Date(reading.observedAtMs).toISOString(),
                    }) satisfies ProviderUsage,
                ),
              ),
              Effect.orElseSucceed(
                () =>
                  [
                    {
                      provider: "aws",
                      source: "unavailable",
                      authoritative: false,
                      billedMicros: null,
                      observedAt: null,
                    },
                    {
                      provider: "openai",
                      source: "unavailable",
                      authoritative: false,
                      billedMicros: null,
                      observedAt: null,
                    },
                  ] satisfies readonly ProviderUsage[],
              ),
            );
            const liability = (entry: {
              status: "active" | "settled" | "released";
              reservedMicros: number;
              actualMicros: number | null;
            }) =>
              entry.status === "released"
                ? 0
                : entry.status === "settled"
                  ? (entry.actualMicros ?? entry.reservedMicros)
                  : entry.reservedMicros;
            return {
              configuredPilotCapMicros: options.pilotCapMicros,
              stopped: control?.stopped ?? null,
              reservedMicros: allReservations.reduce((sum, entry) => sum + liability(entry), 0),
              billedMicros: control?.billedMicros ?? 0,
              fixtureUsersObserved: new Set(fixtureReservations.map((entry) => entry.userId)).size,
              fixtureRunningReservedMicros: fixtureReservations
                .filter((entry) => entry.status === "active")
                .reduce((sum, entry) => sum + entry.reservedMicros, 0),
              fixtureUserReservedMicros: fixtureReservations.reduce(
                (sum, entry) => sum + liability(entry),
                0,
              ),
              conflictingReplayDenials: audits.filter(
                (entry) => entry.reason === "conflicting_replay",
              ).length,
              budgetDenials: audits.filter((entry) => entry.reason === "budget_denied").length,
              providerUsage,
            } satisfies BudgetSnapshot;
          }).pipe(
            Effect.mapError(
              (cause) => new GauntletProbeLiveError({ operation: "read-budget", cause }),
            ),
          ),
      });
    }),
  );
