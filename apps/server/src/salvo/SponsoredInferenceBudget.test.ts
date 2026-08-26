import { describe, expect, it } from "vite-plus/test";

import {
  commitSponsoredInference,
  emptySponsoredInferenceBudget,
  releaseSponsoredInference,
  reserveSponsoredInference,
  summarizeSponsoredInferenceBudget,
} from "./SponsoredInferenceBudget.js";

const config = { pilotCapMicros: 1_000, perUserCapMicros: 700, perTurnCapMicros: 500 };

describe("sponsored inference budget", () => {
  it("reserves atomically against turn, user, and pilot ceilings", () => {
    const first = reserveSponsoredInference(emptySponsoredInferenceBudget(), config, {
      id: "r1",
      userId: "u1",
      turnId: "t1",
      amountMicros: 400,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(
      reserveSponsoredInference(first.state, config, {
        id: "r2",
        userId: "u1",
        turnId: "t2",
        amountMicros: 301,
      }),
    ).toEqual({ ok: false, reason: "per_user_cap" });
    expect(
      reserveSponsoredInference(first.state, config, {
        id: "r2",
        userId: "u2",
        turnId: "t2",
        amountMicros: 501,
      }),
    ).toEqual({ ok: false, reason: "per_turn_cap" });
  });

  it("replays the same reservation without charging twice", () => {
    const input = { id: "r1", userId: "u1", turnId: "t1", amountMicros: 400 };
    const first = reserveSponsoredInference(emptySponsoredInferenceBudget(), config, input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = reserveSponsoredInference(first.state, config, input);
    expect(replay.ok && replay.replayed).toBe(true);
    expect(replay.ok && summarizeSponsoredInferenceBudget(replay.state).reservedMicros).toBe(400);
  });

  it("commits within the reservation and releases unused reservations", () => {
    const first = reserveSponsoredInference(emptySponsoredInferenceBudget(), config, {
      id: "r1",
      userId: "u1",
      turnId: "t1",
      amountMicros: 400,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const committed = commitSponsoredInference(first.state, "r1", 275);
    expect(summarizeSponsoredInferenceBudget(committed)).toEqual({
      committedMicros: 275,
      reservedMicros: 0,
    });

    const second = reserveSponsoredInference(committed, config, {
      id: "r2",
      userId: "u1",
      turnId: "t2",
      amountMicros: 300,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      summarizeSponsoredInferenceBudget(releaseSponsoredInference(second.state, "r2")),
    ).toEqual({ committedMicros: 275, reservedMicros: 0 });
  });

  it("cannot inflate a committed charge beyond its reservation", () => {
    const first = reserveSponsoredInference(emptySponsoredInferenceBudget(), config, {
      id: "r1",
      userId: "u1",
      turnId: "t1",
      amountMicros: 400,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(commitSponsoredInference(first.state, "r1", 401)).toBe(first.state);
  });
});
