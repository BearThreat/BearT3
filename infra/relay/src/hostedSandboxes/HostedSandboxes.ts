import type {
  RelayHostedSandboxPromptReceipt,
  RelayHostedSandboxRecord,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  HostedSandboxProvider,
  HostedSandboxProviderFailed,
  type HostedSandboxProviderNotConfigured,
} from "./HostedSandboxProvider.ts";
import {
  HostedSandboxRepository,
  HostedSandboxPersistenceError,
  type HostedSandboxPersistenceRecord,
} from "./HostedSandboxRepository.ts";
import {
  SponsoredInferenceGateway,
  type SponsoredInferenceUnavailable,
} from "../sponsoredInference/SponsoredInferenceGateway.ts";
import { SandboxBootstrapCredentials } from "./SandboxBootstrapTokens.ts";
import { CanaryBudgetAuthority } from "../canary/CanaryBudgetAuthority.ts";

export {
  HostedSandboxProviderFailed,
  HostedSandboxProviderNotConfigured,
} from "./HostedSandboxProvider.ts";
export { HostedSandboxPersistenceError } from "./HostedSandboxRepository.ts";

export class HostedSandboxNotFound extends Schema.TaggedErrorClass<HostedSandboxNotFound>()(
  "HostedSandboxNotFound",
  { sandboxId: Schema.String },
) {}

const publicRecord = (record: HostedSandboxPersistenceRecord): RelayHostedSandboxRecord => ({
  sandboxId: record.sandboxId,
  status: record.status,
  endpoint: record.endpoint,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export class HostedSandboxes extends Context.Service<
  HostedSandboxes,
  {
    readonly start: (input: {
      readonly userId: string;
      readonly requestId: string;
    }) => Effect.Effect<
      RelayHostedSandboxRecord,
      | HostedSandboxProviderNotConfigured
      | HostedSandboxProviderFailed
      | HostedSandboxPersistenceError
    >;
    readonly status: (input: {
      readonly userId: string;
      readonly sandboxId: string;
    }) => Effect.Effect<
      RelayHostedSandboxRecord,
      HostedSandboxNotFound | HostedSandboxPersistenceError
    >;
    readonly stop: (input: {
      readonly userId: string;
      readonly sandboxId: string;
    }) => Effect.Effect<
      RelayHostedSandboxRecord,
      | HostedSandboxNotFound
      | HostedSandboxProviderNotConfigured
      | HostedSandboxProviderFailed
      | HostedSandboxPersistenceError
    >;
    readonly setProvisioningStop: (input: {
      requestId: string;
      operatorUserId: string;
      userId: string | null;
      stopped: boolean;
    }) => Effect.Effect<{ scope: string; stopped: boolean }, HostedSandboxPersistenceError>;
    readonly sendPrompt: (input: {
      readonly userId: string;
      readonly sandboxId: string;
      readonly requestId: string;
      readonly prompt: string;
    }) => Effect.Effect<
      RelayHostedSandboxPromptReceipt,
      | HostedSandboxNotFound
      | SponsoredInferenceUnavailable
      | HostedSandboxProviderNotConfigured
      | HostedSandboxProviderFailed
      | HostedSandboxPersistenceError
    >;
  }
>()("t3code-relay/hostedSandboxes/HostedSandboxes") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const repository = yield* HostedSandboxRepository;
  const provider = yield* HostedSandboxProvider;
  const sponsoredInference = yield* SponsoredInferenceGateway;
  const bootstrapCredentials = yield* SandboxBootstrapCredentials;
  const canaryBudget = yield* CanaryBudgetAuthority;

  const status = Effect.fn("salvo.hosted_sandbox.status")(function* (input: {
    userId: string;
    sandboxId: string;
  }) {
    let record = yield* repository.loadOwned(input);
    if (!record) return yield* new HostedSandboxNotFound({ sandboxId: input.sandboxId });
    if (record.status === "starting" && record.providerRef) {
      const now = yield* DateTime.now;
      const timedOut = now.epochMilliseconds - Date.parse(record.createdAt) >= 60_000;
      const health = yield* provider
        .health({ sandboxId: record.sandboxId, providerRef: record.providerRef })
        .pipe(Effect.catch(() => Effect.succeed({ ready: false, endpoint: null })));
      record = yield* repository.update({
        userId: record.userId,
        sandboxId: record.sandboxId,
        status: health.ready ? "ready" : timedOut ? "failed" : "starting",
        endpoint: health.endpoint,
        updatedAt: DateTime.formatIso(now),
      });
      if (record.status === "failed")
        yield* bootstrapCredentials
          .revoke({ sandboxId: record.sandboxId, userId: record.userId, reason: "failed" })
          .pipe(
            Effect.mapError(
              (cause) => new HostedSandboxPersistenceError({ operation: "update", cause }),
            ),
          );
    }
    return publicRecord(record);
  });

  return HostedSandboxes.of({
    status,
    setProvisioningStop: (input) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          repository.setProvisioningStop({ ...input, updatedAt: DateTime.formatIso(now) }),
        ),
      ),
    stop: Effect.fn("salvo.hosted_sandbox.stop")(function* (input) {
      const record = yield* repository.loadOwned(input);
      if (!record) return yield* new HostedSandboxNotFound({ sandboxId: input.sandboxId });
      if (record.status === "stopped") return publicRecord(record);
      if (!record.providerRef)
        return yield* new HostedSandboxProviderFailed({
          operation: "stop",
          cause: "sandbox has no provider reference",
        });
      yield* bootstrapCredentials
        .revoke({ sandboxId: record.sandboxId, userId: record.userId, reason: "stop" })
        .pipe(
          Effect.mapError((cause) => new HostedSandboxProviderFailed({ operation: "stop", cause })),
        );
      yield* provider
        .stop({
          sandboxId: record.sandboxId,
          userId: record.userId,
          providerRef: record.providerRef,
        })
        .pipe(
          Effect.tapError(() =>
            DateTime.now.pipe(
              Effect.flatMap((failedAt) =>
                Effect.all([
                  repository
                    .update({
                      userId: record.userId,
                      sandboxId: record.sandboxId,
                      status: "failed",
                      endpoint: null,
                      updatedAt: DateTime.formatIso(failedAt),
                    })
                    .pipe(Effect.ignore),
                  repository
                    .appendLifecycleHistory({
                      eventId:
                        `stop-failed-${record.sandboxId}-${failedAt.epochMilliseconds}`.slice(
                          0,
                          64,
                        ),
                      sandboxId: record.sandboxId,
                      userId: record.userId,
                      event: "stop-failed",
                      detail: "control-revoked; stop will be retried",
                      createdAt: DateTime.formatIso(failedAt),
                    })
                    .pipe(Effect.ignore),
                ]).pipe(Effect.ignore),
              ),
            ),
          ),
        );
      return publicRecord(
        yield* repository.update({
          userId: record.userId,
          sandboxId: record.sandboxId,
          status: "stopped",
          endpoint: null,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        }),
      );
    }),
    sendPrompt: Effect.fn("salvo.hosted_sandbox.send_prompt")(function* (input) {
      const sandbox = yield* repository.loadOwned(input);
      if (!sandbox) return yield* new HostedSandboxNotFound({ sandboxId: input.sandboxId });
      if (sandbox.status !== "ready" || !sandbox.providerRef) {
        return yield* new HostedSandboxProviderFailed({
          operation: "send-prompt",
          cause: "sandbox is not ready",
        });
      }
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);
      let prompt = yield* repository.enqueuePrompt({
        sandboxId: sandbox.sandboxId,
        requestId: input.requestId,
        userId: input.userId,
        prompt: input.prompt,
        status: "pending",
        leaseToken: null,
        leaseExpiresAt: null,
        sandboxExecutionReceiptId: null,
        gatewayProviderReceiptId: null,
        acceptedAt: null,
        createdAt,
      });
      if (prompt.userId !== input.userId || prompt.prompt !== input.prompt) {
        return yield* new HostedSandboxProviderFailed({
          operation: "send-prompt",
          cause: "conflicting request replay",
        });
      }
      if (
        prompt.status === "accepted" &&
        prompt.acceptedAt &&
        prompt.sandboxExecutionReceiptId &&
        prompt.gatewayProviderReceiptId
      ) {
        return {
          requestId: prompt.requestId,
          sandboxId: prompt.sandboxId,
          sandboxExecutionReceiptId: prompt.sandboxExecutionReceiptId,
          gatewayProviderReceiptId: prompt.gatewayProviderReceiptId,
          acceptedAt: prompt.acceptedAt,
        };
      }
      const leaseToken = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) => new HostedSandboxProviderFailed({ operation: "send-prompt", cause }),
        ),
      );
      prompt = yield* repository.claimPrompt({
        sandboxId: prompt.sandboxId,
        requestId: prompt.requestId,
        leaseToken,
        now: createdAt,
        leaseExpiresAt: DateTime.formatIso(DateTime.addDuration(now, 30_000)),
      });
      if (
        prompt.status === "accepted" &&
        prompt.acceptedAt &&
        prompt.sandboxExecutionReceiptId &&
        prompt.gatewayProviderReceiptId
      ) {
        return {
          requestId: prompt.requestId,
          sandboxId: prompt.sandboxId,
          sandboxExecutionReceiptId: prompt.sandboxExecutionReceiptId,
          gatewayProviderReceiptId: prompt.gatewayProviderReceiptId,
          acceptedAt: prompt.acceptedAt,
        };
      }
      if (prompt.status !== "dispatching" || prompt.leaseToken !== leaseToken) {
        return yield* new HostedSandboxProviderFailed({
          operation: "send-prompt",
          cause: "prompt dispatch is already leased",
        });
      }
      const grant = yield* sponsoredInference.issueGrant({
        userId: input.userId,
        sandboxId: sandbox.sandboxId,
      });
      const receipt = yield* provider.sendPrompt({
        inferenceGrant: grant,
        userId: input.userId,
        sandboxId: sandbox.sandboxId,
        providerRef: sandbox.providerRef,
        requestId: prompt.requestId,
        prompt: prompt.prompt,
      });
      if (receipt.requestId !== prompt.requestId || receipt.sandboxId !== prompt.sandboxId) {
        return yield* new HostedSandboxProviderFailed({
          operation: "send-prompt",
          cause: "sandbox receipt binding mismatch",
        });
      }
      if (
        !receipt.sandboxExecutionReceiptId ||
        !receipt.gatewayProviderReceiptId ||
        !receipt.acceptedAt
      ) {
        return yield* new HostedSandboxProviderFailed({
          operation: "send-prompt",
          cause: "sandbox execution receipt is incomplete",
        });
      }
      const accepted = yield* repository.acceptPrompt({
        sandboxId: prompt.sandboxId,
        requestId: prompt.requestId,
        leaseToken,
        sandboxExecutionReceiptId: receipt.sandboxExecutionReceiptId,
        gatewayProviderReceiptId: receipt.gatewayProviderReceiptId,
        acceptedAt: receipt.acceptedAt,
      });
      if (
        accepted.status !== "accepted" ||
        accepted.requestId !== receipt.requestId ||
        accepted.sandboxId !== receipt.sandboxId ||
        accepted.sandboxExecutionReceiptId !== receipt.sandboxExecutionReceiptId ||
        accepted.gatewayProviderReceiptId !== receipt.gatewayProviderReceiptId ||
        !accepted.acceptedAt
      ) {
        return yield* new HostedSandboxProviderFailed({
          operation: "send-prompt",
          cause: "prompt acceptance lease was lost",
        });
      }
      return {
        requestId: accepted.requestId,
        sandboxId: accepted.sandboxId,
        sandboxExecutionReceiptId: accepted.sandboxExecutionReceiptId,
        gatewayProviderReceiptId: accepted.gatewayProviderReceiptId,
        acceptedAt: accepted.acceptedAt,
      };
    }),
    start: Effect.fn("salvo.hosted_sandbox.start")(function* (input) {
      if (yield* repository.provisioningStopped(input.userId))
        return yield* new HostedSandboxProviderFailed({
          operation: "start",
          cause: "provisioning is stopped",
        });
      const now = DateTime.formatIso(yield* DateTime.now);
      const sandboxId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new HostedSandboxProviderFailed({ operation: "start", cause })),
      );
      let record = yield* repository.claim({
        sandboxId,
        userId: input.userId,
        requestId: input.requestId,
        status: "starting",
        providerRef: null,
        endpoint: null,
        createdAt: now,
        updatedAt: now,
      });
      if (record.status === "ready") return publicRecord(record);
      if (record.providerRef && (record.status === "stopped" || record.status === "failed")) {
        record = yield* repository.claimResume({
          eventId: `resume-starting-${record.sandboxId}-${Date.parse(now)}`.slice(0, 64),
          userId: record.userId,
          sandboxId: record.sandboxId,
          updatedAt: now,
        });
      }

      const budgetReservationId = `aws:${record.requestId}`.slice(0, 191);
      const budgetFingerprint = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            `${record.userId}:${record.sandboxId}:${record.requestId}:${record.providerRef ?? "provision"}`,
          ),
        )
        .pipe(
          Effect.map((value) =>
            Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""),
          ),
          Effect.mapError(
            (cause) => new HostedSandboxProviderFailed({ operation: "start", cause }),
          ),
        );
      yield* canaryBudget
        .reserve({
          reservationId: budgetReservationId,
          kind: "aws",
          userId: record.userId,
          fingerprint: budgetFingerprint,
          micros: 2_000_000,
        })
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxProviderFailed({ operation: "start", cause }),
          ),
        );

      const started = yield* provider
        .start({
          sandboxId: record.sandboxId,
          userId: record.userId,
          providerRef: record.providerRef,
        })
        .pipe(
          Effect.tapError(() =>
            Effect.all([
              canaryBudget.release(budgetReservationId).pipe(Effect.ignore),
              repository
                .update({
                  userId: record.userId,
                  sandboxId: record.sandboxId,
                  status: "failed",
                  updatedAt: now,
                })
                .pipe(Effect.ignore),
              bootstrapCredentials
                .revoke({ sandboxId: record.sandboxId, userId: record.userId, reason: "failed" })
                .pipe(Effect.ignore),
            ]).pipe(Effect.ignore),
          ),
        );
      yield* canaryBudget
        .settle({ reservationId: budgetReservationId, actualMicros: 2_000_000 })
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxProviderFailed({ operation: "start", cause }),
          ),
        );
      record = yield* repository.update({
        userId: record.userId,
        sandboxId: record.sandboxId,
        status: "starting",
        providerRef: started.providerRef,
        updatedAt: now,
      });
      return yield* status({ userId: record.userId, sandboxId: record.sandboxId }).pipe(
        Effect.catchTag(
          "HostedSandboxNotFound",
          () =>
            new HostedSandboxProviderFailed({
              operation: "health",
              cause: "sandbox disappeared during readiness reconciliation",
            }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(HostedSandboxes, make);
