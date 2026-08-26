import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  HostedSandboxProvider,
  HostedSandboxProviderFailed,
  layerUnavailable,
} from "./HostedSandboxProvider.ts";
import {
  HostedSandboxRepository,
  type HostedSandboxPersistenceRecord,
  type HostedSandboxPromptRecord,
} from "./HostedSandboxRepository.ts";
import { HostedSandboxNotFound, HostedSandboxes, layer } from "./HostedSandboxes.ts";
import {
  SponsoredInferenceGateway,
  SponsoredInferenceUnavailable,
} from "../sponsoredInference/SponsoredInferenceGateway.ts";
import {
  layerUnavailable as bootstrapUnavailable,
  SandboxBootstrapCredentials,
} from "./SandboxBootstrapTokens.ts";
import {
  CanaryBudgetAuthority,
  CanaryBudgetDenied,
  layerDisabled as canaryBudgetDisabled,
  makeInMemory,
} from "../canary/CanaryBudgetAuthority.ts";

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) =>
      Effect.succeed(new Uint8Array(32).map((_, index) => data[index % data.length] ?? index)),
  }),
);

function memoryRepository(options: { failAcceptOnce?: boolean } = {}) {
  const byUser = new Map<string, HostedSandboxPersistenceRecord>();
  const prompts = new Map<string, HostedSandboxPromptRecord>();
  const stops = new Map<string, boolean>();
  let failAccept = options.failAcceptOnce ?? false;
  return HostedSandboxRepository.of({
    claim: (input) =>
      Effect.sync(() => {
        const existing = byUser.get(input.userId);
        if (existing) return existing;
        byUser.set(input.userId, input);
        return input;
      }),
    loadOwned: ({ userId, sandboxId }) =>
      Effect.sync(() => {
        const record = byUser.get(userId);
        return record?.sandboxId === sandboxId ? record : null;
      }),
    update: (input) =>
      Effect.sync(() => {
        const current = byUser.get(input.userId)!;
        const updated = { ...current, ...input };
        byUser.set(input.userId, updated);
        return updated;
      }),
    claimResume: (input) =>
      Effect.sync(() => {
        const current = byUser.get(input.userId)!;
        const updated = {
          ...current,
          status: "starting" as const,
          endpoint: null,
          updatedAt: input.updatedAt,
        };
        byUser.set(input.userId, updated);
        return updated;
      }),
    provisioningStopped: (userId) =>
      Effect.succeed(stops.get("global") === true || stops.get(`user:${userId}`) === true),
    setProvisioningStop: (input) =>
      Effect.sync(() => {
        const scope = input.userId ? `user:${input.userId}` : "global";
        stops.set(scope, input.stopped);
        return { scope, stopped: input.stopped };
      }),
    claimIdleDrains: () => Effect.succeed([]),
    claimFailedStops: () => Effect.succeed([]),
    appendLifecycleHistory: () => Effect.void,
    lifecycleHistory: () => Effect.succeed([]),
    enqueuePrompt: (input) =>
      Effect.sync(() => {
        const key = `${input.sandboxId}:${input.requestId}`;
        const existing = prompts.get(key);
        if (existing) return existing;
        prompts.set(key, input);
        return input;
      }),
    claimPrompt: (input) =>
      Effect.sync(() => {
        const key = `${input.sandboxId}:${input.requestId}`;
        const current = prompts.get(key)!;
        if (current.status === "accepted") return current;
        if (
          current.status === "dispatching" &&
          current.leaseExpiresAt &&
          current.leaseExpiresAt >= input.now
        )
          return current;
        const claimed = {
          ...current,
          status: "dispatching" as const,
          leaseToken: input.leaseToken,
          leaseExpiresAt: input.leaseExpiresAt,
        };
        prompts.set(key, claimed);
        return claimed;
      }),
    acceptPrompt: (input) =>
      Effect.sync(() => {
        const key = `${input.sandboxId}:${input.requestId}`;
        const current = prompts.get(key)!;
        if (failAccept) {
          failAccept = false;
          prompts.set(key, { ...current, leaseExpiresAt: "1970-01-01T00:00:00.000Z" });
          throw new Error("simulated relay crash before local accept");
        }
        if (current.status !== "dispatching" || current.leaseToken !== input.leaseToken)
          return current;
        const accepted = {
          ...current,
          status: "accepted" as const,
          leaseToken: null,
          leaseExpiresAt: null,
          sandboxExecutionReceiptId: input.sandboxExecutionReceiptId,
          gatewayProviderReceiptId: input.gatewayProviderReceiptId,
          acceptedAt: input.acceptedAt,
        };
        prompts.set(key, accepted);
        return accepted;
      }),
  });
}

function testLayer(
  events: string[],
  repository = memoryRepository(),
  receiptOverrides: {
    requestId?: string;
    sandboxId?: string;
    omitSandboxReceipt?: boolean;
    wrongGrantSandbox?: boolean;
    failStop?: boolean;
  } = {},
  budgetLayer = canaryBudgetDisabled,
) {
  const sandboxReceipts = new Map<
    string,
    {
      requestId: string;
      sandboxId: string;
      sandboxExecutionReceiptId: string;
      gatewayProviderReceiptId: string;
      acceptedAt: string;
    }
  >();
  const gateway = SponsoredInferenceGateway.of({
    issueGrant: ({ userId, sandboxId }) =>
      Effect.succeed({
        token: `grant:${userId}:${sandboxId}`,
        userId,
        sandboxId: receiptOverrides.wrongGrantSandbox ? "sandbox-wrong" : sandboxId,
        expiresAtMs: 1_777_000_060_000,
      }),
    execute: ({ grant, userId, sandboxId, requestId, prompt }) => {
      if (
        grant.userId !== userId ||
        grant.sandboxId !== sandboxId ||
        grant.token !== `grant:${userId}:${sandboxId}`
      )
        return Effect.fail(new SponsoredInferenceUnavailable({ code: "invalid_grant" }));
      return Effect.sync(() => {
        events.push(`gateway:${userId}:${sandboxId}:${requestId}:${prompt}`);
        return {
          requestId,
          providerReceiptId: `gateway-${requestId}`,
          acceptedAt: "2026-08-24T12:00:00.000Z",
        };
      });
    },
  });
  const provider = HostedSandboxProvider.of({
    start: ({ sandboxId }) =>
      Effect.sync(() => {
        events.push(`start:${sandboxId}`);
        return { providerRef: "fake-instance-1" };
      }),
    health: ({ sandboxId }) =>
      Effect.sync(() => {
        events.push(`health:${sandboxId}`);
        return { ready: true, endpoint: "https://sandbox.example.test" };
      }),
    stop: ({ sandboxId }) =>
      receiptOverrides.failStop
        ? Effect.fail(
            new HostedSandboxProviderFailed({ operation: "stop", cause: "simulated stop failure" }),
          )
        : Effect.sync(() => {
            events.push(`stop:${sandboxId}`);
          }),
    refreshControl: () => Effect.succeed({ commandId: "command-1" }),
    sendPrompt: ({ sandboxId, userId, requestId, prompt, inferenceGrant }) =>
      Effect.gen(function* () {
        const existing = sandboxReceipts.get(requestId);
        if (existing) return existing;
        events.push(`sandbox:${sandboxId}:${requestId}:${prompt}`);
        const gatewayReceipt = yield* gateway
          .execute({ grant: inferenceGrant, userId, sandboxId, requestId, prompt })
          .pipe(
            Effect.mapError(
              (cause) => new HostedSandboxProviderFailed({ operation: "send-prompt", cause }),
            ),
          );
        const receipt = {
          requestId: receiptOverrides.requestId ?? requestId,
          sandboxId: receiptOverrides.sandboxId ?? sandboxId,
          sandboxExecutionReceiptId: receiptOverrides.omitSandboxReceipt
            ? ""
            : `sandbox-${sandboxId}-${requestId}`,
          gatewayProviderReceiptId: gatewayReceipt.providerReceiptId!,
          acceptedAt: gatewayReceipt.acceptedAt!,
        };
        sandboxReceipts.set(requestId, receipt);
        return receipt;
      }),
  });
  const bootstrap = SandboxBootstrapCredentials.of({
    issue: () => Effect.die("unused"),
    redeem: () => Effect.die("unused"),
    authenticate: () => Effect.succeed(null),
    resolve: () => Effect.succeed(null),
    revoke: ({ sandboxId, reason }) =>
      Effect.sync(() => {
        events.push(`revoke:${sandboxId}:${reason}`);
        return { revoked: 1, tunnelsRetired: 1 };
      }),
    listExpiring: () => Effect.succeed([]),
  });
  return layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        cryptoLayer,
        Layer.succeed(HostedSandboxRepository, repository),
        Layer.succeed(HostedSandboxProvider, provider),
        Layer.succeed(SponsoredInferenceGateway, gateway),
        budgetLayer,
        Layer.succeed(SandboxBootstrapCredentials, bootstrap),
      ),
    ),
  );
}

describe("Salvo hosted sandbox lifecycle", () => {
  it.effect(
    "does not start provider compute when the shared authority denies a paid request",
    () => {
      const now = 1_777_000_000_000;
      const cases = [
        makeInMemory({
          nowMs: () => now,
          operatorUserIds: new Set(["operator"]),
          readAuthoritative: () =>
            Effect.fail(new CanaryBudgetDenied({ code: "authoritative_unavailable" })),
        }),
        makeInMemory({
          nowMs: () => now,
          operatorUserIds: new Set(["operator"]),
          readAuthoritative: () =>
            Effect.succeed([
              {
                provider: "aws" as const,
                billedMicros: 0,
                observedAtMs: now - 300_001,
                source: "aws",
              },
              {
                provider: "openai" as const,
                billedMicros: 0,
                observedAtMs: now - 300_001,
                source: "openai",
              },
            ]),
        }),
        makeInMemory({
          nowMs: () => now,
          operatorUserIds: new Set(["operator"]),
          readAuthoritative: () =>
            Effect.succeed([
              { provider: "aws" as const, billedMicros: 0, observedAtMs: now, source: "aws" },
              { provider: "openai" as const, billedMicros: 0, observedAtMs: now, source: "openai" },
            ]),
        }),
        makeInMemory({
          nowMs: () => now,
          capMicros: 1_000_000,
          operatorUserIds: new Set(["user-a"]),
          readAuthoritative: () =>
            Effect.succeed([
              { provider: "aws" as const, billedMicros: 0, observedAtMs: now, source: "aws" },
              { provider: "openai" as const, billedMicros: 0, observedAtMs: now, source: "openai" },
            ]),
        }),
      ];
      return Effect.forEach(cases, (budget, index) => {
        const events: string[] = [];
        const userId = index === 2 ? "user-a" : index < 2 ? "operator" : "user-a";
        return Effect.gen(function* () {
          const sandboxes = yield* HostedSandboxes;
          yield* Effect.flip(sandboxes.start({ userId, requestId: `denied-${index}` }));
          expect(events.some((event) => event.startsWith("start:"))).toBe(false);
        }).pipe(
          Effect.provide(
            testLayer(
              events,
              memoryRepository(),
              {},
              Layer.succeed(CanaryBudgetAuthority, budget.service),
            ),
          ),
        );
      });
    },
  );

  it.effect("starts, verifies health, and replays without a second provider start", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const sandboxes = yield* HostedSandboxes;
      const first = yield* sandboxes.start({ userId: "user-a", requestId: "request-1" });
      const replay = yield* sandboxes.start({ userId: "user-a", requestId: "request-1" });
      expect(first).toMatchObject({ status: "ready", endpoint: "https://sandbox.example.test" });
      expect(replay).toEqual(first);
      expect(events).toEqual([`start:${first.sandboxId}`, `health:${first.sandboxId}`]);
    }).pipe(Effect.provide(testLayer(events)));
  });

  it.effect("delivers an owned prompt exactly once and denies another user", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const sandboxes = yield* HostedSandboxes;
      const created = yield* sandboxes.start({ userId: "user-a", requestId: "start-1" });
      const input = {
        userId: "user-a",
        sandboxId: created.sandboxId,
        requestId: "prompt-1",
        prompt: "Help me",
      };
      const first = yield* sandboxes.sendPrompt(input);
      const replay = yield* sandboxes.sendPrompt(input);
      expect(replay).toEqual(first);
      expect(events).toEqual([
        `start:${created.sandboxId}`,
        `health:${created.sandboxId}`,
        `sandbox:${created.sandboxId}:prompt-1:Help me`,
        `gateway:user-a:${created.sandboxId}:prompt-1:Help me`,
      ]);
      const denied = yield* Effect.flip(
        sandboxes.sendPrompt({ ...input, userId: "user-b", requestId: "prompt-2" }),
      );
      expect(denied).toBeInstanceOf(HostedSandboxNotFound);
    }).pipe(Effect.provide(testLayer(events)));
  });

  it.effect(
    "reclaims a crashed delivery and accepts the provider's original idempotent receipt",
    () => {
      const events: string[] = [];
      const repository = memoryRepository({ failAcceptOnce: true });
      return Effect.gen(function* () {
        const sandboxes = yield* HostedSandboxes;
        const created = yield* sandboxes.start({ userId: "user-a", requestId: "start-1" });
        const input = {
          userId: "user-a",
          sandboxId: created.sandboxId,
          requestId: "prompt-crash",
          prompt: "Only run once",
        };
        yield* Effect.exit(sandboxes.sendPrompt(input));
        const replay = yield* sandboxes.sendPrompt(input);
        expect(replay).toMatchObject({
          requestId: "prompt-crash",
          sandboxExecutionReceiptId: `sandbox-${created.sandboxId}-prompt-crash`,
          gatewayProviderReceiptId: "gateway-prompt-crash",
        });
        expect(
          events.filter(
            (event) => event.startsWith("sandbox:") && event.includes(":prompt-crash:"),
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) => event.startsWith("gateway:") && event.includes(":prompt-crash:"),
          ),
        ).toHaveLength(1);
      }).pipe(Effect.provide(testLayer(events, repository)));
    },
  );

  it.effect("allows only one concurrent lease and reclaims it after expiry", () => {
    const repository = memoryRepository();
    const base: HostedSandboxPromptRecord = {
      sandboxId: "sandbox-1",
      requestId: "prompt-1",
      userId: "user-a",
      prompt: "hello",
      status: "pending",
      leaseToken: null,
      leaseExpiresAt: null,
      sandboxExecutionReceiptId: null,
      gatewayProviderReceiptId: null,
      acceptedAt: null,
      createdAt: "2026-08-24T12:00:00.000Z",
    };
    return Effect.gen(function* () {
      yield* repository.enqueuePrompt(base);
      const first = yield* repository.claimPrompt({
        sandboxId: base.sandboxId,
        requestId: base.requestId,
        leaseToken: "lease-a",
        now: "2026-08-24T12:00:00.000Z",
        leaseExpiresAt: "2026-08-24T12:00:30.000Z",
      });
      const raced = yield* repository.claimPrompt({
        sandboxId: base.sandboxId,
        requestId: base.requestId,
        leaseToken: "lease-b",
        now: "2026-08-24T12:00:01.000Z",
        leaseExpiresAt: "2026-08-24T12:00:31.000Z",
      });
      const reclaimed = yield* repository.claimPrompt({
        sandboxId: base.sandboxId,
        requestId: base.requestId,
        leaseToken: "lease-c",
        now: "2026-08-24T12:00:31.000Z",
        leaseExpiresAt: "2026-08-24T12:01:01.000Z",
      });
      expect(first.leaseToken).toBe("lease-a");
      expect(raced.leaseToken).toBe("lease-a");
      expect(reclaimed.leaseToken).toBe("lease-c");
    });
  });

  it.effect("rejects a conflicting replay without another provider execution", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const sandboxes = yield* HostedSandboxes;
      const created = yield* sandboxes.start({ userId: "user-a", requestId: "start-1" });
      yield* sandboxes.sendPrompt({
        userId: "user-a",
        sandboxId: created.sandboxId,
        requestId: "prompt-1",
        prompt: "first",
      });
      const conflict = yield* Effect.flip(
        sandboxes.sendPrompt({
          userId: "user-a",
          sandboxId: created.sandboxId,
          requestId: "prompt-1",
          prompt: "changed",
        }),
      );
      expect((conflict as { cause?: unknown }).cause).toBe("conflicting request replay");
      expect(
        events.filter((event) => event.startsWith("sandbox:") && event.includes(":prompt-1:")),
      ).toHaveLength(1);
    }).pipe(Effect.provide(testLayer(events)));
  });

  it.effect("rejects a provider receipt that is not bound to the dispatched requestId", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const sandboxes = yield* HostedSandboxes;
      const created = yield* sandboxes.start({ userId: "user-a", requestId: "start-1" });
      const error = yield* Effect.flip(
        sandboxes.sendPrompt({
          userId: "user-a",
          sandboxId: created.sandboxId,
          requestId: "prompt-1",
          prompt: "hello",
        }),
      );
      expect((error as { cause?: unknown }).cause).toBe("sandbox receipt binding mismatch");
    }).pipe(Effect.provide(testLayer(events, memoryRepository(), { requestId: "wrong-request" })));
  });

  it.effect("rejects a gateway-only response without a sandbox execution receipt", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const sandboxes = yield* HostedSandboxes;
      const created = yield* sandboxes.start({ userId: "user-a", requestId: "start-1" });
      const error = yield* Effect.flip(
        sandboxes.sendPrompt({
          userId: "user-a",
          sandboxId: created.sandboxId,
          requestId: "prompt-1",
          prompt: "hello",
        }),
      );
      expect((error as { cause?: unknown }).cause).toBe("sandbox execution receipt is incomplete");
    }).pipe(Effect.provide(testLayer(events, memoryRepository(), { omitSandboxReceipt: true })));
  });

  it.effect("rejects a sandbox receipt bound to another sandbox", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const sandboxes = yield* HostedSandboxes;
      const created = yield* sandboxes.start({ userId: "user-a", requestId: "start-1" });
      const error = yield* Effect.flip(
        sandboxes.sendPrompt({
          userId: "user-a",
          sandboxId: created.sandboxId,
          requestId: "prompt-1",
          prompt: "hello",
        }),
      );
      expect((error as { cause?: unknown }).cause).toBe("sandbox receipt binding mismatch");
    }).pipe(Effect.provide(testLayer(events, memoryRepository(), { sandboxId: "sandbox-wrong" })));
  });

  it.effect("rejects a grant bound to another sandbox before gateway inference", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const sandboxes = yield* HostedSandboxes;
      const created = yield* sandboxes.start({ userId: "user-a", requestId: "start-1" });
      const error = yield* Effect.flip(
        sandboxes.sendPrompt({
          userId: "user-a",
          sandboxId: created.sandboxId,
          requestId: "prompt-1",
          prompt: "hello",
        }),
      );
      expect((error as { _tag?: string })._tag).toBe("HostedSandboxProviderFailed");
      expect(events.some((event) => event.startsWith("gateway:"))).toBe(false);
    }).pipe(Effect.provide(testLayer(events, memoryRepository(), { wrongGrantSandbox: true })));
  });

  it.effect("denies cross-user status reads", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const sandboxes = yield* HostedSandboxes;
      const created = yield* sandboxes.start({ userId: "user-a", requestId: "request-1" });
      const error = yield* Effect.flip(
        sandboxes.status({ userId: "user-b", sandboxId: created.sandboxId }),
      );
      expect(error).toBeInstanceOf(HostedSandboxNotFound);
    }).pipe(Effect.provide(testLayer(events)));
  });

  it.effect("stops an owned sandbox idempotently and records stopped state", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const sandboxes = yield* HostedSandboxes;
      const created = yield* sandboxes.start({ userId: "user-a", requestId: "request-1" });
      expect(
        (yield* sandboxes.stop({ userId: "user-a", sandboxId: created.sandboxId })).status,
      ).toBe("stopped");
      expect(
        (yield* sandboxes.stop({ userId: "user-a", sandboxId: created.sandboxId })).status,
      ).toBe("stopped");
      expect(events.filter((event) => event.startsWith("stop:"))).toHaveLength(1);
      expect(events.slice(-2)).toEqual([
        `revoke:${created.sandboxId}:stop`,
        `stop:${created.sandboxId}`,
      ]);
    }).pipe(Effect.provide(testLayer(events)));
  });

  it.effect("marks a revoked sandbox failed when infrastructure stop fails", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const sandboxes = yield* HostedSandboxes;
      const created = yield* sandboxes.start({ userId: "user-a", requestId: "request-1" });
      yield* Effect.flip(sandboxes.stop({ userId: "user-a", sandboxId: created.sandboxId }));
      expect(
        (yield* sandboxes.status({ userId: "user-a", sandboxId: created.sandboxId })).status,
      ).toBe("failed");
      expect(events).toContain(`revoke:${created.sandboxId}:stop`);
    }).pipe(Effect.provide(testLayer(events, memoryRepository(), { failStop: true })));
  });

  it.effect("enforces idempotent global and per-user provisioning stops", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const sandboxes = yield* HostedSandboxes;
      yield* sandboxes.setProvisioningStop({
        requestId: "stop-1",
        operatorUserId: "operator",
        userId: "user-a",
        stopped: true,
      });
      expect(
        (
          (yield* Effect.flip(sandboxes.start({ userId: "user-a", requestId: "request-a" }))) as {
            cause?: unknown;
          }
        ).cause,
      ).toBe("provisioning is stopped");
      yield* sandboxes.setProvisioningStop({
        requestId: "resume-1",
        operatorUserId: "operator",
        userId: "user-a",
        stopped: false,
      });
      expect((yield* sandboxes.start({ userId: "user-a", requestId: "request-a" })).status).toBe(
        "ready",
      );
      yield* sandboxes.setProvisioningStop({
        requestId: "global-1",
        operatorUserId: "operator",
        userId: null,
        stopped: true,
      });
      expect(
        (
          (yield* Effect.flip(sandboxes.start({ userId: "user-b", requestId: "request-b" }))) as {
            cause?: unknown;
          }
        ).cause,
      ).toBe("provisioning is stopped");
    }).pipe(Effect.provide(testLayer(events)));
  });

  it.effect("fails closed when no infrastructure provider is installed", () =>
    Effect.gen(function* () {
      const sandboxes = yield* HostedSandboxes;
      const error = yield* Effect.flip(
        sandboxes.start({ userId: "user-a", requestId: "request-1" }),
      );
      expect((error as { _tag?: string })._tag).toBe("HostedSandboxProviderNotConfigured");
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              cryptoLayer,
              Layer.succeed(HostedSandboxRepository, memoryRepository()),
              layerUnavailable,
              Layer.succeed(
                SponsoredInferenceGateway,
                SponsoredInferenceGateway.of({
                  issueGrant: () => Effect.die("unused"),
                  execute: () => Effect.die("unused"),
                }),
              ),
              canaryBudgetDisabled,
              bootstrapUnavailable,
            ),
          ),
        ),
      ),
    ),
  );
});
