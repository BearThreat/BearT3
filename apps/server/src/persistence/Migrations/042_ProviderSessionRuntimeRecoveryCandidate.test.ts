import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProviderSessionRuntimeRecoveryCandidate", (it) => {
  it.effect("adds nullable recovery candidate columns without changing existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key,
          runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
        ) VALUES (
          'thread-existing', 'codex', 'codex', 'codex',
          'full-access', 'running', '2026-08-26T00:00:00.000Z', '{"canonical":true}', '{"cwd":"/tmp"}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(provider_session_runtime)
      `;
      const names = new Set(columns.map((column) => column.name));
      for (const name of [
        "candidate_recovery_id",
        "candidate_resume_cursor_json",
        "candidate_runtime_payload_json",
        "candidate_status",
        "candidate_turn_id",
        "candidate_updated_at",
      ]) {
        assert.equal(names.has(name), true);
        assert.equal(columns.find((column) => column.name === name)?.notnull, 0);
      }

      const [row] = yield* sql<{
        readonly resumeCursor: string;
        readonly candidateRecoveryId: string | null;
      }>`
        SELECT resume_cursor_json AS "resumeCursor",
               candidate_recovery_id AS "candidateRecoveryId"
        FROM provider_session_runtime
        WHERE thread_id = 'thread-existing'
      `;
      assert.equal(row?.resumeCursor, '{"canonical":true}');
      assert.equal(row?.candidateRecoveryId, null);
    }),
  );
});
