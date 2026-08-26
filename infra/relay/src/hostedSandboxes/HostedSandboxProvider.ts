import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { SponsoredInferenceGrant } from "../sponsoredInference/SponsoredInferenceGateway.ts";

export class HostedSandboxProviderNotConfigured extends Schema.TaggedErrorClass<HostedSandboxProviderNotConfigured>()(
  "HostedSandboxProviderNotConfigured",
  {},
) {}

export class HostedSandboxProviderFailed extends Schema.TaggedErrorClass<HostedSandboxProviderFailed>()(
  "HostedSandboxProviderFailed",
  {
    operation: Schema.Literals(["start", "health", "stop", "send-prompt"]),
    cause: Schema.Defect(),
  },
) {}

export class HostedSandboxProvider extends Context.Service<
  HostedSandboxProvider,
  {
    readonly start: (input: {
      readonly sandboxId: string;
      readonly userId: string;
      readonly providerRef: string | null;
    }) => Effect.Effect<
      { readonly providerRef: string },
      HostedSandboxProviderNotConfigured | HostedSandboxProviderFailed
    >;
    readonly health: (input: {
      readonly sandboxId: string;
      readonly providerRef: string;
    }) => Effect.Effect<
      { readonly ready: boolean; readonly endpoint: string | null },
      HostedSandboxProviderNotConfigured | HostedSandboxProviderFailed
    >;
    readonly stop: (input: {
      readonly sandboxId: string;
      readonly userId: string;
      readonly providerRef: string;
    }) => Effect.Effect<void, HostedSandboxProviderNotConfigured | HostedSandboxProviderFailed>;
    readonly refreshControl: (input: {
      readonly sandboxId: string;
      readonly userId: string;
      readonly providerRef: string;
    }) => Effect.Effect<
      { readonly commandId: string },
      HostedSandboxProviderNotConfigured | HostedSandboxProviderFailed
    >;
    readonly sendPrompt: (input: {
      readonly sandboxId: string;
      readonly userId: string;
      readonly providerRef: string;
      readonly requestId: string;
      readonly prompt: string;
      readonly inferenceGrant: SponsoredInferenceGrant;
    }) => Effect.Effect<
      {
        readonly requestId: string;
        readonly sandboxId: string;
        readonly sandboxExecutionReceiptId: string;
        readonly gatewayProviderReceiptId: string;
        readonly acceptedAt: string;
      },
      HostedSandboxProviderNotConfigured | HostedSandboxProviderFailed
    >;
  }
>()("t3code-relay/hostedSandboxes/HostedSandboxProvider") {}

const unavailable = () => Effect.fail(new HostedSandboxProviderNotConfigured());

/** Production default. Deployments must explicitly install an audited provider. */
export const layerUnavailable = Layer.succeed(
  HostedSandboxProvider,
  HostedSandboxProvider.of({
    start: unavailable,
    health: unavailable,
    stop: unavailable,
    refreshControl: unavailable,
    sendPrompt: unavailable,
  }),
);
