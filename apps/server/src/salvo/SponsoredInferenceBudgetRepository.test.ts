// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { SponsoredInferenceBudgetRepository } from "./SponsoredInferenceBudgetRepository.js";

const config = { pilotCapMicros: 1_000, perUserCapMicros: 700, perTurnCapMicros: 500 };
const tempDirectories: Array<string> = [];

const databasePath = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "salvo-budget-"));
  tempDirectories.push(directory);
  return NodePath.join(directory, "budget.sqlite");
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("SponsoredInferenceBudgetRepository", () => {
  it("survives restart with reservations, commits, and its audit history intact", () => {
    const filename = databasePath();
    const first = new SponsoredInferenceBudgetRepository(filename);
    expect(
      first.reserve(config, { id: "r1", userId: "u1", turnId: "t1", amountMicros: 400 }).ok,
    ).toBe(true);
    expect(first.commit("r1", 275)).toMatchObject({ ok: true, replayed: false });
    first.close();

    using restarted = new SponsoredInferenceBudgetRepository(filename);
    expect(restarted.summarize()).toEqual({ committedMicros: 275, reservedMicros: 0 });
    expect(restarted.readState().reservations.r1).toMatchObject({
      state: "committed",
      billedMicros: 275,
    });
    expect(restarted.events().map(({ type, amountMicros }) => ({ type, amountMicros }))).toEqual([
      { type: "reserved", amountMicros: 400 },
      { type: "committed", amountMicros: 275 },
    ]);
  });

  it("replays all transitions without charging or recording twice", () => {
    using repository = new SponsoredInferenceBudgetRepository(databasePath());
    const input = { id: "r1", userId: "u1", turnId: "t1", amountMicros: 400 };
    expect(repository.reserve(config, input)).toMatchObject({ ok: true, replayed: false });
    expect(repository.reserve(config, input)).toMatchObject({ ok: true, replayed: true });
    expect(repository.commit("r1", 275)).toMatchObject({ ok: true, replayed: false });
    expect(repository.commit("r1", 275)).toMatchObject({ ok: true, replayed: true });
    expect(repository.events()).toHaveLength(2);

    expect(
      repository.reserve(config, { id: "r2", userId: "u1", turnId: "t2", amountMicros: 300 }),
    ).toMatchObject({ ok: true, replayed: false });
    expect(repository.release("r2")).toMatchObject({ ok: true, replayed: false });
    expect(repository.release("r2")).toMatchObject({ ok: true, replayed: true });
    expect(repository.summarize()).toEqual({ committedMicros: 275, reservedMicros: 0 });
    expect(repository.events()).toHaveLength(4);
  });

  it("serializes cap checks across independent repository connections", () => {
    const filename = databasePath();
    using first = new SponsoredInferenceBudgetRepository(filename);
    using second = new SponsoredInferenceBudgetRepository(filename);
    expect(
      first.reserve(config, { id: "r1", userId: "u1", turnId: "t1", amountMicros: 500 }),
    ).toMatchObject({ ok: true });
    expect(
      second.reserve(config, { id: "r2", userId: "u1", turnId: "t2", amountMicros: 201 }),
    ).toEqual({ ok: false, reason: "per_user_cap" });
    expect(second.summarize()).toEqual({ committedMicros: 0, reservedMicros: 500 });
  });

  it("rejects conflicting replays and illegal terminal transitions", () => {
    using repository = new SponsoredInferenceBudgetRepository(databasePath());
    expect(
      repository.reserve(config, { id: "r1", userId: "u1", turnId: "t1", amountMicros: 400 }),
    ).toMatchObject({ ok: true });
    expect(
      repository.reserve(config, {
        id: "r1",
        userId: "u1",
        turnId: "different",
        amountMicros: 400,
      }),
    ).toEqual({ ok: false, reason: "invalid_amount" });
    expect(repository.commit("r1", 401)).toEqual({ ok: false, reason: "invalid_amount" });
    expect(repository.release("r1")).toMatchObject({ ok: true });
    expect(repository.commit("r1", 200)).toEqual({ ok: false, reason: "invalid_state" });
    expect(repository.events().map((event) => event.type)).toEqual(["reserved", "released"]);
  });
});
