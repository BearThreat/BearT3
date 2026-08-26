import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  AwsSandboxLifecycleClient,
  awsHostedSandboxConfigFromEnv,
  type AwsSandboxInstance,
  layerAws,
  selectHostedSandboxProviderLayer,
} from "./AwsHostedSandboxProvider.ts";
import { HostedSandboxProvider } from "./HostedSandboxProvider.ts";

const config = {
  region: "us-east-1",
  promotedImageId: "ami-promoted",
  launchTemplateId: "lt-salvo",
  launchTemplateVersion: "7",
  imageRelease: "salvo-2026-08-24",
  instanceType: "t3.medium",
  subnetId: "subnet-private",
  securityGroupId: "sg-egress-only",
  instanceProfileArn: "arn:aws:iam::123:instance-profile/salvo",
};

function owned(
  state: AwsSandboxInstance["state"],
  overrides: Partial<AwsSandboxInstance> = {},
): AwsSandboxInstance {
  return {
    instanceId: "i-owned",
    state,
    sandboxId: "sandbox-a",
    userId: "user-a",
    imageId: "ami-promoted",
    volume: { volumeId: "vol-owned", encrypted: true, sandboxId: "sandbox-a", userId: "user-a" },
    ...overrides,
  };
}

function fakeClient(
  initial: AwsSandboxInstance | null,
  events: Array<unknown>,
  tunnelReady = true,
) {
  let instance = initial;
  const tokens = new Map<string, string>();
  return AwsSandboxLifecycleClient.of({
    findBySandboxId: () => Effect.sync(() => (instance ? [instance] : [])),
    runInstance: (input) =>
      Effect.sync(() => {
        events.push(["run", input]);
        const existing = tokens.get(input.clientToken);
        if (existing) return { instanceId: existing };
        tokens.set(input.clientToken, "i-new");
        instance = owned("pending", { instanceId: "i-new" });
        return { instanceId: "i-new" };
      }),
    startInstance: ({ instanceId }) =>
      Effect.sync(() => {
        events.push(["start", instanceId]);
        if (instance) instance = { ...instance, state: "pending" };
      }),
    rebootstrapInstance: (input) =>
      Effect.sync(() => {
        events.push(["rebootstrap", input]);
        return { commandId: "command-1" };
      }),
    stopInstance: ({ instanceId, hibernate }) =>
      Effect.sync(() => {
        events.push(["stop", instanceId, hibernate]);
        if (instance) instance = { ...instance, state: "stopped" };
      }),
    tunnelHealth: ({ instanceId }) =>
      Effect.sync(() => {
        events.push(["health", instanceId]);
        return { ready: tunnelReady, endpoint: tunnelReady ? "https://owned.sandbox.test" : null };
      }),
    sendPrompt: (input) =>
      Effect.sync(() => {
        events.push(["prompt", input]);
        return {
          requestId: input.requestId,
          sandboxId: input.sandboxId,
          sandboxExecutionReceiptId: `sandbox-${input.requestId}`,
          gatewayProviderReceiptId: `gateway-${input.requestId}`,
          acceptedAt: "2026-08-24T12:00:00.000Z",
        };
      }),
  });
}

const provide = (client: AwsSandboxLifecycleClient["Service"]) =>
  Effect.provide(
    layerAws(config).pipe(Layer.provide(Layer.succeed(AwsSandboxLifecycleClient, client))),
  );

describe("AWS hosted sandbox provider", () => {
  it.effect(
    "provisions an absent sandbox from the promoted image with a stable client token",
    () => {
      const events: Array<unknown> = [];
      return Effect.gen(function* () {
        const provider = yield* HostedSandboxProvider;
        const first = yield* provider.start({
          sandboxId: "sandbox-a",
          userId: "user-a",
          providerRef: null,
        });
        const replay = yield* provider.start({
          sandboxId: "sandbox-a",
          userId: "user-a",
          providerRef: first.providerRef,
        });
        expect(first).toEqual({ providerRef: "i-new" });
        expect(replay).toEqual(first);
        const runs = events.filter((event) => (event as unknown[])[0] === "run") as Array<
          [string, Record<string, unknown>]
        >;
        expect(runs).toHaveLength(1);
        expect(runs[0]![1]).toMatchObject({
          clientToken: "salvo-sandbox-a",
          imageId: "ami-promoted",
          encryptedVolume: true,
          hibernationPreferred: true,
        });
      }).pipe(provide(fakeClient(null, events)));
    },
  );

  it.effect("uses one AWS idempotency token for concurrent absent-start races", () => {
    const events: Array<unknown> = [];
    const tokens = new Map<string, string>();
    const client = AwsSandboxLifecycleClient.of({
      findBySandboxId: () => Effect.succeed([]),
      runInstance: (input) =>
        Effect.sync(() => {
          events.push(input.clientToken);
          const instanceId = tokens.get(input.clientToken) ?? "i-race-winner";
          tokens.set(input.clientToken, instanceId);
          return { instanceId };
        }),
      startInstance: () => Effect.void,
      rebootstrapInstance: () => Effect.succeed({ commandId: "command-1" }),
      stopInstance: () => Effect.void,
      tunnelHealth: () => Effect.succeed({ ready: false, endpoint: null }),
      sendPrompt: (input) =>
        Effect.succeed({
          requestId: input.requestId,
          sandboxId: input.sandboxId,
          sandboxExecutionReceiptId: `sandbox-${input.requestId}`,
          gatewayProviderReceiptId: `gateway-${input.requestId}`,
          acceptedAt: "2026-08-24T12:00:00.000Z",
        }),
    });
    return Effect.gen(function* () {
      const provider = yield* HostedSandboxProvider;
      const input = { sandboxId: "sandbox-a", userId: "user-a", providerRef: null };
      const results = yield* Effect.all([provider.start(input), provider.start(input)], {
        concurrency: "unbounded",
      });
      expect(results).toEqual([{ providerRef: "i-race-winner" }, { providerRef: "i-race-winner" }]);
      expect(new Set(events)).toEqual(new Set(["salvo-sandbox-a"]));
    }).pipe(provide(client));
  });

  for (const state of ["stopped", "hibernated"] as const) {
    it.effect(`starts an owned ${state} instance`, () => {
      const events: Array<unknown> = [];
      return Effect.gen(function* () {
        const provider = yield* HostedSandboxProvider;
        expect(
          yield* provider.start({
            sandboxId: "sandbox-a",
            userId: "user-a",
            providerRef: "i-owned",
          }),
        ).toEqual({ providerRef: "i-owned" });
        expect(events).toEqual([
          ["start", "i-owned"],
          [
            "rebootstrap",
            {
              instanceId: "i-owned",
              sandboxId: "sandbox-a",
              userId: "user-a",
              clientToken: "salvo-sandbox-a",
            },
          ],
        ]);
      }).pipe(provide(fakeClient(owned(state), events)));
    });
  }

  it.effect("reconciles control on an owned running instance without restarting compute", () => {
    const events: Array<unknown> = [];
    return Effect.gen(function* () {
      const provider = yield* HostedSandboxProvider;
      expect(
        yield* provider.start({ sandboxId: "sandbox-a", userId: "user-a", providerRef: "i-owned" }),
      ).toEqual({ providerRef: "i-owned" });
      expect(events).toEqual([
        [
          "rebootstrap",
          {
            instanceId: "i-owned",
            sandboxId: "sandbox-a",
            userId: "user-a",
            clientToken: "salvo-sandbox-a",
          },
        ],
      ]);
    }).pipe(provide(fakeClient(owned("running"), events)));
  });

  it.effect("rejects instance or EBS ownership mismatch", () => {
    const events: Array<unknown> = [];
    return Effect.gen(function* () {
      const provider = yield* HostedSandboxProvider;
      const error = yield* Effect.flip(
        provider.start({ sandboxId: "sandbox-a", userId: "user-a", providerRef: "i-owned" }),
      );
      expect(error._tag).toBe("HostedSandboxProviderFailed");
      expect(events).toEqual([]);
    }).pipe(
      provide(
        fakeClient(
          owned("stopped", {
            volume: {
              volumeId: "vol-x",
              encrypted: true,
              sandboxId: "sandbox-a",
              userId: "user-b",
            },
          }),
          events,
        ),
      ),
    );
  });

  it.effect("reports readiness only after running state and tunnel health", () => {
    const events: Array<unknown> = [];
    return Effect.gen(function* () {
      const provider = yield* HostedSandboxProvider;
      expect(yield* provider.health({ sandboxId: "sandbox-a", providerRef: "i-owned" })).toEqual({
        ready: true,
        endpoint: "https://owned.sandbox.test",
      });
    }).pipe(provide(fakeClient(owned("running"), events)));
  });

  it.effect("keeps an unhealthy tunnel not ready and refuses prompt delivery", () => {
    const events: Array<unknown> = [];
    return Effect.gen(function* () {
      const provider = yield* HostedSandboxProvider;
      expect(yield* provider.health({ sandboxId: "sandbox-a", providerRef: "i-owned" })).toEqual({
        ready: false,
        endpoint: null,
      });
      const error = yield* Effect.flip(
        provider.sendPrompt({
          sandboxId: "sandbox-a",
          userId: "user-a",
          providerRef: "i-owned",
          requestId: "request-a",
          prompt: "hello",
          inferenceGrant: { token: "grant", userId: "user-a", sandboxId: "sandbox-a" },
        }),
      );
      expect(error._tag).toBe("HostedSandboxProviderFailed");
      expect(events.some((event) => (event as unknown[])[0] === "prompt")).toBe(false);
    }).pipe(provide(fakeClient(owned("running"), events, false)));
  });

  it.effect("fails closed when configuration or the AWS client is absent", () =>
    Effect.gen(function* () {
      const provider = yield* HostedSandboxProvider;
      const error = yield* Effect.flip(
        provider.start({ sandboxId: "sandbox-a", userId: "user-a", providerRef: null }),
      );
      expect(error._tag).toBe("HostedSandboxProviderNotConfigured");
    }).pipe(Effect.provide(selectHostedSandboxProviderLayer({ ...config, promotedImageId: "" }))),
  );

  it("maps deployment environment names without inventing defaults", () => {
    expect(awsHostedSandboxConfigFromEnv({ SALVO_AWS_REGION: "us-east-1" })).toEqual({
      region: "us-east-1",
    });
  });
});
