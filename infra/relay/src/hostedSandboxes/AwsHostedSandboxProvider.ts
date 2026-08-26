import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { SponsoredInferenceGrant } from "../sponsoredInference/SponsoredInferenceGateway.ts";

import {
  HostedSandboxProvider,
  HostedSandboxProviderFailed,
  layerUnavailable,
} from "./HostedSandboxProvider.ts";

export type AwsInstanceState =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "hibernating"
  | "hibernated"
  | "terminated";

export type AwsSandboxInstance = {
  readonly instanceId: string;
  readonly state: AwsInstanceState;
  readonly sandboxId: string;
  readonly userId: string;
  readonly imageId: string;
  readonly volume: {
    readonly volumeId: string;
    readonly encrypted: boolean;
    readonly sandboxId: string;
    readonly userId: string;
  };
};

export type AwsHostedSandboxConfig = {
  readonly region: string;
  readonly promotedImageId: string;
  readonly imageRelease: string;
  readonly launchTemplateId: string;
  readonly launchTemplateVersion: string;
  readonly instanceType: string;
  readonly subnetId: string;
  readonly securityGroupId: string;
  readonly instanceProfileArn: string;
};

export class AwsSandboxClientError extends Schema.TaggedErrorClass<AwsSandboxClientError>()(
  "AwsSandboxClientError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

/** Narrow, deterministic AWS boundary. The production implementation owns signing, retries and SDK calls. */
export class AwsSandboxLifecycleClient extends Context.Service<
  AwsSandboxLifecycleClient,
  {
    readonly findBySandboxId: (input: {
      readonly sandboxId: string;
    }) => Effect.Effect<ReadonlyArray<AwsSandboxInstance>, AwsSandboxClientError>;
    readonly runInstance: (input: {
      readonly clientToken: string;
      readonly sandboxId: string;
      readonly userId: string;
      readonly imageId: string;
      readonly imageRelease: string;
      readonly instanceType: string;
      readonly subnetId: string;
      readonly securityGroupId: string;
      readonly instanceProfileArn: string;
      readonly encryptedVolume: true;
      readonly hibernationPreferred: true;
      readonly tags: Readonly<Record<string, string>>;
    }) => Effect.Effect<{ readonly instanceId: string }, AwsSandboxClientError>;
    readonly startInstance: (input: {
      readonly instanceId: string;
    }) => Effect.Effect<void, AwsSandboxClientError>;
    readonly rebootstrapInstance: (input: {
      readonly instanceId: string;
      readonly sandboxId: string;
      readonly userId: string;
      readonly clientToken: string;
    }) => Effect.Effect<{ readonly commandId: string }, AwsSandboxClientError>;
    readonly stopInstance: (input: {
      readonly instanceId: string;
      readonly hibernate: boolean;
    }) => Effect.Effect<void, AwsSandboxClientError>;
    readonly tunnelHealth: (input: {
      readonly instanceId: string;
      readonly sandboxId: string;
    }) => Effect.Effect<
      { readonly ready: boolean; readonly endpoint: string | null },
      AwsSandboxClientError
    >;
    readonly sendPrompt: (input: {
      readonly endpoint: string;
      readonly sandboxId: string;
      readonly userId: string;
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
      AwsSandboxClientError
    >;
  }
>()("t3code-relay/hostedSandboxes/AwsHostedSandboxProvider/AwsSandboxLifecycleClient") {}

const CLIENT_TOKEN_PREFIX = "salvo-";

function clientToken(sandboxId: string): string {
  // sandboxId is already a durable UUID. AWS ClientToken accepts this stable, replay-safe value.
  return `${CLIENT_TOKEN_PREFIX}${sandboxId}`.slice(0, 64);
}

function validateOwned(instance: AwsSandboxInstance, sandboxId: string, userId?: string) {
  const ownsInstance =
    instance.sandboxId === sandboxId && (userId === undefined || instance.userId === userId);
  const ownsVolume =
    instance.volume.sandboxId === sandboxId && instance.volume.userId === instance.userId;
  if (!ownsInstance || !ownsVolume || !instance.volume.encrypted) {
    return new HostedSandboxProviderFailed({
      operation: "start",
      cause: "AWS instance or EBS ownership tags do not match the claimed sandbox",
    });
  }
  return null;
}

export const makeAwsHostedSandboxProvider = Effect.fn("salvo.aws_hosted_sandbox_provider.make")(
  function* (config: AwsHostedSandboxConfig) {
    const client = yield* AwsSandboxLifecycleClient;

    const inspectOne = Effect.fn("salvo.aws_hosted_sandbox_provider.inspect_one")(function* (
      sandboxId: string,
    ) {
      const matches = yield* client.findBySandboxId({ sandboxId });
      const live = matches.filter((item) => item.state !== "terminated");
      if (live.length > 1) {
        return yield* new HostedSandboxProviderFailed({
          operation: "start",
          cause: "multiple live AWS instances claim this sandbox",
        });
      }
      return live[0] ?? null;
    });

    return HostedSandboxProvider.of({
      start: Effect.fn("salvo.aws_hosted_sandbox_provider.start")(
        function* (input: {
          readonly sandboxId: string;
          readonly userId: string;
          readonly providerRef: string | null;
        }) {
          let instance = yield* inspectOne(input.sandboxId).pipe(
            Effect.mapError((cause) =>
              cause._tag === "HostedSandboxProviderFailed"
                ? cause
                : new HostedSandboxProviderFailed({ operation: "start", cause }),
            ),
          );
          if (instance) {
            const error = validateOwned(instance, input.sandboxId, input.userId);
            if (error) return yield* error;
            if (input.providerRef && input.providerRef !== instance.instanceId) {
              return yield* new HostedSandboxProviderFailed({
                operation: "start",
                cause: "persisted provider reference does not match owned AWS instance",
              });
            }
            if (instance.state === "stopped" || instance.state === "hibernated") {
              yield* client.startInstance({ instanceId: instance.instanceId });
              const bootstrap = yield* client.rebootstrapInstance({
                instanceId: instance.instanceId,
                sandboxId: input.sandboxId,
                userId: input.userId,
                clientToken: clientToken(input.sandboxId),
              });
              if (!bootstrap.commandId)
                return yield* new HostedSandboxProviderFailed({
                  operation: "start",
                  cause: "resume bootstrap command was not accepted",
                });
            }
            if (instance.state === "stopping" || instance.state === "hibernating") {
              return yield* new HostedSandboxProviderFailed({
                operation: "start",
                cause: `AWS instance is transitioning through ${instance.state}`,
              });
            }
            if (instance.state === "running" && input.providerRef) {
              const bootstrap = yield* client.rebootstrapInstance({
                instanceId: instance.instanceId,
                sandboxId: input.sandboxId,
                userId: input.userId,
                clientToken: clientToken(input.sandboxId),
              });
              if (!bootstrap.commandId)
                return yield* new HostedSandboxProviderFailed({
                  operation: "start",
                  cause: "running instance bootstrap command was not accepted",
                });
            }
            return { providerRef: instance.instanceId };
          }
          if (input.providerRef) {
            return yield* new HostedSandboxProviderFailed({
              operation: "start",
              cause: "persisted provider reference has no owned AWS instance",
            });
          }
          const launched = yield* client.runInstance({
            clientToken: clientToken(input.sandboxId),
            sandboxId: input.sandboxId,
            userId: input.userId,
            imageId: config.promotedImageId,
            imageRelease: config.imageRelease,
            instanceType: config.instanceType,
            subnetId: config.subnetId,
            securityGroupId: config.securityGroupId,
            instanceProfileArn: config.instanceProfileArn,
            encryptedVolume: true,
            hibernationPreferred: true,
            tags: {
              "salvo:sandbox-id": input.sandboxId,
              "salvo:user-id": input.userId,
              "salvo:image-release": config.imageRelease,
            },
          });
          return { providerRef: launched.instanceId };
        },
        Effect.mapError((cause) =>
          cause._tag === "HostedSandboxProviderFailed"
            ? cause
            : new HostedSandboxProviderFailed({ operation: "start", cause }),
        ),
      ),
      health: Effect.fn("salvo.aws_hosted_sandbox_provider.health")(
        function* (input: { readonly sandboxId: string; readonly providerRef: string }) {
          const instance = yield* inspectOne(input.sandboxId);
          if (!instance || instance.instanceId !== input.providerRef)
            return { ready: false, endpoint: null };
          const ownershipError = validateOwned(instance, input.sandboxId);
          if (ownershipError || instance.state !== "running")
            return { ready: false, endpoint: null };
          return yield* client.tunnelHealth({
            instanceId: instance.instanceId,
            sandboxId: input.sandboxId,
          });
        },
        Effect.mapError((cause) => new HostedSandboxProviderFailed({ operation: "health", cause })),
      ),
      stop: Effect.fn("salvo.aws_hosted_sandbox_provider.stop")(
        function* (input: { sandboxId: string; userId: string; providerRef: string }) {
          const instance = yield* inspectOne(input.sandboxId);
          if (
            !instance ||
            instance.instanceId !== input.providerRef ||
            validateOwned(instance, input.sandboxId, input.userId)
          ) {
            return yield* new HostedSandboxProviderFailed({
              operation: "stop",
              cause: "owned instance not found",
            });
          }
          if (instance.state === "stopped" || instance.state === "hibernated") return;
          yield* client.stopInstance({ instanceId: instance.instanceId, hibernate: true });
        },
        Effect.mapError((cause) =>
          cause._tag === "HostedSandboxProviderFailed"
            ? cause
            : new HostedSandboxProviderFailed({ operation: "stop", cause }),
        ),
      ),
      refreshControl: Effect.fn("salvo.aws_hosted_sandbox_provider.refresh_control")(
        function* (input: { sandboxId: string; userId: string; providerRef: string }) {
          const instance = yield* inspectOne(input.sandboxId);
          if (
            !instance ||
            instance.instanceId !== input.providerRef ||
            instance.state !== "running" ||
            validateOwned(instance, input.sandboxId, input.userId)
          ) {
            return yield* new HostedSandboxProviderFailed({
              operation: "start",
              cause: "running owned instance not found for control refresh",
            });
          }
          return yield* client.rebootstrapInstance({
            instanceId: instance.instanceId,
            sandboxId: input.sandboxId,
            userId: input.userId,
            clientToken: clientToken(input.sandboxId),
          });
        },
        Effect.mapError((cause) =>
          cause._tag === "HostedSandboxProviderFailed"
            ? cause
            : new HostedSandboxProviderFailed({ operation: "start", cause }),
        ),
      ),
      sendPrompt: Effect.fn("salvo.aws_hosted_sandbox_provider.send_prompt")(
        function* (input: {
          readonly sandboxId: string;
          readonly userId: string;
          readonly providerRef: string;
          readonly requestId: string;
          readonly prompt: string;
          readonly inferenceGrant: SponsoredInferenceGrant;
        }) {
          const health = yield* client.tunnelHealth({
            instanceId: input.providerRef,
            sandboxId: input.sandboxId,
          });
          if (!health.ready || !health.endpoint) {
            return yield* new HostedSandboxProviderFailed({
              operation: "send-prompt",
              cause: "managed tunnel is not healthy",
            });
          }
          return yield* client.sendPrompt({ endpoint: health.endpoint, ...input });
        },
        Effect.mapError((cause) =>
          cause._tag === "HostedSandboxProviderFailed"
            ? cause
            : new HostedSandboxProviderFailed({ operation: "send-prompt", cause }),
        ),
      ),
    });
  },
);

export const layerAws = (config: AwsHostedSandboxConfig) =>
  Layer.effect(HostedSandboxProvider, makeAwsHostedSandboxProvider(config));

const requiredKeys = [
  "region",
  "promotedImageId",
  "imageRelease",
  "launchTemplateId",
  "launchTemplateVersion",
  "instanceType",
  "subnetId",
  "securityGroupId",
  "instanceProfileArn",
] as const;

export const awsHostedSandboxConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Partial<AwsHostedSandboxConfig> => ({
  ...(env.SALVO_AWS_REGION ? { region: env.SALVO_AWS_REGION } : {}),
  ...(env.SALVO_AWS_PROMOTED_AMI_ID ? { promotedImageId: env.SALVO_AWS_PROMOTED_AMI_ID } : {}),
  ...(env.SALVO_AWS_IMAGE_RELEASE ? { imageRelease: env.SALVO_AWS_IMAGE_RELEASE } : {}),
  ...(env.SALVO_AWS_LAUNCH_TEMPLATE_ID
    ? { launchTemplateId: env.SALVO_AWS_LAUNCH_TEMPLATE_ID }
    : {}),
  ...(env.SALVO_AWS_LAUNCH_TEMPLATE_VERSION
    ? { launchTemplateVersion: env.SALVO_AWS_LAUNCH_TEMPLATE_VERSION }
    : {}),
  ...(env.SALVO_AWS_INSTANCE_TYPE ? { instanceType: env.SALVO_AWS_INSTANCE_TYPE } : {}),
  ...(env.SALVO_AWS_SUBNET_ID ? { subnetId: env.SALVO_AWS_SUBNET_ID } : {}),
  ...(env.SALVO_AWS_SECURITY_GROUP_ID ? { securityGroupId: env.SALVO_AWS_SECURITY_GROUP_ID } : {}),
  ...(env.SALVO_AWS_INSTANCE_PROFILE_ARN
    ? { instanceProfileArn: env.SALVO_AWS_INSTANCE_PROFILE_ARN }
    : {}),
});

/** Fail-closed composition: partial configuration never enables AWS mutations. */
export function selectHostedSandboxProviderLayer(
  config: Partial<AwsHostedSandboxConfig>,
  awsClientLayer?: Layer.Layer<AwsSandboxLifecycleClient>,
): Layer.Layer<HostedSandboxProvider> {
  if (!awsClientLayer || !requiredKeys.every((key) => Boolean(config[key]?.trim())))
    return layerUnavailable;
  return layerAws(config as AwsHostedSandboxConfig).pipe(Layer.provide(awsClientLayer));
}
