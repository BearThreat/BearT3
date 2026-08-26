import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeOpenAiResponsesProvider,
  type SponsoredInferenceProviderConfiguration,
} from "./OpenAiResponsesProvider.ts";

const configuration = (
  overrides: Partial<SponsoredInferenceProviderConfiguration> = {},
): SponsoredInferenceProviderConfiguration => ({
  apiKey: "top-secret-key",
  allowedModels: new Set(["gpt-salvo"]),
  maxOutputTokens: 2_000,
  maxTurnMicros: 10_000,
  inputMicrosPerMillionTokens: 1_250_000,
  outputMicrosPerMillionTokens: 10_000_000,
  timeoutMs: 1_000,
  maxAttempts: 2,
  ...overrides,
});

const success = () =>
  new Response(
    JSON.stringify({
      id: "resp_123",
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
      secret_echo: "must be ignored",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("OpenAI Responses sponsored inference provider", () => {
  it.effect("sends an allowlisted bounded request and accounts usage", () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const provider = makeOpenAiResponsesProvider(configuration(), {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return success();
      },
    })!;
    return Effect.gen(function* () {
      const result = yield* provider.execute({
        idempotencyKey: "request-1",
        model: "gpt-salvo",
        prompt: "Hi",
        maxOutputTokens: 200,
      });
      expect(result).toEqual({ text: "Hello", billedMicros: 325 });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.headers).toMatchObject({
        "X-Client-Request-Id": "request-1",
        Authorization: "Bearer top-secret-key",
      });
      expect(String(calls[0]!.init.body)).toBe(
        '{"model":"gpt-salvo","input":"Hi","max_output_tokens":200}',
      );
      expect(result.text).not.toContain("top-secret-key");
      expect(result.text).not.toContain("secret_echo");
    });
  });

  it.effect("uses the same client request id on bounded retry", () => {
    const ids: Array<string | null> = [];
    let calls = 0;
    const provider = makeOpenAiResponsesProvider(configuration(), {
      fetch: async (_url, init) => {
        ids.push(new Headers(init.headers).get("X-Client-Request-Id"));
        return ++calls === 1 ? new Response("busy", { status: 503 }) : success();
      },
      sleep: async () => undefined,
    })!;
    return Effect.gen(function* () {
      yield* provider.execute({
        idempotencyKey: "stable-id",
        model: "gpt-salvo",
        prompt: "Hi",
        maxOutputTokens: 200,
      });
      expect(ids).toEqual(["stable-id", "stable-id"]);
    });
  });

  it.effect(
    "fails on provider errors, disallowed models, and provider usage above the turn cap",
    () => {
      let calls = 0;
      const provider = makeOpenAiResponsesProvider(configuration({ maxTurnMicros: 100 }), {
        fetch: async () => {
          calls++;
          return success();
        },
      })!;
      return Effect.gen(function* () {
        yield* Effect.flip(
          provider.execute({
            idempotencyKey: "bad-model",
            model: "other",
            prompt: "Hi",
            maxOutputTokens: 10,
          }),
        );
        yield* Effect.flip(
          provider.execute({
            idempotencyKey: "over-budget",
            model: "gpt-salvo",
            prompt: "Hi",
            maxOutputTokens: 10,
          }),
        );
        expect(calls).toBe(1);

        const failed = makeOpenAiResponsesProvider(configuration({ maxAttempts: 1 }), {
          fetch: async () => new Response("provider secret", { status: 400 }),
        })!;
        const error = yield* Effect.flip(
          failed.execute({
            idempotencyKey: "failed",
            model: "gpt-salvo",
            prompt: "Hi",
            maxOutputTokens: 10,
          }),
        );
        expect(String(error.cause)).not.toContain("provider secret");
        expect(String(error.cause)).not.toContain("top-secret-key");
      });
    },
  );

  it("is unavailable unless every secret, model, cap, rate, timeout, and retry setting is valid", () => {
    for (const invalid of [
      configuration({ apiKey: "" }),
      configuration({ allowedModels: new Set() }),
      configuration({ maxOutputTokens: 0 }),
      configuration({ maxTurnMicros: 0 }),
      configuration({ inputMicrosPerMillionTokens: 0 }),
      configuration({ outputMicrosPerMillionTokens: 0 }),
      configuration({ timeoutMs: 0 }),
      configuration({ maxAttempts: 4 }),
      configuration({ endpoint: "https://example.com" }),
    ])
      expect(makeOpenAiResponsesProvider(invalid, { fetch: globalThis.fetch })).toBeUndefined();
  });
});
