import { describe, expect, it } from "vite-plus/test";

import {
  assertSalvoPilotSubset,
  parseSalvoSponsoredConfiguration,
  parseSalvoUserIds,
} from "./Config.ts";

const valid = {
  apiKey: "test-key",
  models: "gpt-5.1-codex-mini, gpt-5.1-codex-mini",
  maxOutputTokens: "8192",
  turnMicros: "500000",
  userMicros: "5000000",
  pilotMicros: "25000000",
  inputRate: "250000",
  outputRate: "2000000",
  timeoutMs: "60000",
  maxAttempts: "2",
  grantTtlMs: "300000",
};

describe("Salvo relay configuration", () => {
  it("normalizes allowlists and sponsored inference settings", () => {
    expect([...parseSalvoUserIds(" user_a, user_b,user_a, ")]).toEqual(["user_a", "user_b"]);
    const parsed = parseSalvoSponsoredConfiguration(valid)!;
    expect([...parsed.allowedModels]).toEqual(["gpt-5.1-codex-mini"]);
    expect(parsed).toMatchObject({ maxOutputTokens: 8192, maxTurnMicros: 500000, maxAttempts: 2 });
  });

  it("keeps sponsored inference disabled when every setting is absent", () => {
    expect(parseSalvoSponsoredConfiguration({})).toBeUndefined();
  });

  it("requires pilot users to be operators while canary mode is enabled", () => {
    expect(() =>
      assertSalvoPilotSubset({
        enabled: true,
        operatorUserIds: new Set(["operator-a"]),
        pilotUserIds: new Set(["operator-a"]),
      }),
    ).not.toThrow();
    expect(() =>
      assertSalvoPilotSubset({
        enabled: false,
        operatorUserIds: new Set(),
        pilotUserIds: new Set(["pilot-a"]),
      }),
    ).not.toThrow();
    expect(() =>
      assertSalvoPilotSubset({
        enabled: true,
        operatorUserIds: new Set(["operator-a"]),
        pilotUserIds: new Set(["pilot-a"]),
      }),
    ).toThrow("salvo_pilot_users_must_be_operator_subset");
  });

  it("rejects partial, non-integer, excessive, and inconsistent caps", () => {
    expect(() => parseSalvoSponsoredConfiguration({ apiKey: "test-key" })).toThrow("incomplete");
    expect(() => parseSalvoSponsoredConfiguration({ ...valid, maxOutputTokens: "1.5" })).toThrow(
      "invalid",
    );
    expect(() => parseSalvoSponsoredConfiguration({ ...valid, maxAttempts: "4" })).toThrow(
      "unsafe",
    );
    expect(() => parseSalvoSponsoredConfiguration({ ...valid, userMicros: "100000" })).toThrow(
      "unsafe",
    );
    expect(() => parseSalvoSponsoredConfiguration({ ...valid, turnMicros: "1000" })).toThrow(
      "unsafe",
    );
  });
});
