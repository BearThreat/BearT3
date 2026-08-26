import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const gateChecks = {
  "instant-onboarding": [
    "fresh-invite",
    "cached-image-boot",
    "first-turn",
    "invite-race",
    "network-recovery",
    "operator-only-fixtures",
  ],
  "credential-containment": ["browser-scan", "sandbox-scan", "hostile-repository", "revocation"],
  "shared-codex-engine": [
    "session-home-isolation",
    "cross-thread-resume-denial",
    "concurrent-attribution",
    "fair-admission",
    "rate-limit-containment",
    "auth-expiry",
    "token-rotation",
    "provider-outage-recovery",
    "active-stop",
    "reboot-stop-persistence",
  ],
  "user-isolation": [
    "authorization-matrix",
    "filesystem-escape",
    "network-boundary",
    "concurrency",
    "meshcentral-route-boundary",
    "sandbox-to-sandbox-denial",
    "trust-plane-inventory",
    "personal-route-absence",
    "personal-credential-absence",
  ],
  "skill-release": ["bundle-signature", "version-hash", "interrupted-update", "rollback"],
  persistence: ["normal-resume", "forced-termination", "interrupted-turn", "snapshot-reset"],
  "issue-reporting": ["surface-reachability", "consent", "delivery-retry", "operator-reply"],
  "operator-control": [
    "per-user-stop",
    "global-stop",
    "restart-persistence",
    "scoped-recovery",
    "provider-compute-state",
    "dns-change-absent",
  ],
  "budget-caps": [
    "atomic-reservation",
    "replay",
    "resource-abuse",
    "pilot-hard-stop",
    "independent-billable-resource-query",
  ],
  "mobile-ux": ["android-flow", "ios-flow", "reconnect", "accessibility"],
} as const;

export type Gate = keyof typeof gateChecks;
export type ProbeMode = "clean" | "forced-failure";
export type Fixtures = {
  readonly userIds: readonly [string, string];
  readonly sandboxIds: readonly [string, string];
};
export type ProbeRequest = {
  readonly gate: Gate;
  readonly pass: ProbeMode;
  readonly scenarioId: string;
  readonly nonce: string;
  readonly fixtures: Fixtures;
  readonly forcedFailure: boolean;
};
export type BoundProbeRequest = ProbeRequest & {
  readonly sourceRevision: string;
  readonly runtimeImageId: string;
  readonly skillReleaseHash: string;
  readonly infrastructurePlanHash: string;
  readonly gauntletSpecHash: string;
  readonly evidenceCollectorId: string;
};
export type ProbeObservation = {
  readonly checkId: string;
  readonly result: "pass" | "fail" | "inconclusive";
  readonly observationId?: string;
};
export type AdapterReport = {
  readonly observations: readonly ProbeObservation[];
  readonly metrics: Readonly<Record<string, unknown>>;
  readonly failureInjected: boolean;
  readonly recoveryVerified: boolean;
  readonly requestId?: string;
};

/**
 * Adapter boundary for real staging scenarios. reserveFresh must be durable and atomic:
 * a nonce or fixture set may be consumed only once for a deployment revision.
 */
export interface DeterministicProbeAdapter {
  readonly gates: ReadonlySet<Gate>;
  readonly reserveFresh: (request: BoundProbeRequest) => Effect.Effect<boolean, Error>;
  readonly run: (request: BoundProbeRequest) => Effect.Effect<AdapterReport, Error>;
}

export class GauntletProbeAdapter extends Context.Service<
  GauntletProbeAdapter,
  DeterministicProbeAdapter
>()("t3code-relay/gauntlet/GauntletProbe/GauntletProbeAdapter") {}

/** Mounted safely before real scenario adapters exist: it advertises no runnable gates. */
export const layerUnavailable = Layer.succeed(
  GauntletProbeAdapter,
  GauntletProbeAdapter.of({
    gates: new Set(),
    reserveFresh: () => Effect.succeed(false),
    run: () => Effect.die("gauntlet_probe_unavailable"),
  }),
);

export type ProbeConfiguration = {
  readonly enabled: boolean;
  readonly token: string;
  readonly origin: string;
  readonly sourceRevision: string;
  readonly runtimeImageId: string;
  readonly skillReleaseHash: string;
  readonly infrastructurePlanHash: string;
  readonly gauntletSpecHash: string;
  readonly evidenceCollectorId: string;
  readonly productionEquivalent: boolean;
};

export type ProbeResponse = {
  readonly status: 200 | 400 | 404;
  readonly body: Readonly<Record<string, unknown>>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const fixture = /^[a-z0-9][a-z0-9-]{3,127}$/u;

export const validateConfiguration = (configuration: ProbeConfiguration) =>
  configuration.enabled &&
  configuration.token.length >= 32 &&
  configuration.origin === "https://salvo.barrettvelker.com" &&
  /^[a-zA-Z0-9._-]{7,128}$/u.test(configuration.sourceRevision) &&
  /^[a-zA-Z0-9._:/-]{3,256}$/u.test(configuration.runtimeImageId) &&
  [
    configuration.skillReleaseHash,
    configuration.infrastructurePlanHash,
    configuration.gauntletSpecHash,
  ].every((value) => /^[a-f0-9]{64}$/u.test(value)) &&
  /^[a-z0-9][a-z0-9._:-]{1,127}$/u.test(configuration.evidenceCollectorId);

export const candidateTuple = (configuration: ProbeConfiguration) => ({
  sourceRevision: configuration.sourceRevision,
  runtimeImageId: configuration.runtimeImageId,
  skillReleaseHash: configuration.skillReleaseHash,
  infrastructurePlanHash: configuration.infrastructurePlanHash,
  gauntletSpecHash: configuration.gauntletSpecHash,
  evidenceCollectorId: configuration.evidenceCollectorId,
});

const inconclusive = (
  request: ProbeRequest,
  configuration: ProbeConfiguration,
  reason: string,
): ProbeResponse => ({
  status: 200,
  body: {
    version: 1,
    gate: request.gate,
    pass: request.pass,
    scenarioId: request.scenarioId,
    nonce: request.nonce,
    fixtures: request.fixtures,
    candidate: candidateTuple(configuration),
    result: "inconclusive",
    reason,
    failureInjected: false,
    recoveryVerified: false,
    metrics: {},
    checks: gateChecks[request.gate].map((id) => ({
      id,
      result: "inconclusive",
      scenarioId: request.scenarioId,
    })),
  },
});

export const parseProbeRequest = (gateParameter: string, value: unknown): ProbeRequest | null => {
  if (!(gateParameter in gateChecks) || !value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const gate = gateParameter as Gate;
  const pass = input.pass;
  const scenarioId = input.scenarioId;
  const nonce = input.nonce;
  const fixtures = input.fixtures as Record<string, unknown> | undefined;
  if (
    input.version !== 1 ||
    input.gate !== gate ||
    (pass !== "clean" && pass !== "forced-failure") ||
    typeof scenarioId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{7,95}$/u.test(scenarioId) ||
    typeof nonce !== "string" ||
    !uuid.test(nonce) ||
    input.forcedFailure !== (pass === "forced-failure") ||
    !fixtures ||
    !Array.isArray(fixtures.userIds) ||
    !Array.isArray(fixtures.sandboxIds) ||
    fixtures.userIds.length !== 2 ||
    fixtures.sandboxIds.length !== 2
  )
    return null;
  const identifiers = [...fixtures.userIds, ...fixtures.sandboxIds];
  if (
    !identifiers.every(
      (id) => typeof id === "string" && fixture.test(id) && id.includes(scenarioId),
    ) ||
    new Set(identifiers).size !== 4
  )
    return null;
  return {
    gate,
    pass,
    scenarioId,
    nonce,
    forcedFailure: input.forcedFailure,
    fixtures: {
      userIds: fixtures.userIds as [string, string],
      sandboxIds: fixtures.sandboxIds as [string, string],
    },
  };
};

export const executeProbe = (configuration: ProbeConfiguration, request: ProbeRequest) =>
  Effect.gen(function* () {
    const adapter = yield* GauntletProbeAdapter;
    if (!adapter.gates.has(request.gate))
      return inconclusive(request, configuration, "probe_adapter_unavailable");
    const boundRequest = { ...request, ...candidateTuple(configuration) };
    const fresh = yield* adapter.reserveFresh(boundRequest);
    if (!fresh) return inconclusive(request, configuration, "nonce_or_fixtures_already_consumed");
    const report = yield* adapter.run(boundRequest);
    const required = gateChecks[request.gate];
    const observations = new Map(
      report.observations.map((observation) => [observation.checkId, observation]),
    );
    const checks = required.map((id) => {
      const observation = observations.get(id);
      const observationBound =
        observation?.result !== "pass" ||
        (typeof observation.observationId === "string" && observation.observationId.length >= 8);
      return {
        id,
        result: observation && observationBound ? observation.result : "inconclusive",
        ...(observation?.observationId && observationBound
          ? { observationId: observation.observationId }
          : {}),
        scenarioId: request.scenarioId,
      };
    });
    const forcedFailureVerified =
      request.pass === "clean" || (report.failureInjected && report.recoveryVerified);
    return {
      status: 200,
      body: {
        version: 1,
        gate: request.gate,
        pass: request.pass,
        scenarioId: request.scenarioId,
        nonce: request.nonce,
        fixtures: request.fixtures,
        candidate: candidateTuple(configuration),
        result:
          checks.every((check) => check.result === "pass") && forcedFailureVerified
            ? "pass"
            : checks.some((check) => check.result === "fail")
              ? "fail"
              : "inconclusive",
        failureInjected: report.failureInjected,
        recoveryVerified: report.recoveryVerified,
        metrics: report.metrics,
        checks,
        ...(report.requestId ? { requestId: report.requestId } : {}),
      },
    } satisfies ProbeResponse;
  }).pipe(
    Effect.orElseSucceed(() => inconclusive(request, configuration, "probe_execution_failed")),
  );
