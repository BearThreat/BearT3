import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  IsoDateTime,
  ProviderInstanceId,
  ProviderSessionRecovery,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
  type ProviderSessionRuntimeRepositoryError,
} from "./Errors.ts";

/**
 * ProviderSessionRuntimeRepository - Repository interface for provider runtime sessions.
 *
 * Owns persistence operations for provider runtime metadata and resume cursors.
 *
 * @module ProviderSessionRuntimeRepository
 */

export const ProviderSessionRuntime = Schema.Struct({
  threadId: ThreadId,
  providerName: Schema.String,
  /**
   * User-defined routing key for the configured provider instance that
   * owns this session. Nullable only at the storage/migration boundary:
   * rows persisted before the driver/instance split carry only
   * `providerName`. Repository consumers must materialize a concrete
   * instance id before routing.
   */
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  adapterKey: Schema.String,
  runtimeMode: RuntimeMode,
  status: ProviderSessionRuntimeStatus,
  lastSeenAt: IsoDateTime,
  resumeCursor: Schema.NullOr(Schema.Unknown),
  runtimePayload: Schema.NullOr(Schema.Unknown),
});
export type ProviderSessionRuntime = typeof ProviderSessionRuntime.Type;

export const GetProviderSessionRuntimeInput = Schema.Struct({ threadId: ThreadId });
export type GetProviderSessionRuntimeInput = typeof GetProviderSessionRuntimeInput.Type;

export const DeleteProviderSessionRuntimeInput = Schema.Struct({ threadId: ThreadId });
export type DeleteProviderSessionRuntimeInput = typeof DeleteProviderSessionRuntimeInput.Type;

export const ProviderSessionRecoveryCandidateStatus = Schema.Literals([
  "staged",
  "dispatch-committed",
  "turn-started",
]);
export type ProviderSessionRecoveryCandidateStatus =
  typeof ProviderSessionRecoveryCandidateStatus.Type;

export const ProviderSessionRecoveryCandidate = Schema.Struct({
  threadId: ThreadId,
  recoveryId: Schema.String,
  recovery: ProviderSessionRecovery,
  resumeCursor: Schema.NullOr(Schema.Unknown),
  runtimePayload: Schema.NullOr(Schema.Unknown),
  status: ProviderSessionRecoveryCandidateStatus,
  turnId: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type ProviderSessionRecoveryCandidate = typeof ProviderSessionRecoveryCandidate.Type;

export interface StageProviderSessionRecoveryCandidateInput {
  readonly threadId: ThreadId;
  readonly recoveryId: string;
  readonly recovery: ProviderSessionRecovery;
  readonly resumeCursor: unknown | null;
  readonly runtimePayload: unknown | null;
  readonly updatedAt: string;
}

export interface ProviderSessionRecoveryCandidateKey {
  readonly threadId: ThreadId;
  readonly recoveryId: string;
}

export interface MarkProviderSessionRecoveryCandidateInput extends ProviderSessionRecoveryCandidateKey {
  readonly updatedAt: string;
}

export interface MarkProviderSessionRecoveryCandidateTurnStartedInput extends MarkProviderSessionRecoveryCandidateInput {
  readonly turnId: string;
}

/**
 * ProviderSessionRuntimeRepository - Service tag for provider runtime persistence.
 */
export class ProviderSessionRuntimeRepository extends Context.Service<
  ProviderSessionRuntimeRepository,
  {
    /**
     * Insert or replace a provider runtime row.
     *
     * Upserts by canonical `threadId`, including JSON payload/cursor fields.
     */
    readonly upsert: (
      runtime: ProviderSessionRuntime,
    ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

    /**
     * Read provider runtime state by canonical thread id.
     */
    readonly getByThreadId: (
      input: GetProviderSessionRuntimeInput,
    ) => Effect.Effect<
      Option.Option<ProviderSessionRuntime>,
      ProviderSessionRuntimeRepositoryError
    >;

    /**
     * List all provider runtime rows.
     *
     * Returned in ascending last-seen order.
     */
    readonly list: () => Effect.Effect<
      ReadonlyArray<ProviderSessionRuntime>,
      ProviderSessionRuntimeRepositoryError
    >;

    /**
     * Delete provider runtime state by canonical thread id.
     */
    readonly deleteByThreadId: (
      input: DeleteProviderSessionRuntimeInput,
    ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

    readonly stageCandidate: (
      input: StageProviderSessionRecoveryCandidateInput,
    ) => Effect.Effect<boolean, ProviderSessionRuntimeRepositoryError>;

    readonly getCandidate: (
      input: ProviderSessionRecoveryCandidateKey,
    ) => Effect.Effect<
      Option.Option<ProviderSessionRecoveryCandidate>,
      ProviderSessionRuntimeRepositoryError
    >;
    readonly listCandidates: () => Effect.Effect<
      ReadonlyArray<ProviderSessionRecoveryCandidate>,
      ProviderSessionRuntimeRepositoryError
    >;

    readonly markCandidateDispatchCommitted: (
      input: MarkProviderSessionRecoveryCandidateInput,
    ) => Effect.Effect<boolean, ProviderSessionRuntimeRepositoryError>;

    readonly markCandidateTurnStarted: (
      input: MarkProviderSessionRecoveryCandidateTurnStartedInput,
    ) => Effect.Effect<boolean, ProviderSessionRuntimeRepositoryError>;

    readonly promoteCandidate: (
      input: ProviderSessionRecoveryCandidateKey,
    ) => Effect.Effect<boolean, ProviderSessionRuntimeRepositoryError>;

    readonly rollbackCandidate: (
      input: ProviderSessionRecoveryCandidateKey,
    ) => Effect.Effect<boolean, ProviderSessionRuntimeRepositoryError>;
  }
>()("t3/persistence/ProviderSessionRuntime/ProviderSessionRuntimeRepository") {}

const ProviderSessionRuntimeDbRowSchema = ProviderSessionRuntime.mapFields(
  Struct.assign({
    resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    runtimePayload: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  }),
);

const ProviderSessionRuntimeRawDbRowSchema = Schema.Struct({
  threadId: Schema.String,
  providerName: Schema.Unknown,
  providerInstanceId: Schema.Unknown,
  adapterKey: Schema.Unknown,
  runtimeMode: Schema.Unknown,
  status: Schema.Unknown,
  lastSeenAt: Schema.Unknown,
  resumeCursor: Schema.Unknown,
  runtimePayload: Schema.Unknown,
});

const decodeRuntimeRow = Schema.decodeUnknownEffect(ProviderSessionRuntimeDbRowSchema);

const ProviderSessionRecoveryCandidateDbRowSchema = ProviderSessionRecoveryCandidate.mapFields(
  Struct.assign({
    recovery: Schema.fromJsonString(ProviderSessionRecovery),
    resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    runtimePayload: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  }),
);

const ProviderSessionRecoveryCandidateRawDbRowSchema = Schema.Struct({
  threadId: Schema.String,
  recoveryId: Schema.Unknown,
  recovery: Schema.Unknown,
  resumeCursor: Schema.Unknown,
  runtimePayload: Schema.Unknown,
  status: Schema.Unknown,
  turnId: Schema.Unknown,
  updatedAt: Schema.Unknown,
});

const decodeCandidateRow = Schema.decodeUnknownEffect(ProviderSessionRecoveryCandidateDbRowSchema);

const GetRuntimeRequestSchema = Schema.Struct({
  threadId: ThreadId,
});

const DeleteRuntimeRequestSchema = GetRuntimeRequestSchema;

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): ProviderSessionRuntimeRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRuntimeRow = SqlSchema.void({
    Request: ProviderSessionRuntimeDbRowSchema,
    execute: (runtime) =>
      sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${runtime.threadId},
          ${runtime.providerName},
          ${runtime.providerInstanceId},
          ${runtime.adapterKey},
          ${runtime.runtimeMode},
          ${runtime.status},
          ${runtime.lastSeenAt},
          ${runtime.resumeCursor},
          ${runtime.runtimePayload}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          provider_name = excluded.provider_name,
          provider_instance_id = excluded.provider_instance_id,
          adapter_key = excluded.adapter_key,
          runtime_mode = excluded.runtime_mode,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          resume_cursor_json = excluded.resume_cursor_json,
          runtime_payload_json = excluded.runtime_payload_json
      `,
  });

  const getRuntimeRowByThreadId = SqlSchema.findOneOption({
    Request: GetRuntimeRequestSchema,
    Result: ProviderSessionRuntimeRawDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const listRuntimeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderSessionRuntimeRawDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        ORDER BY last_seen_at ASC, thread_id ASC
      `,
  });

  const deleteRuntimeByThreadId = SqlSchema.void({
    Request: DeleteRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const getCandidateRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, recoveryId: Schema.String }),
    Result: ProviderSessionRecoveryCandidateRawDbRowSchema,
    execute: ({ threadId, recoveryId }) => sql`
      SELECT
        thread_id AS "threadId",
        candidate_recovery_id AS "recoveryId",
        candidate_recovery_json AS "recovery",
        candidate_resume_cursor_json AS "resumeCursor",
        candidate_runtime_payload_json AS "runtimePayload",
        candidate_status AS "status",
        candidate_turn_id AS "turnId",
        candidate_updated_at AS "updatedAt"
      FROM provider_session_runtime
      WHERE thread_id = ${threadId}
        AND candidate_recovery_id = ${recoveryId}
    `,
  });
  const listCandidateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderSessionRecoveryCandidateRawDbRowSchema,
    execute: () => sql`
      SELECT thread_id AS "threadId", candidate_recovery_id AS "recoveryId",
        candidate_recovery_json AS "recovery",
        candidate_resume_cursor_json AS "resumeCursor",
        candidate_runtime_payload_json AS "runtimePayload", candidate_status AS "status",
        candidate_turn_id AS "turnId", candidate_updated_at AS "updatedAt"
      FROM provider_session_runtime WHERE candidate_recovery_id IS NOT NULL
      ORDER BY thread_id ASC
    `,
  });

  const upsert: ProviderSessionRuntimeRepository["Service"]["upsert"] = (runtime) =>
    upsertRuntimeRow(runtime).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.upsert:query",
          "ProviderSessionRuntimeRepository.upsert:encodeRequest",
          { threadId: runtime.threadId },
        ),
      ),
    );

  const getByThreadId: ProviderSessionRuntimeRepository["Service"]["getByThreadId"] = (input) =>
    getRuntimeRowByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.getByThreadId:query",
          "ProviderSessionRuntimeRepository.getByThreadId:decodeRow",
          { threadId: input.threadId },
        ),
      ),
      Effect.flatMap((runtimeRowOption) =>
        Option.match(runtimeRowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRuntimeRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "ProviderSessionRuntimeRepository.getByThreadId:decodeRow",
                  cause,
                  { threadId: input.threadId },
                ),
              ),
              Effect.map((runtime) => Option.some(runtime)),
            ),
        }),
      ),
    );

  const list: ProviderSessionRuntimeRepository["Service"]["list"] = () =>
    listRuntimeRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.list:query",
          "ProviderSessionRuntimeRepository.list:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        // Skip rows that no longer decode (e.g. written by an older build)
        // instead of failing the whole list — one stale row must not disable
        // every consumer that enumerates sessions, such as the reaper.
        Effect.forEach(rows, (row) =>
          decodeRuntimeRow(row).pipe(
            Effect.map(Option.some),
            Effect.catch((cause) =>
              Effect.logWarning("provider.session.runtime.row-skipped", {
                threadId: row.threadId,
                error: PersistenceDecodeError.fromSchemaError(
                  "ProviderSessionRuntimeRepository.list:decodeRows",
                  cause,
                  { threadId: row.threadId },
                ).message,
              }).pipe(Effect.as(Option.none<ProviderSessionRuntime>())),
            ),
          ),
        ),
      ),
      Effect.map((decoded) =>
        Arr.filterMap(decoded, (row) =>
          Option.isSome(row) ? Result.succeed(row.value) : Result.failVoid,
        ),
      ),
    );

  const deleteByThreadId: ProviderSessionRuntimeRepository["Service"]["deleteByThreadId"] = (
    input,
  ) =>
    deleteRuntimeByThreadId(input).pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({
            operation: "ProviderSessionRuntimeRepository.deleteByThreadId:query",
            correlation: { threadId: input.threadId },
            cause,
          }),
      ),
    );

  const candidateSqlError = (operation: string, input: ProviderSessionRecoveryCandidateKey) =>
    Effect.mapError(
      (cause: unknown) =>
        new PersistenceSqlError({
          operation,
          correlation: { threadId: input.threadId },
          cause,
        }),
    );

  const stageCandidate: ProviderSessionRuntimeRepository["Service"]["stageCandidate"] = (input) =>
    sql<{ readonly threadId: string }>`
      UPDATE provider_session_runtime
      SET candidate_recovery_id = ${input.recoveryId},
          candidate_recovery_json = ${JSON.stringify(input.recovery)},
          candidate_resume_cursor_json = ${JSON.stringify(input.resumeCursor)},
          candidate_runtime_payload_json = ${JSON.stringify(input.runtimePayload)},
          candidate_status = 'staged',
          candidate_turn_id = NULL,
          candidate_updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId}
        AND (candidate_recovery_id IS NULL OR candidate_recovery_id = ${input.recoveryId})
      RETURNING thread_id AS "threadId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      candidateSqlError("ProviderSessionRuntimeRepository.stageCandidate:query", input),
    );

  const getCandidate: ProviderSessionRuntimeRepository["Service"]["getCandidate"] = (input) =>
    getCandidateRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.getCandidate:query",
          "ProviderSessionRuntimeRepository.getCandidate:decodeRow",
          { threadId: input.threadId },
        ),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeCandidateRow(row).pipe(
              Effect.map(Option.some),
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "ProviderSessionRuntimeRepository.getCandidate:decodeRow",
                  cause,
                  { threadId: input.threadId },
                ),
              ),
            ),
        }),
      ),
    );
  const listCandidates: ProviderSessionRuntimeRepository["Service"]["listCandidates"] = () =>
    listCandidateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.listCandidates:query",
          "ProviderSessionRuntimeRepository.listCandidates:decode",
          undefined,
        ),
      ),
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeCandidateRow(row))),
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? PersistenceDecodeError.fromSchemaError(
              "ProviderSessionRuntimeRepository.listCandidates:decode",
              cause,
              undefined,
            )
          : cause,
      ),
    );

  const markCandidateDispatchCommitted: ProviderSessionRuntimeRepository["Service"]["markCandidateDispatchCommitted"] =
    (input) =>
      sql<{ readonly threadId: string }>`
        UPDATE provider_session_runtime
        SET candidate_status = 'dispatch-committed',
            candidate_updated_at = ${input.updatedAt}
        WHERE thread_id = ${input.threadId}
          AND candidate_recovery_id = ${input.recoveryId}
          AND candidate_status = 'staged'
        RETURNING thread_id AS "threadId"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        candidateSqlError(
          "ProviderSessionRuntimeRepository.markCandidateDispatchCommitted:query",
          input,
        ),
      );

  const markCandidateTurnStarted: ProviderSessionRuntimeRepository["Service"]["markCandidateTurnStarted"] =
    (input) =>
      sql<{ readonly threadId: string }>`
        UPDATE provider_session_runtime
        SET candidate_status = 'turn-started',
            candidate_turn_id = ${input.turnId},
            candidate_updated_at = ${input.updatedAt}
        WHERE thread_id = ${input.threadId}
          AND candidate_recovery_id = ${input.recoveryId}
          AND candidate_status = 'dispatch-committed'
        RETURNING thread_id AS "threadId"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        candidateSqlError("ProviderSessionRuntimeRepository.markCandidateTurnStarted:query", input),
      );

  const promoteCandidate: ProviderSessionRuntimeRepository["Service"]["promoteCandidate"] = (
    input,
  ) =>
    sql<{ readonly threadId: string }>`
        UPDATE provider_session_runtime
        SET resume_cursor_json = candidate_resume_cursor_json,
            runtime_payload_json = candidate_runtime_payload_json,
            candidate_recovery_id = NULL,
            candidate_recovery_json = NULL,
            candidate_resume_cursor_json = NULL,
            candidate_runtime_payload_json = NULL,
            candidate_status = NULL,
            candidate_turn_id = NULL,
            candidate_updated_at = NULL
        WHERE thread_id = ${input.threadId}
          AND candidate_recovery_id = ${input.recoveryId}
          AND candidate_status = 'turn-started'
          AND candidate_turn_id IS NOT NULL
        RETURNING thread_id AS "threadId"
      `.pipe(
      Effect.map((rows) => rows.length === 1),
      candidateSqlError("ProviderSessionRuntimeRepository.promoteCandidate:query", input),
    );

  const rollbackCandidate: ProviderSessionRuntimeRepository["Service"]["rollbackCandidate"] = (
    input,
  ) =>
    sql<{ readonly threadId: string }>`
        UPDATE provider_session_runtime
        SET candidate_recovery_id = NULL,
            candidate_recovery_json = NULL,
            candidate_resume_cursor_json = NULL,
            candidate_runtime_payload_json = NULL,
            candidate_status = NULL,
            candidate_turn_id = NULL,
            candidate_updated_at = NULL
        WHERE thread_id = ${input.threadId}
          AND candidate_recovery_id = ${input.recoveryId}
        RETURNING thread_id AS "threadId"
      `.pipe(
      Effect.map((rows) => rows.length === 1),
      candidateSqlError("ProviderSessionRuntimeRepository.rollbackCandidate:query", input),
    );

  return {
    upsert,
    getByThreadId,
    list,
    deleteByThreadId,
    stageCandidate,
    getCandidate,
    listCandidates,
    markCandidateDispatchCommitted,
    markCandidateTurnStarted,
    promoteCandidate,
    rollbackCandidate,
  } satisfies ProviderSessionRuntimeRepository["Service"];
});

export const layer = Layer.effect(ProviderSessionRuntimeRepository, make);
