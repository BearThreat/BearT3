import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostedSandboxProvider } from "./HostedSandboxProvider.ts";
import { HostedSandboxRepository } from "./HostedSandboxRepository.ts";
import { SandboxBootstrapCredentials } from "./SandboxBootstrapTokens.ts";

export class HostedSandboxControlRotation extends Context.Service<
  HostedSandboxControlRotation,
  {
    readonly sweep: (input?: {
      readonly refreshBeforeMs?: number;
      readonly limit?: number;
    }) => Effect.Effect<{ scanned: number; refreshed: number; failed: number }>;
  }
>()("t3code-relay/hostedSandboxes/HostedSandboxControlRotation") {}

export const layer = Layer.effect(
  HostedSandboxControlRotation,
  Effect.gen(function* () {
    const credentials = yield* SandboxBootstrapCredentials;
    const provider = yield* HostedSandboxProvider;
    const repository = yield* HostedSandboxRepository;
    return HostedSandboxControlRotation.of({
      sweep: (input = {}) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const refreshBeforeMs = Math.min(
            Math.max(input.refreshBeforeMs ?? 60 * 60_000, 5 * 60_000),
            4 * 60 * 60_000,
          );
          const candidates = yield* credentials
            .listExpiring({
              cutoff: DateTime.formatIso(DateTime.addDuration(now, refreshBeforeMs)),
              limit: input.limit ?? 25,
            })
            .pipe(Effect.orDie);
          let refreshed = 0;
          let failed = 0;
          for (const sandbox of candidates) {
            const result = yield* provider
              .refreshControl(sandbox)
              .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
            const at = DateTime.formatIso(yield* DateTime.now);
            yield* repository
              .appendLifecycleHistory({
                eventId: `control-refresh-${sandbox.sandboxId}-${Date.parse(at)}`.slice(0, 64),
                sandboxId: sandbox.sandboxId,
                userId: sandbox.userId,
                event: result ? "control-refreshed" : "control-refresh-failed",
                detail: result
                  ? "fresh one-time bootstrap delivered through SSM"
                  : "sandbox removed from ready service until reconciliation",
                createdAt: at,
              })
              .pipe(Effect.orDie);
            if (result) refreshed++;
            else {
              failed++;
              yield* repository
                .update({
                  userId: sandbox.userId,
                  sandboxId: sandbox.sandboxId,
                  status: "failed",
                  endpoint: null,
                  updatedAt: at,
                })
                .pipe(Effect.orDie);
            }
          }
          return { scanned: candidates.length, refreshed, failed };
        }),
    });
  }),
);
