import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { SponsoredInferenceLiveConfiguration } from "./sponsoredInference/SponsoredInferenceLive.ts";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly apns: ApnsCredentials;
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    /** Clerk user IDs allowed to use the local Salvo operator surface. Empty means nobody. */
    readonly salvoOperatorUserIds?: ReadonlySet<string>;
    /** Clerk user IDs admitted to the private Salvo pilot. Empty means nobody. */
    readonly salvoPilotUserIds?: ReadonlySet<string>;
  }
>()("t3code-relay/Config/RelayConfiguration") {}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));

export const parseSalvoUserIds = (value: string | undefined): ReadonlySet<string> =>
  new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

export const assertSalvoPilotSubset = (input: {
  readonly enabled: boolean;
  readonly operatorUserIds: ReadonlySet<string>;
  readonly pilotUserIds: ReadonlySet<string>;
}) => {
  if (
    input.enabled &&
    [...input.pilotUserIds].some((userId) => !input.operatorUserIds.has(userId))
  ) {
    throw new Error("salvo_pilot_users_must_be_operator_subset");
  }
};

export type SalvoSponsoredEnvironment = {
  readonly apiKey?: string | undefined;
  readonly models?: string | undefined;
  readonly maxOutputTokens?: string | undefined;
  readonly turnMicros?: string | undefined;
  readonly userMicros?: string | undefined;
  readonly pilotMicros?: string | undefined;
  readonly inputRate?: string | undefined;
  readonly outputRate?: string | undefined;
  readonly timeoutMs?: string | undefined;
  readonly maxAttempts?: string | undefined;
  readonly grantTtlMs?: string | undefined;
};

const sponsoredKeys = [
  "apiKey",
  "models",
  "maxOutputTokens",
  "turnMicros",
  "userMicros",
  "pilotMicros",
  "inputRate",
  "outputRate",
  "timeoutMs",
  "maxAttempts",
  "grantTtlMs",
] as const;

/** Disabled when entirely absent; partial or unsafe sponsored inference settings stop deployment. */
export function parseSalvoSponsoredConfiguration(
  environment: SalvoSponsoredEnvironment,
): SponsoredInferenceLiveConfiguration | undefined {
  const present = sponsoredKeys.filter((key) => environment[key]?.trim());
  if (present.length === 0) return undefined;
  if (present.length !== sponsoredKeys.length)
    throw new Error("incomplete_salvo_sponsored_configuration");
  const models = new Set(
    environment
      .models!.split(",")
      .map((model) => model.trim())
      .filter(Boolean),
  );
  const integer = (key: Exclude<(typeof sponsoredKeys)[number], "apiKey" | "models">) => {
    const value = Number(environment[key]);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`invalid_salvo_sponsored_${key}`);
    return value;
  };
  if (models.size === 0) throw new Error("invalid_salvo_sponsored_models");
  const configuration = {
    apiKey: environment.apiKey!,
    allowedModels: models,
    maxOutputTokens: integer("maxOutputTokens"),
    maxTurnMicros: integer("turnMicros"),
    userMicros: integer("userMicros"),
    pilotMicros: integer("pilotMicros"),
    inputMicrosPerMillionTokens: integer("inputRate"),
    outputMicrosPerMillionTokens: integer("outputRate"),
    timeoutMs: integer("timeoutMs"),
    maxAttempts: integer("maxAttempts"),
    grantTtlMs: integer("grantTtlMs"),
  } satisfies SponsoredInferenceLiveConfiguration;
  if (
    configuration.maxAttempts > 3 ||
    configuration.timeoutMs > 120_000 ||
    configuration.grantTtlMs > 3_600_000 ||
    configuration.maxOutputTokens > 100_000 ||
    configuration.maxTurnMicros > configuration.userMicros ||
    configuration.userMicros > configuration.pilotMicros ||
    Math.ceil(
      (1_100_000 * configuration.inputMicrosPerMillionTokens +
        configuration.maxOutputTokens * configuration.outputMicrosPerMillionTokens) /
        1_000_000,
    ) > configuration.maxTurnMicros
  ) {
    throw new Error("unsafe_salvo_sponsored_configuration");
  }
  return configuration;
}
