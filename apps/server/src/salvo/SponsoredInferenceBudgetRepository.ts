// @effect-diagnostics globalDate:off -- SQLite audit timestamps are persisted as UTC ISO strings at this boundary.
import * as NodeSqlite from "node:sqlite";

import {
  commitSponsoredInference,
  releaseSponsoredInference,
  reserveSponsoredInference,
  summarizeSponsoredInferenceBudget,
  type ReserveResult,
  type SponsoredInferenceBudgetConfig,
  type SponsoredInferenceBudgetState,
  type SponsoredInferenceReservation,
} from "./SponsoredInferenceBudget.js";

export type SponsoredInferenceTransitionResult =
  | {
      readonly ok: true;
      readonly reservation: SponsoredInferenceReservation;
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly reason: "not_found" | "invalid_amount" | "invalid_state" };

export type SponsoredInferenceBudgetEvent = {
  readonly sequence: number;
  readonly reservationId: string;
  readonly type: "reserved" | "committed" | "released";
  readonly amountMicros: number;
  readonly createdAt: string;
};

type ReservationRow = {
  id: string;
  user_id: string;
  turn_id: string;
  reserved_micros: number;
  state: "reserved" | "committed" | "released";
  billed_micros: number;
};

type EventRow = {
  sequence: number;
  reservation_id: string;
  event_type: "reserved" | "committed" | "released";
  amount_micros: number;
  created_at: string;
};

const schema = `
  CREATE TABLE IF NOT EXISTS salvo_sponsored_inference_reservations (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    reserved_micros INTEGER NOT NULL CHECK (reserved_micros > 0),
    state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released')),
    billed_micros INTEGER NOT NULL CHECK (billed_micros >= 0 AND billed_micros <= reserved_micros)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS salvo_sponsored_inference_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    reservation_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('reserved', 'committed', 'released')),
    amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (reservation_id) REFERENCES salvo_sponsored_inference_reservations(id)
  ) STRICT;
`;

const reservationFromRow = (row: ReservationRow): SponsoredInferenceReservation => ({
  id: row.id,
  userId: row.user_id,
  turnId: row.turn_id,
  reservedMicros: row.reserved_micros,
  state: row.state,
  billedMicros: row.billed_micros,
});

export class SponsoredInferenceBudgetRepository implements Disposable {
  readonly #database: NodeSqlite.DatabaseSync;

  constructor(filename: string) {
    this.#database = new NodeSqlite.DatabaseSync(filename);
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#database.exec(schema);
  }

  close(): void {
    this.#database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  readState(): SponsoredInferenceBudgetState {
    const rows = this.#database
      .prepare(`
      SELECT id, user_id, turn_id, reserved_micros, state, billed_micros
      FROM salvo_sponsored_inference_reservations
      ORDER BY id
    `)
      .all() as unknown as ReadonlyArray<ReservationRow>;
    return {
      reservations: Object.fromEntries(rows.map((row) => [row.id, reservationFromRow(row)])),
    };
  }

  summarize() {
    return summarizeSponsoredInferenceBudget(this.readState());
  }

  reserve(
    config: SponsoredInferenceBudgetConfig,
    input: {
      readonly id: string;
      readonly userId: string;
      readonly turnId: string;
      readonly amountMicros: number;
    },
  ): ReserveResult {
    return this.#transaction(() => {
      const result = reserveSponsoredInference(this.readState(), config, input);
      if (!result.ok || result.replayed) return result;
      this.#database
        .prepare(`
        INSERT INTO salvo_sponsored_inference_reservations
          (id, user_id, turn_id, reserved_micros, state, billed_micros)
        VALUES (?, ?, ?, ?, 'reserved', 0)
      `)
        .run(input.id, input.userId, input.turnId, input.amountMicros);
      this.#appendEvent(input.id, "reserved", input.amountMicros);
      return result;
    });
  }

  commit(id: string, billedMicros: number): SponsoredInferenceTransitionResult {
    return this.#transaction(() => {
      const before = this.readState();
      const reservation = before.reservations[id];
      if (!reservation) return { ok: false, reason: "not_found" };
      if (
        !Number.isSafeInteger(billedMicros) ||
        billedMicros < 0 ||
        billedMicros > reservation.reservedMicros
      ) {
        return { ok: false, reason: "invalid_amount" };
      }
      if (reservation.state === "committed") {
        return reservation.billedMicros === billedMicros
          ? { ok: true, reservation, replayed: true }
          : { ok: false, reason: "invalid_state" };
      }
      if (reservation.state !== "reserved") return { ok: false, reason: "invalid_state" };

      const after = commitSponsoredInference(before, id, billedMicros);
      const committed = after.reservations[id]!;
      this.#database
        .prepare(`
        UPDATE salvo_sponsored_inference_reservations
        SET state = 'committed', billed_micros = ?
        WHERE id = ? AND state = 'reserved'
      `)
        .run(billedMicros, id);
      this.#appendEvent(id, "committed", billedMicros);
      return { ok: true, reservation: committed, replayed: false };
    });
  }

  release(id: string): SponsoredInferenceTransitionResult {
    return this.#transaction(() => {
      const before = this.readState();
      const reservation = before.reservations[id];
      if (!reservation) return { ok: false, reason: "not_found" };
      if (reservation.state === "released") return { ok: true, reservation, replayed: true };
      if (reservation.state !== "reserved") return { ok: false, reason: "invalid_state" };

      const after = releaseSponsoredInference(before, id);
      const released = after.reservations[id]!;
      this.#database
        .prepare(`
        UPDATE salvo_sponsored_inference_reservations
        SET state = 'released'
        WHERE id = ? AND state = 'reserved'
      `)
        .run(id);
      this.#appendEvent(id, "released", 0);
      return { ok: true, reservation: released, replayed: false };
    });
  }

  events(): ReadonlyArray<SponsoredInferenceBudgetEvent> {
    const rows = this.#database
      .prepare(`
      SELECT sequence, reservation_id, event_type, amount_micros, created_at
      FROM salvo_sponsored_inference_events
      ORDER BY sequence
    `)
      .all() as unknown as ReadonlyArray<EventRow>;
    return rows.map((row) => ({
      sequence: row.sequence,
      reservationId: row.reservation_id,
      type: row.event_type,
      amountMicros: row.amount_micros,
      createdAt: row.created_at,
    }));
  }

  #appendEvent(
    reservationId: string,
    type: SponsoredInferenceBudgetEvent["type"],
    amountMicros: number,
  ): void {
    this.#database
      .prepare(`
      INSERT INTO salvo_sponsored_inference_events
        (reservation_id, event_type, amount_micros, created_at)
      VALUES (?, ?, ?, ?)
    `)
      .run(reservationId, type, amountMicros, new Date().toISOString());
  }

  #transaction<A>(operation: () => A): A {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (cause) {
      this.#database.exec("ROLLBACK");
      throw cause;
    }
  }
}
