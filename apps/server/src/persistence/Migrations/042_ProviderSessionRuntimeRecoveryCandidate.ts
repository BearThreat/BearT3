import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const candidateColumns = [
  ["candidate_recovery_id", "TEXT"],
  ["candidate_recovery_json", "TEXT"],
  ["candidate_resume_cursor_json", "TEXT"],
  ["candidate_runtime_payload_json", "TEXT"],
  ["candidate_status", "TEXT"],
  ["candidate_turn_id", "TEXT"],
  ["candidate_updated_at", "TEXT"],
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;
  const existing = new Set(columns.map((column) => column.name));

  for (const [name, type] of candidateColumns) {
    if (!existing.has(name)) {
      yield* sql.unsafe(`ALTER TABLE provider_session_runtime ADD COLUMN ${name} ${type}`);
    }
  }
});
