import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {
  GauntletProbeAdapter,
  gateChecks,
  type BoundProbeRequest,
  type DeterministicProbeAdapter,
} from "./GauntletProbe.ts";
import { routes } from "./GauntletProbeHttp.ts";

const configuration = {
  enabled: true,
  token: "probe-token-that-is-at-least-32-bytes-long",
  origin: "https://salvo.barrettvelker.com",
  sourceRevision: "revision-20260824",
  runtimeImageId: "ami-salvo-20260824",
  skillReleaseHash: "ab".repeat(32),
  infrastructurePlanHash: "cd".repeat(32),
  gauntletSpecHash: "ef".repeat(32),
  evidenceCollectorId: "salvo-probe.v1",
  productionEquivalent: false,
} as const;
const scenarioId = "invite-20260824-a";
const input = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  gate: "instant-onboarding",
  pass: "clean",
  scenarioId,
  nonce: "d9428888-122b-4ae3-9f1b-37682d8d00e0",
  fixtures: {
    userIds: [`${scenarioId}-user-a`, `${scenarioId}-user-b`],
    sandboxIds: [`${scenarioId}-box-a`, `${scenarioId}-box-b`],
  },
  forcedFailure: false,
  ...overrides,
});

const setup = (adapter: DeterministicProbeAdapter) =>
  HttpRouter.toWebHandler(
    routes(configuration).pipe(Layer.provideMerge(Layer.succeed(GauntletProbeAdapter, adapter))),
    { disableLogger: true },
  );
const request = (body: unknown, token = configuration.token) =>
  new Request("https://relay.test/api/salvo/gauntlet/v1/gates/instant-onboarding", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-salvo-gauntlet-scenario": scenarioId,
    },
    body: JSON.stringify(body),
  });
const passingAdapter = (
  options: { fresh?: boolean; forced?: boolean } = {},
): DeterministicProbeAdapter => ({
  gates: new Set(["instant-onboarding"]),
  reserveFresh: () => Effect.succeed(options.fresh ?? true),
  run: (probe: BoundProbeRequest) =>
    Effect.succeed({
      observations: gateChecks[probe.gate].map((checkId) => ({
        checkId,
        result: "pass" as const,
        observationId: `obs-${checkId}`,
      })),
      metrics: { signupToFirstPromptMs: 12_000, sandboxReadyMs: 8_000, firstTurnSucceeded: true },
      failureInjected: options.forced ?? false,
      recoveryVerified: options.forced ?? false,
      requestId: "probe-request-1",
    }),
});

describe("GauntletProbeHttp", () => {
  it("is absent unless the dedicated probe configuration is complete", async () => {
    const web = HttpRouter.toWebHandler(
      routes({ ...configuration, enabled: false }).pipe(
        Layer.provideMerge(Layer.succeed(GauntletProbeAdapter, passingAdapter())),
      ),
      { disableLogger: true },
    );
    expect(
      (await web.handler(new Request("https://relay.test/api/salvo/gauntlet/v1/capabilities")))
        .status,
    ).toBe(404);
    await web.dispose();
  });

  it("requires the separate bearer and advertises only concrete adapters", async () => {
    const web = setup(passingAdapter());
    const url = "https://relay.test/api/salvo/gauntlet/v1/capabilities";
    expect((await web.handler(new Request(url))).status).toBe(401);
    const response = await web.handler(
      new Request(url, { headers: { authorization: `Bearer ${configuration.token}` } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      productionEquivalent: false,
      productionEquivalentBasis: "not-attested",
      candidate: {
        sourceRevision: configuration.sourceRevision,
        runtimeImageId: configuration.runtimeImageId,
        skillReleaseHash: configuration.skillReleaseHash,
        infrastructurePlanHash: configuration.infrastructurePlanHash,
        gauntletSpecHash: configuration.gauntletSpecHash,
        evidenceCollectorId: configuration.evidenceCollectorId,
      },
      gates: ["instant-onboarding"],
    });
    await web.dispose();
  });

  it("rejects caller-authored pass claims and malformed scenario bindings before running an adapter", async () => {
    let calls = 0;
    const adapter = passingAdapter();
    const web = setup({
      ...adapter,
      run: (probe) => {
        calls += 1;
        return adapter.run(probe);
      },
    });
    const response = await web.handler(
      request(
        input({
          result: "pass",
          checks: [{ id: "fresh-invite", result: "pass" }],
          scenarioId: "wrong-scenario",
        }),
      ),
    );
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
    await web.dispose();
  });

  it("returns only adapter-derived, release-bound observations", async () => {
    let binding: Partial<BoundProbeRequest> = {};
    const adapter = passingAdapter();
    const web = setup({
      ...adapter,
      run: (probe) => {
        binding = probe;
        return adapter.run(probe);
      },
    });
    const response = await web.handler(request(input()));
    const report = (await response.json()) as Record<string, unknown>;
    expect(report).toMatchObject({
      result: "pass",
      scenarioId,
      nonce: input().nonce,
      candidate: {
        sourceRevision: configuration.sourceRevision,
        runtimeImageId: configuration.runtimeImageId,
        skillReleaseHash: configuration.skillReleaseHash,
        infrastructurePlanHash: configuration.infrastructurePlanHash,
        gauntletSpecHash: configuration.gauntletSpecHash,
        evidenceCollectorId: configuration.evidenceCollectorId,
      },
      failureInjected: false,
      recoveryVerified: false,
    });
    expect(
      (report.checks as Array<Record<string, unknown>>).every(
        (check) =>
          check.result === "pass" &&
          check.scenarioId === scenarioId &&
          typeof check.observationId === "string",
      ),
    ).toBe(true);
    expect(binding).toMatchObject({
      sourceRevision: configuration.sourceRevision,
      runtimeImageId: configuration.runtimeImageId,
      skillReleaseHash: configuration.skillReleaseHash,
      infrastructurePlanHash: configuration.infrastructurePlanHash,
      gauntletSpecHash: configuration.gauntletSpecHash,
      evidenceCollectorId: configuration.evidenceCollectorId,
    });
    await web.dispose();
  });

  it("ignores caller-authored result fields instead of treating them as evidence", async () => {
    const web = setup({
      ...passingAdapter(),
      run: (probe) =>
        Effect.succeed({
          observations: gateChecks[probe.gate].map((checkId) => ({
            checkId,
            result: "fail" as const,
            observationId: `obs-${checkId}`,
          })),
          metrics: {},
          failureInjected: false,
          recoveryVerified: false,
        }),
    });
    const response = await web.handler(
      request(
        input({
          result: "pass",
          checks: gateChecks["instant-onboarding"].map((id) => ({ id, result: "pass" })),
        }),
      ),
    );
    expect(await response.json()).toMatchObject({ result: "fail" });
    await web.dispose();
  });

  it("returns inconclusive for replayed fixtures and unverified forced-failure recovery", async () => {
    const replay = setup(passingAdapter({ fresh: false }));
    expect(await (await replay.handler(request(input()))).json()).toMatchObject({
      result: "inconclusive",
      reason: "nonce_or_fixtures_already_consumed",
    });
    await replay.dispose();
    const forced = setup(passingAdapter());
    const forcedInput = input({ pass: "forced-failure", forcedFailure: true });
    expect(await (await forced.handler(request(forcedInput))).json()).toMatchObject({
      result: "inconclusive",
      failureInjected: false,
      recoveryVerified: false,
    });
    await forced.dispose();
  });
});
