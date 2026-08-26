import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostedSandboxControlRotation, layer } from "./HostedSandboxControlRotation.ts";
import { HostedSandboxProvider } from "./HostedSandboxProvider.ts";
import { HostedSandboxRepository } from "./HostedSandboxRepository.ts";
import { SandboxBootstrapCredentials } from "./SandboxBootstrapTokens.ts";

const setup = (refreshSucceeds: boolean) => {
  const events: string[] = [];
  const credentials = SandboxBootstrapCredentials.of({
    issue: () => Effect.die("unused"),
    redeem: () => Effect.die("unused"),
    authenticate: () => Effect.succeed(null),
    resolve: () => Effect.succeed(null),
    revoke: () => Effect.succeed({ revoked: 0, tunnelsRetired: 0 }),
    listExpiring: () =>
      Effect.succeed([{ sandboxId: "sandbox-a", userId: "user-a", providerRef: "i-owned" }]),
  });
  const provider = HostedSandboxProvider.of({
    start: () => Effect.die("unused"),
    health: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    sendPrompt: () => Effect.die("unused"),
    refreshControl: () =>
      refreshSucceeds
        ? Effect.succeed({ commandId: "command-a" })
        : Effect.fail({ _tag: "HostedSandboxProviderNotConfigured" } as never),
  });
  const repository = HostedSandboxRepository.of({
    claim: () => Effect.die("unused"),
    claimResume: () => Effect.die("unused"),
    loadOwned: () => Effect.die("unused"),
    provisioningStopped: () => Effect.die("unused"),
    setProvisioningStop: () => Effect.die("unused"),
    claimIdleDrains: () => Effect.die("unused"),
    claimFailedStops: () => Effect.die("unused"),
    enqueuePrompt: () => Effect.die("unused"),
    claimPrompt: () => Effect.die("unused"),
    acceptPrompt: () => Effect.die("unused"),
    lifecycleHistory: () => Effect.succeed([]),
    appendLifecycleHistory: ({ event }) =>
      Effect.sync(() => {
        events.push(event);
      }),
    update: (input) =>
      Effect.sync(() => {
        events.push(`status:${input.status}`);
        return {
          ...input,
          requestId: "request-a",
          providerRef: "i-owned",
          createdAt: input.updatedAt,
          endpoint: null,
        };
      }),
  });
  return {
    events,
    provided: layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(SandboxBootstrapCredentials, credentials),
          Layer.succeed(HostedSandboxProvider, provider),
          Layer.succeed(HostedSandboxRepository, repository),
        ),
      ),
    ),
  };
};

describe("HostedSandboxControlRotation", () => {
  it.effect("refreshes expiring controls and leaves durable history", () => {
    const f = setup(true);
    return Effect.gen(function* () {
      const service = yield* HostedSandboxControlRotation;
      expect(yield* service.sweep()).toEqual({ scanned: 1, refreshed: 1, failed: 0 });
      expect(f.events).toEqual(["control-refreshed"]);
    }).pipe(Effect.provide(f.provided));
  });
  it.effect("removes an unrefreshable sandbox from ready service", () => {
    const f = setup(false);
    return Effect.gen(function* () {
      const service = yield* HostedSandboxControlRotation;
      expect(yield* service.sweep()).toEqual({ scanned: 1, refreshed: 0, failed: 1 });
      expect(f.events).toEqual(["control-refresh-failed", "status:failed"]);
    }).pipe(Effect.provide(f.provided));
  });
});
