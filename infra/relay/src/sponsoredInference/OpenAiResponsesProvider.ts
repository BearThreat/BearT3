import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  SponsoredInferenceProviderError,
  type SponsoredInferenceProvider,
} from "./SponsoredInferenceGateway.ts";

export type SponsoredInferenceProviderConfiguration = {
  readonly apiKey: string;
  readonly allowedModels: ReadonlySet<string>;
  readonly maxOutputTokens: number;
  readonly maxTurnMicros: number;
  /** USD micros charged per one million tokens. */
  readonly inputMicrosPerMillionTokens: number;
  /** USD micros charged per one million tokens. */
  readonly outputMicrosPerMillionTokens: number;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly endpoint?: string;
};

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type OpenAiResponsesProviderDependencies = {
  readonly fetch: Fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

const RequestBodyJson = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    input: Schema.String,
    max_output_tokens: Schema.Number,
  }),
);

const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

export const validateConfiguration = (
  config: SponsoredInferenceProviderConfiguration,
): config is SponsoredInferenceProviderConfiguration =>
  config.apiKey.length > 0 &&
  config.allowedModels.size > 0 &&
  [...config.allowedModels].every((model) => model.length > 0 && model.length <= 191) &&
  positiveInteger(config.maxOutputTokens) &&
  positiveInteger(config.maxTurnMicros) &&
  positiveInteger(config.inputMicrosPerMillionTokens) &&
  positiveInteger(config.outputMicrosPerMillionTokens) &&
  positiveInteger(config.timeoutMs) &&
  config.timeoutMs <= 120_000 &&
  positiveInteger(config.maxAttempts) &&
  config.maxAttempts <= 3 &&
  (config.endpoint === undefined || config.endpoint === "https://api.openai.com/v1/responses");

const providerFailure = () =>
  new SponsoredInferenceProviderError({ cause: "OpenAI Responses request failed" });

const retryableStatus = (status: number) =>
  status === 408 || status === 409 || status === 429 || status >= 500;

const outputText = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const output = (payload as { readonly output?: unknown }).output;
  if (!Array.isArray(output)) return undefined;
  const text: Array<string> = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as { readonly content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { readonly type?: unknown }).type === "output_text" &&
        typeof (part as { readonly text?: unknown }).text === "string"
      )
        text.push((part as { readonly text: string }).text);
    }
  }
  return text.join("");
};

const usage = (
  payload: unknown,
): { readonly inputTokens: number; readonly outputTokens: number } | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as { readonly usage?: unknown }).usage;
  if (typeof value !== "object" || value === null) return undefined;
  const inputTokens = (value as { readonly input_tokens?: unknown }).input_tokens;
  const outputTokens = (value as { readonly output_tokens?: unknown }).output_tokens;
  if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0) return undefined;
  if (!Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) return undefined;
  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number };
};

export const calculateBilledMicros = (
  inputTokens: number,
  outputTokens: number,
  config: Pick<
    SponsoredInferenceProviderConfiguration,
    "inputMicrosPerMillionTokens" | "outputMicrosPerMillionTokens"
  >,
) =>
  Math.ceil(
    (inputTokens * config.inputMicrosPerMillionTokens +
      outputTokens * config.outputMicrosPerMillionTokens) /
      1_000_000,
  );

export const makeOpenAiResponsesProvider = (
  config: SponsoredInferenceProviderConfiguration,
  dependencies: OpenAiResponsesProviderDependencies,
): SponsoredInferenceProvider | undefined => {
  if (!validateConfiguration(config)) return undefined;
  const sleep =
    dependencies.sleep ?? ((milliseconds) => Effect.runPromise(Effect.sleep(milliseconds)));
  return {
    execute: (input) =>
      Effect.gen(function* () {
        if (
          !config.allowedModels.has(input.model) ||
          !positiveInteger(input.maxOutputTokens) ||
          input.maxOutputTokens > config.maxOutputTokens
        )
          return yield* Effect.fail(providerFailure());
        const requestBody = yield* Schema.encodeEffect(RequestBodyJson)({
          model: input.model,
          input: input.prompt,
          max_output_tokens: input.maxOutputTokens,
        }).pipe(Effect.mapError(providerFailure));
        return yield* Effect.tryPromise({
          try: async () => {
            for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
              let mayRetry = true;
              try {
                const response = await dependencies.fetch(
                  config.endpoint ?? "https://api.openai.com/v1/responses",
                  {
                    method: "POST",
                    signal: AbortSignal.timeout(config.timeoutMs),
                    headers: {
                      Authorization: `Bearer ${config.apiKey}`,
                      "Content-Type": "application/json",
                      "X-Client-Request-Id": input.idempotencyKey,
                    },
                    body: requestBody,
                  },
                );
                if (!response.ok) {
                  if (retryableStatus(response.status) && attempt < config.maxAttempts) {
                    await sleep(100 * 2 ** (attempt - 1));
                    continue;
                  }
                  mayRetry = false;
                  throw providerFailure();
                }
                const payload: unknown = await response.json();
                const text = outputText(payload);
                const tokenUsage = usage(payload);
                if (text === undefined || tokenUsage === undefined || text.length > 4_000_000) {
                  mayRetry = false;
                  throw providerFailure();
                }
                const billedMicros = calculateBilledMicros(
                  tokenUsage.inputTokens,
                  tokenUsage.outputTokens,
                  config,
                );
                if (
                  !Number.isSafeInteger(billedMicros) ||
                  billedMicros < 0 ||
                  billedMicros > config.maxTurnMicros
                ) {
                  mayRetry = false;
                  throw providerFailure();
                }
                return { text, billedMicros };
              } catch (error) {
                if (mayRetry && attempt < config.maxAttempts) {
                  await sleep(100 * 2 ** (attempt - 1));
                  continue;
                }
                throw providerFailure();
              }
            }
            throw providerFailure();
          },
          catch: () => providerFailure(),
        });
      }),
  };
};
