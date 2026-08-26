import type { RelayHostedSandboxRecord, RelayHostedSandboxStatus } from "@t3tools/contracts/relay";
import { eq, and, isNull, lt, or, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import {
  salvoHostedSandboxPrompts,
  salvoHostedSandboxes,
  salvoProvisioningStops,
  salvoProvisioningStopAudits,
  salvoSandboxLifecycleHistory,
} from "../persistence/schema.ts";

export type HostedSandboxPromptRecord = {
  readonly sandboxId: string;
  readonly requestId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly status: "pending" | "dispatching" | "accepted";
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly sandboxExecutionReceiptId: string | null;
  readonly gatewayProviderReceiptId: string | null;
  readonly acceptedAt: string | null;
  readonly createdAt: string;
};

export type HostedSandboxPersistenceRecord = RelayHostedSandboxRecord & {
  readonly userId: string;
  readonly requestId: string;
  readonly providerRef: string | null;
};

export class HostedSandboxPersistenceError extends Schema.TaggedErrorClass<HostedSandboxPersistenceError>()(
  "HostedSandboxPersistenceError",
  {
    operation: Schema.Literals([
      "claim",
      "load",
      "update",
      "provisioning-stop",
      "enqueue-prompt",
      "claim-prompt",
      "accept-prompt",
    ]),
    cause: Schema.Defect(),
  },
) {}

export class HostedSandboxRepository extends Context.Service<
  HostedSandboxRepository,
  {
    readonly claim: (
      input: HostedSandboxPersistenceRecord,
    ) => Effect.Effect<HostedSandboxPersistenceRecord, HostedSandboxPersistenceError>;
    readonly loadOwned: (input: {
      readonly userId: string;
      readonly sandboxId: string;
    }) => Effect.Effect<HostedSandboxPersistenceRecord | null, HostedSandboxPersistenceError>;
    readonly update: (input: {
      readonly userId: string;
      readonly sandboxId: string;
      readonly status: RelayHostedSandboxStatus;
      readonly providerRef?: string | null;
      readonly endpoint?: string | null;
      readonly updatedAt: string;
    }) => Effect.Effect<HostedSandboxPersistenceRecord, HostedSandboxPersistenceError>;
    readonly claimResume: (input: {
      readonly eventId: string;
      readonly userId: string;
      readonly sandboxId: string;
      readonly updatedAt: string;
    }) => Effect.Effect<HostedSandboxPersistenceRecord, HostedSandboxPersistenceError>;
    readonly provisioningStopped: (
      userId: string,
    ) => Effect.Effect<boolean, HostedSandboxPersistenceError>;
    readonly setProvisioningStop: (input: {
      requestId: string;
      operatorUserId: string;
      userId: string | null;
      stopped: boolean;
      updatedAt: string;
    }) => Effect.Effect<{ scope: string; stopped: boolean }, HostedSandboxPersistenceError>;
    readonly claimIdleDrains: (input: {
      idleBefore: string;
      now: string;
      limit: number;
    }) => Effect.Effect<
      ReadonlyArray<HostedSandboxPersistenceRecord>,
      HostedSandboxPersistenceError
    >;
    readonly claimFailedStops: (input: {
      retryBefore: string;
      now: string;
      limit: number;
    }) => Effect.Effect<
      ReadonlyArray<HostedSandboxPersistenceRecord>,
      HostedSandboxPersistenceError
    >;
    readonly appendLifecycleHistory: (input: {
      eventId: string;
      sandboxId: string;
      userId: string;
      event: string;
      detail?: string | null;
      createdAt: string;
    }) => Effect.Effect<void, HostedSandboxPersistenceError>;
    readonly lifecycleHistory: (
      sandboxId: string,
    ) => Effect.Effect<
      ReadonlyArray<{ event: string; detail: string | null; createdAt: string }>,
      HostedSandboxPersistenceError
    >;
    readonly enqueuePrompt: (
      input: HostedSandboxPromptRecord,
    ) => Effect.Effect<HostedSandboxPromptRecord, HostedSandboxPersistenceError>;
    readonly claimPrompt: (input: {
      readonly sandboxId: string;
      readonly requestId: string;
      readonly leaseToken: string;
      readonly now: string;
      readonly leaseExpiresAt: string;
    }) => Effect.Effect<HostedSandboxPromptRecord, HostedSandboxPersistenceError>;
    readonly acceptPrompt: (input: {
      readonly sandboxId: string;
      readonly requestId: string;
      readonly leaseToken: string;
      readonly sandboxExecutionReceiptId: string;
      readonly gatewayProviderReceiptId: string;
      readonly acceptedAt: string;
    }) => Effect.Effect<HostedSandboxPromptRecord, HostedSandboxPersistenceError>;
  }
>()("t3code-relay/hostedSandboxes/HostedSandboxRepository") {}

const selection = {
  sandboxId: salvoHostedSandboxes.sandboxId,
  userId: salvoHostedSandboxes.userId,
  requestId: salvoHostedSandboxes.requestId,
  status: salvoHostedSandboxes.status,
  providerRef: salvoHostedSandboxes.providerRef,
  endpoint: salvoHostedSandboxes.endpoint,
  createdAt: salvoHostedSandboxes.createdAt,
  updatedAt: salvoHostedSandboxes.updatedAt,
};

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const loadOwned = Effect.fn("salvo.hosted_sandbox.load_owned")(function* (input: {
    userId: string;
    sandboxId: string;
  }) {
    const rows = yield* db
      .select(selection)
      .from(salvoHostedSandboxes)
      .where(
        and(
          eq(salvoHostedSandboxes.userId, input.userId),
          eq(salvoHostedSandboxes.sandboxId, input.sandboxId),
        ),
      )
      .limit(1)
      .pipe(
        Effect.mapError((cause) => new HostedSandboxPersistenceError({ operation: "load", cause })),
      );
    return rows[0] ?? null;
  });
  return HostedSandboxRepository.of({
    claim: Effect.fn("salvo.hosted_sandbox.claim")(function* (input) {
      yield* db
        .insert(salvoHostedSandboxes)
        .values(input)
        .onConflictDoNothing({ target: salvoHostedSandboxes.userId })
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "claim", cause }),
          ),
        );
      const rows = yield* db
        .select(selection)
        .from(salvoHostedSandboxes)
        .where(eq(salvoHostedSandboxes.userId, input.userId))
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "load", cause }),
          ),
        );
      return rows[0]!;
    }),
    loadOwned,
    update: Effect.fn("salvo.hosted_sandbox.update")(function* (input) {
      yield* db
        .update(salvoHostedSandboxes)
        .set({
          status: input.status,
          ...(input.providerRef === undefined ? {} : { providerRef: input.providerRef }),
          ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(salvoHostedSandboxes.userId, input.userId),
            eq(salvoHostedSandboxes.sandboxId, input.sandboxId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "update", cause }),
          ),
        );
      const record = yield* loadOwned(input);
      if (!record)
        return yield* new HostedSandboxPersistenceError({
          operation: "load",
          cause: "record disappeared after update",
        });
      return record;
    }),
    claimResume: Effect.fn("salvo.hosted_sandbox.claim_resume")(function* (input) {
      yield* db
        .execute(sql`with claimed as (
        update salvo_hosted_sandboxes set status = 'starting', endpoint = null, updated_at = ${input.updatedAt}
        where sandbox_id = ${input.sandboxId} and user_id = ${input.userId} and status in ('stopped','failed') returning sandbox_id, user_id
      ) insert into salvo_sandbox_lifecycle_history (event_id, sandbox_id, user_id, event, detail, created_at)
        select ${input.eventId}, sandbox_id, user_id, 'resume-starting', 'owned stopped sandbox claimed before bootstrap issuance', ${input.updatedAt} from claimed
        on conflict (event_id) do nothing`)
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "update", cause }),
          ),
        );
      const record = yield* loadOwned(input);
      if (!record)
        return yield* new HostedSandboxPersistenceError({
          operation: "load",
          cause: "resume sandbox disappeared",
        });
      return record;
    }),
    provisioningStopped: Effect.fn("salvo.hosted_sandbox.provisioning_stopped")(function* (userId) {
      const scopes = yield* db
        .select()
        .from(salvoProvisioningStops)
        .where(
          or(
            eq(salvoProvisioningStops.scope, "global"),
            eq(salvoProvisioningStops.scope, `user:${userId}`),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "provisioning-stop", cause }),
          ),
        );
      return scopes.some((row) => row.stopped);
    }),
    setProvisioningStop: Effect.fn("salvo.hosted_sandbox.set_provisioning_stop")(function* (input) {
      const scope = input.userId ? `user:${input.userId}` : "global";
      const inserted = yield* db
        .insert(salvoProvisioningStopAudits)
        .values({
          requestId: input.requestId,
          operatorUserId: input.operatorUserId,
          scope,
          stopped: input.stopped,
          createdAt: input.updatedAt,
        })
        .onConflictDoNothing({ target: salvoProvisioningStopAudits.requestId })
        .returning({ requestId: salvoProvisioningStopAudits.requestId })
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "provisioning-stop", cause }),
          ),
        );
      if (inserted.length === 0) {
        const prior = (yield* db
          .select()
          .from(salvoProvisioningStopAudits)
          .where(eq(salvoProvisioningStopAudits.requestId, input.requestId))
          .limit(1)
          .pipe(
            Effect.mapError(
              (cause) =>
                new HostedSandboxPersistenceError({ operation: "provisioning-stop", cause }),
            ),
          ))[0];
        if (
          !prior ||
          prior.operatorUserId !== input.operatorUserId ||
          prior.scope !== scope ||
          prior.stopped !== input.stopped
        )
          return yield* new HostedSandboxPersistenceError({
            operation: "provisioning-stop",
            cause: "conflicting request replay",
          });
        return { scope: prior.scope, stopped: prior.stopped };
      }
      yield* db
        .insert(salvoProvisioningStops)
        .values({ scope, stopped: input.stopped, updatedAt: input.updatedAt })
        .onConflictDoUpdate({
          target: salvoProvisioningStops.scope,
          set: { stopped: input.stopped, updatedAt: input.updatedAt },
        })
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "provisioning-stop", cause }),
          ),
        );
      return { scope, stopped: input.stopped };
    }),
    claimIdleDrains: (input) =>
      db
        .execute(sql`with candidates as (
      select s.sandbox_id from salvo_hosted_sandboxes s where (s.status = 'draining' or (s.status = 'ready' and s.updated_at <= ${input.idleBefore}))
      and not exists (select 1 from salvo_hosted_sandbox_prompts p where p.sandbox_id = s.sandbox_id and p.status = 'dispatching')
      order by s.updated_at for update skip locked limit ${input.limit}
    ) update salvo_hosted_sandboxes s set status = 'draining', updated_at = ${input.now} from candidates c
      where s.sandbox_id = c.sandbox_id returning s.sandbox_id, s.user_id, s.request_id, s.status, s.provider_ref, s.endpoint, s.created_at, s.updated_at`)
        .pipe(
          Effect.map(
            (result) =>
              (result as { rows?: HostedSandboxPersistenceRecord[] }).rows ??
              (result as HostedSandboxPersistenceRecord[]),
          ),
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "update", cause }),
          ),
        ),
    claimFailedStops: (input) =>
      db
        .execute(sql`with candidates as (
      select s.sandbox_id from salvo_hosted_sandboxes s where s.status = 'failed' and s.provider_ref is not null and s.updated_at <= ${input.retryBefore}
      and exists (select 1 from salvo_sandbox_lifecycle_history h where h.sandbox_id = s.sandbox_id and h.event = 'stop-failed')
      order by s.updated_at for update skip locked limit ${input.limit}
    ) update salvo_hosted_sandboxes s set status = 'draining', updated_at = ${input.now} from candidates c
      where s.sandbox_id = c.sandbox_id returning s.sandbox_id, s.user_id, s.request_id, s.status, s.provider_ref, s.endpoint, s.created_at, s.updated_at`)
        .pipe(
          Effect.map(
            (result) =>
              (result as { rows?: HostedSandboxPersistenceRecord[] }).rows ??
              (result as HostedSandboxPersistenceRecord[]),
          ),
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "update", cause }),
          ),
        ),
    appendLifecycleHistory: (input) =>
      db
        .insert(salvoSandboxLifecycleHistory)
        .values(input)
        .onConflictDoNothing({ target: salvoSandboxLifecycleHistory.eventId })
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "update", cause }),
          ),
        ),
    lifecycleHistory: (sandboxId) =>
      db
        .select({
          event: salvoSandboxLifecycleHistory.event,
          detail: salvoSandboxLifecycleHistory.detail,
          createdAt: salvoSandboxLifecycleHistory.createdAt,
        })
        .from(salvoSandboxLifecycleHistory)
        .where(eq(salvoSandboxLifecycleHistory.sandboxId, sandboxId))
        .orderBy(salvoSandboxLifecycleHistory.createdAt)
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "load", cause }),
          ),
        ),
    enqueuePrompt: Effect.fn("salvo.hosted_sandbox.enqueue_prompt")(function* (input) {
      yield* db
        .update(salvoHostedSandboxes)
        .set({ updatedAt: input.createdAt })
        .where(
          and(
            eq(salvoHostedSandboxes.sandboxId, input.sandboxId),
            eq(salvoHostedSandboxes.userId, input.userId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "enqueue-prompt", cause }),
          ),
        );
      yield* db
        .insert(salvoHostedSandboxPrompts)
        .values(input)
        .onConflictDoNothing({
          target: [salvoHostedSandboxPrompts.sandboxId, salvoHostedSandboxPrompts.requestId],
        })
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "enqueue-prompt", cause }),
          ),
        );
      const rows = yield* db
        .select()
        .from(salvoHostedSandboxPrompts)
        .where(
          and(
            eq(salvoHostedSandboxPrompts.sandboxId, input.sandboxId),
            eq(salvoHostedSandboxPrompts.requestId, input.requestId),
          ),
        )
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "enqueue-prompt", cause }),
          ),
        );
      return rows[0]!;
    }),
    claimPrompt: Effect.fn("salvo.hosted_sandbox.claim_prompt")(function* (input) {
      yield* db
        .update(salvoHostedSandboxPrompts)
        .set({
          status: "dispatching",
          leaseToken: input.leaseToken,
          leaseExpiresAt: input.leaseExpiresAt,
        })
        .where(
          and(
            eq(salvoHostedSandboxPrompts.sandboxId, input.sandboxId),
            eq(salvoHostedSandboxPrompts.requestId, input.requestId),
            or(
              eq(salvoHostedSandboxPrompts.status, "pending"),
              and(
                eq(salvoHostedSandboxPrompts.status, "dispatching"),
                or(
                  isNull(salvoHostedSandboxPrompts.leaseExpiresAt),
                  lt(salvoHostedSandboxPrompts.leaseExpiresAt, input.now),
                ),
              ),
            ),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "claim-prompt", cause }),
          ),
        );
      const rows = yield* db
        .select()
        .from(salvoHostedSandboxPrompts)
        .where(
          and(
            eq(salvoHostedSandboxPrompts.sandboxId, input.sandboxId),
            eq(salvoHostedSandboxPrompts.requestId, input.requestId),
          ),
        )
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "claim-prompt", cause }),
          ),
        );
      return rows[0]!;
    }),
    acceptPrompt: Effect.fn("salvo.hosted_sandbox.accept_prompt")(function* (input) {
      yield* db
        .update(salvoHostedSandboxes)
        .set({ updatedAt: input.acceptedAt })
        .where(eq(salvoHostedSandboxes.sandboxId, input.sandboxId))
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "accept-prompt", cause }),
          ),
        );
      yield* db
        .update(salvoHostedSandboxPrompts)
        .set({
          status: "accepted",
          sandboxExecutionReceiptId: input.sandboxExecutionReceiptId,
          gatewayProviderReceiptId: input.gatewayProviderReceiptId,
          acceptedAt: input.acceptedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(salvoHostedSandboxPrompts.sandboxId, input.sandboxId),
            eq(salvoHostedSandboxPrompts.requestId, input.requestId),
            eq(salvoHostedSandboxPrompts.status, "dispatching"),
            eq(salvoHostedSandboxPrompts.leaseToken, input.leaseToken),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "accept-prompt", cause }),
          ),
        );
      const rows = yield* db
        .select()
        .from(salvoHostedSandboxPrompts)
        .where(
          and(
            eq(salvoHostedSandboxPrompts.sandboxId, input.sandboxId),
            eq(salvoHostedSandboxPrompts.requestId, input.requestId),
          ),
        )
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) => new HostedSandboxPersistenceError({ operation: "accept-prompt", cause }),
          ),
        );
      return rows[0]!;
    }),
  });
});

export const layer = Layer.effect(HostedSandboxRepository, make);
