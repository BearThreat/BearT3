import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_ProjectionThreadsUnsettledAt", (it) => {
  it.effect("preserves migration 42 recovery state and is idempotent at startup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key,
          runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (
          'thread-upgrade', 'codex', 'codex', 'codex',
          'full-access', 'running', '2026-08-26T00:00:00.000Z',
          '{"canonical":true}', '{"cwd":"/tmp"}'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES (
          'thread-upgrade', 'project-1', 'Upgrade thread',
          '{"instanceId":"codex","model":"gpt-5"}',
          '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z'
        )
      `;

      const migration42 = yield* runMigrations({ toMigrationInclusive: 42 });
      assert.deepEqual(migration42, [[42, "ProviderSessionRuntimeRecoveryCandidate"]]);

      yield* sql`
        UPDATE provider_session_runtime
        SET candidate_recovery_id = 'recovery-1',
            candidate_recovery_json = '{"phase":"turn-started"}',
            candidate_resume_cursor_json = '{"cursor":"candidate"}',
            candidate_runtime_payload_json = '{"activeTurnId":"turn-1"}',
            candidate_status = 'turn-started',
            candidate_turn_id = 'turn-1',
            candidate_updated_at = '2026-08-26T00:01:00.000Z'
        WHERE thread_id = 'thread-upgrade'
      `;

      const migration43 = yield* runMigrations();
      assert.deepEqual(migration43, [[43, "ProjectionThreadsUnsettledAt"]]);
      yield* sql`
        UPDATE projection_threads
        SET unsettled_at = '2026-08-26T00:02:00.000Z'
        WHERE thread_id = 'thread-upgrade'
      `;

      const repeatedStartup = yield* runMigrations();
      assert.deepEqual(repeatedStartup, []);

      const recoveryColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(provider_session_runtime)
      `;
      const recoveryColumnNames = new Set(recoveryColumns.map((column) => column.name));
      for (const name of [
        "candidate_recovery_id",
        "candidate_recovery_json",
        "candidate_resume_cursor_json",
        "candidate_runtime_payload_json",
        "candidate_status",
        "candidate_turn_id",
        "candidate_updated_at",
      ]) {
        assert.equal(recoveryColumnNames.has(name), true);
      }

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.equal(
        threadColumns.some((column) => column.name === "unsettled_at"),
        true,
      );

      const [row] = yield* sql<{
        readonly candidateRecoveryId: string | null;
        readonly candidateRecoveryJson: string | null;
        readonly candidateResumeCursorJson: string | null;
        readonly candidateRuntimePayloadJson: string | null;
        readonly candidateStatus: string | null;
        readonly candidateTurnId: string | null;
        readonly candidateUpdatedAt: string | null;
        readonly unsettledAt: string | null;
      }>`
        SELECT
          runtime.candidate_recovery_id AS "candidateRecoveryId",
          runtime.candidate_recovery_json AS "candidateRecoveryJson",
          runtime.candidate_resume_cursor_json AS "candidateResumeCursorJson",
          runtime.candidate_runtime_payload_json AS "candidateRuntimePayloadJson",
          runtime.candidate_status AS "candidateStatus",
          runtime.candidate_turn_id AS "candidateTurnId",
          runtime.candidate_updated_at AS "candidateUpdatedAt",
          threads.unsettled_at AS "unsettledAt"
        FROM provider_session_runtime AS runtime
        JOIN projection_threads AS threads ON threads.thread_id = runtime.thread_id
        WHERE runtime.thread_id = 'thread-upgrade'
      `;
      assert.deepEqual(row, {
        candidateRecoveryId: "recovery-1",
        candidateRecoveryJson: '{"phase":"turn-started"}',
        candidateResumeCursorJson: '{"cursor":"candidate"}',
        candidateRuntimePayloadJson: '{"activeTurnId":"turn-1"}',
        candidateStatus: "turn-started",
        candidateTurnId: "turn-1",
        candidateUpdatedAt: "2026-08-26T00:01:00.000Z",
        unsettledAt: "2026-08-26T00:02:00.000Z",
      });
    }),
  );
});
