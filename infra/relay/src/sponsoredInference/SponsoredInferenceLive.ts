import * as Layer from "effect/Layer";

import {
  layer as gatewayLayer,
  layerUnavailable,
  SponsoredInferenceRuntimeConfig,
} from "./SponsoredInferenceGateway.ts";
import {
  makeOpenAiResponsesProvider,
  type OpenAiResponsesProviderDependencies,
  type SponsoredInferenceProviderConfiguration,
} from "./OpenAiResponsesProvider.ts";

export type SponsoredInferenceLiveConfiguration = SponsoredInferenceProviderConfiguration & {
  readonly pilotMicros: number;
  readonly userMicros: number;
  readonly grantTtlMs: number;
};

const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

export const isLiveConfigurationValid = (
  config: SponsoredInferenceLiveConfiguration | undefined,
): config is SponsoredInferenceLiveConfiguration =>
  config !== undefined &&
  positiveInteger(config.pilotMicros) &&
  positiveInteger(config.userMicros) &&
  positiveInteger(config.grantTtlMs) &&
  config.userMicros <= config.pilotMicros &&
  config.maxTurnMicros <= config.userMicros;

/** Selects the durable database-backed gateway only for a complete, internally consistent configuration. */
export const layerFromConfiguration = (
  config: SponsoredInferenceLiveConfiguration | undefined,
  dependencies: OpenAiResponsesProviderDependencies,
) => {
  if (!isLiveConfigurationValid(config)) return layerUnavailable;
  const provider = makeOpenAiResponsesProvider(config, dependencies);
  if (provider === undefined) return layerUnavailable;
  return gatewayLayer.pipe(
    Layer.provide(
      Layer.succeed(
        SponsoredInferenceRuntimeConfig,
        SponsoredInferenceRuntimeConfig.of({
          provider,
          allowedModels: config.allowedModels,
          caps: {
            pilotMicros: config.pilotMicros,
            userMicros: config.userMicros,
            turnMicros: config.maxTurnMicros,
          },
          grantTtlMs: config.grantTtlMs,
        }),
      ),
    ),
  );
};
