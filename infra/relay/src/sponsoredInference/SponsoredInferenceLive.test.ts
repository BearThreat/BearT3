import { describe, expect, it } from "@effect/vitest";
import {
  isLiveConfigurationValid,
  type SponsoredInferenceLiveConfiguration,
} from "./SponsoredInferenceLive.ts";

const valid = (): SponsoredInferenceLiveConfiguration => ({
  apiKey: "secret",
  allowedModels: new Set(["gpt-salvo"]),
  maxOutputTokens: 1_000,
  maxTurnMicros: 1_000,
  userMicros: 10_000,
  pilotMicros: 100_000,
  inputMicrosPerMillionTokens: 1_250_000,
  outputMicrosPerMillionTokens: 10_000_000,
  timeoutMs: 1_000,
  maxAttempts: 2,
  grantTtlMs: 60_000,
});

describe("sponsored inference live layer selection", () => {
  it("fails closed when configuration is absent or cap hierarchy is invalid", () => {
    for (const config of [
      undefined,
      { ...valid(), maxTurnMicros: 20_000 },
      { ...valid(), userMicros: 200_000 },
    ]) {
      expect(isLiveConfigurationValid(config)).toBe(false);
    }
  });
});
