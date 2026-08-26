import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostedSandboxProvider } from "./HostedSandboxProvider.ts";
import { HostedSandboxRepository } from "./HostedSandboxRepository.ts";
import { SandboxBootstrapCredentials } from "./SandboxBootstrapTokens.ts";

export class HostedSandboxIdleDrain extends Context.Service<
  HostedSandboxIdleDrain,
  {
    readonly sweep: (input: {
      idleBefore: string;
      limit?: number;
    }) => Effect.Effect<{ claimed: number; stopped: number; pending: number }>;
    readonly history: (
      sandboxId: string,
    ) => Effect.Effect<ReadonlyArray<{ event: string; detail: string | null; createdAt: string }>>;
  }
>()("t3code-relay/hostedSandboxes/HostedSandboxIdleDrain") {}

export const layer = Layer.effect(
  HostedSandboxIdleDrain,
  Effect.gen(function* () {
    const repository = yield* HostedSandboxRepository;
    const provider = yield* HostedSandboxProvider;
    const crypto = yield* Crypto.Crypto;
    const bootstrapCredentials = yield* SandboxBootstrapCredentials;
    return HostedSandboxIdleDrain.of({
      history: (sandboxId) => repository.lifecycleHistory(sandboxId).pipe(Effect.orDie),
      sweep: (input) =>
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
          const failedStops = yield* repository
            .claimFailedStops({
              retryBefore: DateTime.formatIso(
                DateTime.subtract(yield* DateTime.now, { minutes: 1 }),
              ),
              now,
              limit,
            })
            .pipe(Effect.orDie);
          const idle =
            failedStops.length >= limit
              ? []
              : yield* repository
                  .claimIdleDrains({
                    idleBefore: input.idleBefore,
                    now,
                    limit: limit - failedStops.length,
                  })
                  .pipe(Effect.orDie);
          const claimed = [...failedStops, ...idle];
          let stopped = 0;
          for (const sandbox of claimed) {
            if (!sandbox.providerRef) continue;
            yield* repository
              .appendLifecycleHistory({
                eventId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
                sandboxId: sandbox.sandboxId,
                userId: sandbox.userId,
                event: "drain-started",
                createdAt: now,
              })
              .pipe(Effect.orDie);
            const revoked = yield* bootstrapCredentials
              .revoke({ sandboxId: sandbox.sandboxId, userId: sandbox.userId, reason: "hibernate" })
              .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
            if (!revoked) continue;
            const result = yield* provider
              .stop({
                sandboxId: sandbox.sandboxId,
                userId: sandbox.userId,
                providerRef: sandbox.providerRef,
              })
              .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
            if (!result) continue;
            const stoppedAt = DateTime.formatIso(yield* DateTime.now);
            yield* repository
              .update({
                userId: sandbox.userId,
                sandboxId: sandbox.sandboxId,
                status: "stopped",
                endpoint: null,
                updatedAt: stoppedAt,
              })
              .pipe(Effect.orDie);
            yield* repository
              .appendLifecycleHistory({
                eventId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
                sandboxId: sandbox.sandboxId,
                userId: sandbox.userId,
                event: "stop-confirmed",
                createdAt: stoppedAt,
              })
              .pipe(Effect.orDie);
            stopped++;
          }
          return { claimed: claimed.length, stopped, pending: claimed.length - stopped };
        }),
    });
  }),
);
