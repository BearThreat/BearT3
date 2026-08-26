import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  clientApi,
  dpopClientApi,
  healthApi,
  metadataApi,
  mobileApi,
  relayClientAuthLayer,
  relayDpopClientAuthLayer,
  relayCors,
  relayDocsRedirectRoute,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  traceRelayHttpRequestWith,
  tokenApi,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./zone.ts";
import { makeRelayTraceLayer, RelayObservability } from "./observability.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as RelayDb from "./db.ts";
import { RelayApnsDeliveryDeadLetterQueue, RelayApnsDeliveryQueue } from "./queues.ts";
import * as RelayConfiguration from "./Config.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";
import * as SupportIssues from "./support/SupportIssues.ts";
import {
  awsHostedSandboxConfigFromEnv,
  selectHostedSandboxProviderLayer,
} from "./hostedSandboxes/AwsHostedSandboxProvider.ts";
import {
  layerWorkerAwsSandboxLifecycleClient,
  parseAwsTemporaryCredentials,
} from "./hostedSandboxes/WorkerAwsSandboxLifecycleClient.ts";
import * as HostedSandboxRepository from "./hostedSandboxes/HostedSandboxRepository.ts";
import * as HostedSandboxes from "./hostedSandboxes/HostedSandboxes.ts";
import * as HostedSandboxIdleDrain from "./hostedSandboxes/HostedSandboxIdleDrain.ts";
import * as HostedSandboxControlRotation from "./hostedSandboxes/HostedSandboxControlRotation.ts";
import * as SandboxBootstrapTokens from "./hostedSandboxes/SandboxBootstrapTokens.ts";
import * as SandboxBootstrapHttp from "./hostedSandboxes/SandboxBootstrapHttp.ts";
import * as SandboxTunnelHttp from "./hostedSandboxes/SandboxTunnelHttp.ts";
import { makeSandboxTunnelProvisioner } from "./hostedSandboxes/SandboxTunnelProvisioner.ts";
import * as SponsoredInferenceLive from "./sponsoredInference/SponsoredInferenceLive.ts";
import * as SponsoredInferenceHttp from "./sponsoredInference/SponsoredInferenceHttp.ts";
import * as SponsoredResponsesProxy from "./sponsoredInference/SponsoredResponsesProxy.ts";
import * as GauntletProbe from "./gauntlet/GauntletProbe.ts";
import * as GauntletProbeHttp from "./gauntlet/GauntletProbeHttp.ts";
import * as GauntletProbeLive from "./gauntlet/GauntletProbeLive.ts";
import * as CanaryBudgetAuthority from "./canary/CanaryBudgetAuthority.ts";
import * as AuthoritativeLiabilityReaderLive from "./canary/AuthoritativeLiabilityReaderLive.ts";
import * as CanaryBudgetHttp from "./canary/CanaryBudgetHttp.ts";

const webcryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const httpPlatformNotSupportedLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  tokenApi,
  dpopClientApi,
  serverApi,
);

const CloudMintKeyPair = Alchemy.KeyPair("CloudMintKeyPair");
const ApnsDeliveryJobSigningSecret = Alchemy.makeRandom("ApnsDeliveryJobSigningSecret", {
  bytes: 32,
});

export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}

export const ApiLive = Api.make(
  RelayDeploymentConfig.pipe(
    Effect.map(({ relayPublicDomain }) => ({
      main: import.meta.filename,
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      domain: relayPublicDomain,
    })),
    Effect.orDie,
  ),
  Effect.gen(function* () {
    //
    // 1. Provision Infrastructure for the Worker to use
    //
    const { relayPublicOrigin, stage } = yield* RelayDeploymentConfig;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const relayApiZone = yield* RelayApiZone;
    const managedEndpointZone = yield* ManagedEndpointZone;
    const randomApnsDeliveryJobSigningSecret = yield* ApnsDeliveryJobSigningSecret;
    const observability = yield* RelayObservability;

    //
    // 2. Create bindings
    //
    const environment = yield* Config.schema(
      RelayConfiguration.ApnsEnvironment,
      "APNS_ENVIRONMENT",
    );
    const apnsTeamId = yield* Config.string("APNS_TEAM_ID");
    const apnsKeyId = yield* Config.string("APNS_KEY_ID");
    const apnsBundleId = yield* Config.string("APNS_BUNDLE_ID");
    const apnsPrivateKey = yield* Config.redacted("APNS_PRIVATE_KEY");
    const apnsDeliveryJobSigningSecret = yield* randomApnsDeliveryJobSigningSecret;
    const apnsDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(apnsDeliveryQueue);

    const axiomDatasetName = yield* observability.traces.name;
    const axiomIngestToken = yield* observability.workerIngestToken.token;
    const axiomTracesEndpoint = yield* observability.traces.otelTracesEndpoint;

    const clerkSecretKey = yield* Config.redacted("CLERK_SECRET_KEY");
    const clerkPublishableKey = yield* Config.string("CLERK_PUBLISHABLE_KEY");
    const clerkJwtAudience = yield* Config.string("CLERK_JWT_AUDIENCE");
    const salvoOperatorUserIds = RelayConfiguration.parseSalvoUserIds(
      yield* Config.string("SALVO_OPERATOR_USER_IDS").pipe(
        Config.option,
        Config.map(Option.getOrUndefined),
      ),
    );
    const salvoPilotUserIds = RelayConfiguration.parseSalvoUserIds(
      yield* Config.string("SALVO_PILOT_USER_IDS").pipe(
        Config.option,
        Config.map(Option.getOrUndefined),
      ),
    );
    const optionalString = (name: string) =>
      Config.string(name).pipe(Config.option, Config.map(Option.getOrUndefined));
    const salvoAwsEnvironment = {
      SALVO_AWS_REGION: yield* optionalString("SALVO_AWS_REGION"),
      SALVO_AWS_PROMOTED_AMI_ID: yield* optionalString("SALVO_AWS_PROMOTED_AMI_ID"),
      SALVO_AWS_IMAGE_RELEASE: yield* optionalString("SALVO_AWS_IMAGE_RELEASE"),
      SALVO_AWS_LAUNCH_TEMPLATE_ID: yield* optionalString("SALVO_AWS_LAUNCH_TEMPLATE_ID"),
      SALVO_AWS_LAUNCH_TEMPLATE_VERSION: yield* optionalString("SALVO_AWS_LAUNCH_TEMPLATE_VERSION"),
      SALVO_AWS_INSTANCE_TYPE: yield* optionalString("SALVO_AWS_INSTANCE_TYPE"),
      SALVO_AWS_SUBNET_ID: yield* optionalString("SALVO_AWS_SUBNET_ID"),
      SALVO_AWS_SECURITY_GROUP_ID: yield* optionalString("SALVO_AWS_SECURITY_GROUP_ID"),
      SALVO_AWS_INSTANCE_PROFILE_ARN: yield* optionalString("SALVO_AWS_INSTANCE_PROFILE_ARN"),
    };
    const salvoAwsCredentialsSecret = yield* Config.redacted(
      "SALVO_AWS_TEMPORARY_CREDENTIALS",
    ).pipe(Config.option, Config.map(Option.getOrUndefined));
    const salvoSandboxGatewayOrigin = yield* optionalString("SALVO_SANDBOX_GATEWAY_ORIGIN");
    const salvoSandboxGatewayToken = yield* Config.redacted("SALVO_SANDBOX_GATEWAY_TOKEN").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    const salvoSandboxBootstrapMasterKey = yield* Config.redacted(
      "SALVO_SANDBOX_BOOTSTRAP_MASTER_KEY",
    ).pipe(Config.option, Config.map(Option.getOrUndefined));
    const configuredSalvoInferenceGatewayUrl = yield* optionalString("SALVO_INFERENCE_GATEWAY_URL");
    const salvoOpenAiApiKey = yield* Config.redacted("SALVO_OPENAI_API_KEY").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    const salvoOpenAiAdminKey = yield* Config.redacted("SALVO_OPENAI_ADMIN_KEY").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    const salvoOpenAiProjectId = yield* optionalString("SALVO_OPENAI_PROJECT_ID");
    const salvoGauntletEnabled = yield* optionalString("SALVO_GAUNTLET_ENABLED");
    const salvoGauntletProbeToken = yield* Config.redacted("SALVO_GAUNTLET_PROBE_TOKEN").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    const salvoGauntletSourceRevision = yield* optionalString("SALVO_GAUNTLET_SOURCE_REVISION");
    const salvoGauntletRuntimeImageId = yield* optionalString("SALVO_GAUNTLET_RUNTIME_IMAGE_ID");
    const salvoGauntletSkillReleaseHash = yield* optionalString(
      "SALVO_GAUNTLET_SKILL_RELEASE_HASH",
    );
    const salvoGauntletInfrastructurePlanHash = yield* optionalString(
      "SALVO_GAUNTLET_INFRASTRUCTURE_PLAN_HASH",
    );
    const salvoGauntletSpecHash = yield* optionalString("SALVO_GAUNTLET_SPEC_HASH");
    const salvoGauntletEvidenceCollectorId = yield* optionalString(
      "SALVO_GAUNTLET_EVIDENCE_COLLECTOR_ID",
    );
    const salvoGauntletProductionEquivalent = yield* optionalString(
      "SALVO_GAUNTLET_PRODUCTION_EQUIVALENT",
    );
    const sponsoredEnvironment = {
      models: yield* optionalString("SALVO_SPONSORED_MODELS"),
      maxOutputTokens: yield* optionalString("SALVO_SPONSORED_MAX_OUTPUT_TOKENS"),
      turnMicros: yield* optionalString("SALVO_SPONSORED_TURN_MICROS"),
      userMicros: yield* optionalString("SALVO_SPONSORED_USER_MICROS"),
      pilotMicros: yield* optionalString("SALVO_SPONSORED_PILOT_MICROS"),
      inputRate: yield* optionalString("SALVO_SPONSORED_INPUT_MICROS_PER_MILLION_TOKENS"),
      outputRate: yield* optionalString("SALVO_SPONSORED_OUTPUT_MICROS_PER_MILLION_TOKENS"),
      timeoutMs: yield* optionalString("SALVO_SPONSORED_TIMEOUT_MS"),
      maxAttempts: yield* optionalString("SALVO_SPONSORED_MAX_ATTEMPTS"),
      grantTtlMs: yield* optionalString("SALVO_SPONSORED_GRANT_TTL_MS"),
    };

    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(yield* RelayDb.RelayHyperdrive);
    const db = yield* Drizzle.Postgres(hyperdrive.connectionString);

    const managedEndpointTunnelBinding = yield* Cloudflare.Tunnel.ReadWriteTunnel();
    // Keep Worker custom-domain reconciliation ordered after API zone provisioning.
    yield* yield* relayApiZone.zoneId;
    const managedEndpointDnsBinding = yield* Cloudflare.DNS.ReadWriteDns(managedEndpointZone);
    const managedEndpointZoneName = yield* managedEndpointZone.name;

    //
    // 3. Runtime layers and app construction
    //
    const alchemyRuntimeContext: Alchemy.BaseRuntimeContext = yield* Cloudflare.Worker;
    const runProvider = <A, E>(operation: Effect.Effect<A, E, Alchemy.RuntimeContext>) =>
      Effect.runPromise(
        operation.pipe(Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext)),
      );
    const sandboxTunnelProvisioner = makeSandboxTunnelProvisioner(
      {
        findTunnel: async (name) => {
          const response = await runProvider(
            managedEndpointTunnelBinding.list({ name, isDeleted: false }),
          );
          return response.result.flatMap((value) =>
            typeof value.id === "string" && typeof value.name === "string"
              ? [{ id: value.id, name: value.name }]
              : [],
          );
        },
        createTunnel: async (name) => {
          const value = await runProvider(
            managedEndpointTunnelBinding.create({ name, configSrc: "cloudflare" }),
          );
          if (typeof value.id !== "string" || typeof value.name !== "string")
            throw new Error("invalid_sandbox_tunnel_create");
          return { id: value.id, name: value.name };
        },
        configureTunnel: async (id, hostname, origin) => {
          await runProvider(
            managedEndpointTunnelBinding.putConfiguration(id, {
              ingress: [{ hostname, service: origin }, { service: "http_status:404" }],
            }),
          );
        },
        bindHostname: async (hostname, tunnelId) => {
          const response = await runProvider(
            managedEndpointDnsBinding.listDnsRecords({ search: hostname }),
          );
          const records = response.result.filter(
            (record) =>
              typeof record.id === "string" &&
              record.name.toLowerCase().replace(/\.$/u, "") === hostname,
          );
          if (records.length > 1) throw new Error("ambiguous_sandbox_tunnel_dns");
          const request = {
            type: "CNAME" as const,
            name: hostname,
            content: `${tunnelId}.cfargotunnel.com`,
            ttl: 1 as const,
            proxied: true as const,
          };
          if (records[0]?.id)
            await runProvider(managedEndpointDnsBinding.updateDnsRecord(records[0].id, request));
          else await runProvider(managedEndpointDnsBinding.createDnsRecord(request));
        },
        getToken: async (id) => await runProvider(managedEndpointTunnelBinding.getToken(id)),
        unbindHostname: async (hostname, tunnelId) => {
          const response = await runProvider(
            managedEndpointDnsBinding.listDnsRecords({ search: hostname }),
          );
          const records = response.result.filter(
            (record) =>
              typeof record.id === "string" &&
              record.name.toLowerCase().replace(/\.$/u, "") === hostname &&
              record.type === "CNAME" &&
              record.content === `${tunnelId}.cfargotunnel.com`,
          );
          if (records.length > 1) throw new Error("ambiguous_sandbox_tunnel_dns");
          if (records[0]?.id)
            await runProvider(managedEndpointDnsBinding.deleteDnsRecord(records[0].id));
        },
        deleteTunnel: async (id) => {
          await runProvider(managedEndpointTunnelBinding.delete(id));
        },
      },
      { baseDomain: String(managedEndpointZoneName), localOrigin: "http://127.0.0.1:4318" },
    );

    const loadSettings = Effect.gen(function* () {
      return RelayConfiguration.RelayConfiguration.of({
        relayIssuer: relayPublicOrigin,
        apns: {
          environment,
          teamId: apnsTeamId,
          keyId: apnsKeyId,
          bundleId: apnsBundleId,
          privateKey: apnsPrivateKey,
        },
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        clerkSecretKey,
        clerkPublishableKey,
        clerkJwtAudience,
        salvoOperatorUserIds,
        salvoPilotUserIds,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        managedEndpointBaseDomain: yield* managedEndpointZoneName,
        managedEndpointNamespace: stage,
      });
    });

    const relayTraceLayer = Layer.unwrap(
      Effect.all({
        tracesDatasetName: axiomDatasetName,
        tracesEndpoint: axiomTracesEndpoint,
        ingestToken: axiomIngestToken,
      }).pipe(Effect.map(makeRelayTraceLayer)),
    );

    const awsHostedConfig = awsHostedSandboxConfigFromEnv(salvoAwsEnvironment);
    const awsCredentials = salvoAwsCredentialsSecret
      ? parseAwsTemporaryCredentials(Redacted.value(salvoAwsCredentialsSecret))
      : null;
    const awsClientLayer =
      awsCredentials &&
      awsHostedConfig.region &&
      awsHostedConfig.promotedImageId &&
      awsHostedConfig.imageRelease &&
      awsHostedConfig.launchTemplateId &&
      awsHostedConfig.launchTemplateVersion &&
      salvoSandboxGatewayOrigin &&
      salvoSandboxGatewayToken
        ? layerWorkerAwsSandboxLifecycleClient({
            region: awsHostedConfig.region,
            promotedImageId: awsHostedConfig.promotedImageId,
            imageRelease: awsHostedConfig.imageRelease,
            launchTemplateId: awsHostedConfig.launchTemplateId,
            launchTemplateVersion: awsHostedConfig.launchTemplateVersion,
            gatewayOrigin: salvoSandboxGatewayOrigin,
            gatewayToken: Redacted.value(salvoSandboxGatewayToken),
            credentials: awsCredentials,
          })
        : undefined;
    const hostedSandboxProviderLayer = selectHostedSandboxProviderLayer(
      awsHostedConfig,
      awsClientLayer,
    );
    const authoritativeReaderLayer =
      salvoOpenAiAdminKey && salvoOpenAiProjectId && awsCredentials
        ? AuthoritativeLiabilityReaderLive.layer(
            {
              openAiAdminKey: Redacted.value(salvoOpenAiAdminKey),
              openAiProjectId: salvoOpenAiProjectId,
              awsCredentials,
            },
            { fetch: globalThis.fetch },
          )
        : CanaryBudgetAuthority.authoritativeReaderUnavailable;
    const sponsoredConfiguration = RelayConfiguration.parseSalvoSponsoredConfiguration({
      ...(salvoOpenAiApiKey ? { apiKey: Redacted.value(salvoOpenAiApiKey) } : {}),
      ...sponsoredEnvironment,
    });
    const salvoInferenceGatewayUrl = new URL("/v1/responses", relayPublicOrigin).href;
    if (
      configuredSalvoInferenceGatewayUrl &&
      configuredSalvoInferenceGatewayUrl !== salvoInferenceGatewayUrl
    ) {
      return yield* Effect.die(new Error("salvo_inference_gateway_url_must_match_mounted_route"));
    }
    const bootstrapEnabled = Boolean(
      salvoSandboxGatewayToken && salvoSandboxBootstrapMasterKey && sponsoredConfiguration,
    );
    const bootstrapCredentialsLayer = bootstrapEnabled
      ? SandboxBootstrapTokens.layerPostgres({
          masterKey: Buffer.from(Redacted.value(salvoSandboxBootstrapMasterKey!), "hex"),
          bootstrapOrigin: relayPublicOrigin,
          inferenceGatewayUrl: salvoInferenceGatewayUrl!,
          codexModel: [...sponsoredConfiguration!.allowedModels][0]!,
          codexMaxOutputTokens: sponsoredConfiguration!.maxOutputTokens,
          codexReserveMicros: sponsoredConfiguration!.maxTurnMicros,
          provisionTunnel: sandboxTunnelProvisioner.provision,
          retireTunnel: sandboxTunnelProvisioner.retire,
        })
      : SandboxBootstrapTokens.layerUnavailable;
    const bootstrapRoutesLayer = bootstrapEnabled
      ? Layer.mergeAll(
          SandboxBootstrapHttp.routes(Redacted.value(salvoSandboxGatewayToken!)),
          SandboxTunnelHttp.routes(Redacted.value(salvoSandboxGatewayToken!)),
          SponsoredInferenceHttp.routes,
        )
      : Layer.empty;
    const gauntletRequested = salvoGauntletEnabled === "1";
    RelayConfiguration.assertSalvoPilotSubset({
      enabled: gauntletRequested,
      operatorUserIds: salvoOperatorUserIds,
      pilotUserIds: salvoPilotUserIds,
    });
    if (
      gauntletRequested &&
      (!salvoGauntletProbeToken ||
        !salvoGauntletSourceRevision ||
        !salvoGauntletRuntimeImageId ||
        !salvoGauntletSkillReleaseHash ||
        !salvoGauntletInfrastructurePlanHash ||
        !salvoGauntletSpecHash ||
        !salvoGauntletEvidenceCollectorId)
    ) {
      return yield* Effect.die(new Error("incomplete_salvo_gauntlet_probe_configuration"));
    }
    if (
      gauntletRequested &&
      sponsoredConfiguration &&
      sponsoredConfiguration.pilotMicros > GauntletProbeLive.COMBINED_CANARY_CAP_MICROS
    ) {
      return yield* Effect.die(new Error("salvo_gauntlet_pilot_cap_exceeds_combined_canary_cap"));
    }
    const gauntletRoutesLayer = GauntletProbeHttp.routes({
      enabled: gauntletRequested,
      token: salvoGauntletProbeToken ? Redacted.value(salvoGauntletProbeToken) : "",
      origin: relayPublicOrigin,
      sourceRevision: salvoGauntletSourceRevision ?? "",
      runtimeImageId: salvoGauntletRuntimeImageId ?? "",
      skillReleaseHash: salvoGauntletSkillReleaseHash ?? "",
      infrastructurePlanHash: salvoGauntletInfrastructurePlanHash ?? "",
      gauntletSpecHash: salvoGauntletSpecHash ?? "",
      evidenceCollectorId: salvoGauntletEvidenceCollectorId ?? "",
      productionEquivalent: salvoGauntletProductionEquivalent === "1",
    }).pipe(
      Layer.provideMerge(
        gauntletRequested
          ? GauntletProbeLive.layer({
              pilotCapMicros: sponsoredConfiguration?.pilotMicros ?? null,
            }).pipe(Layer.provide(authoritativeReaderLayer))
          : GauntletProbe.layerUnavailable,
      ),
    );
    const sponsoredInferenceLayer = SponsoredInferenceLive.layerFromConfiguration(
      sponsoredConfiguration,
      { fetch: globalThis.fetch },
    );
    // Every configured paid path shares one Postgres lock and fails closed until
    // both independent provider-billing readers are installed.
    const paidSalvoPathConfigured = Boolean(sponsoredConfiguration || awsClientLayer);
    const canaryBudgetLayer = paidSalvoPathConfigured
      ? CanaryBudgetAuthority.layerPostgres({ operatorUserIds: salvoOperatorUserIds }).pipe(
          Layer.provide(authoritativeReaderLayer),
        )
      : CanaryBudgetAuthority.layerDisabled;
    const canaryBudgetRoutesLayer = CanaryBudgetHttp.routes({
      enabled: paidSalvoPathConfigured && Boolean(salvoGauntletProbeToken),
      token: salvoGauntletProbeToken ? Redacted.value(salvoGauntletProbeToken) : "",
      operatorUserIds: salvoOperatorUserIds,
    }).pipe(Layer.provide(canaryBudgetLayer));
    const sponsoredResponsesLayer = sponsoredConfiguration
      ? SponsoredResponsesProxy.layer.pipe(
          Layer.provide(
            Layer.merge(
              canaryBudgetLayer,
              Layer.succeed(
                SponsoredResponsesProxy.SponsoredResponsesProxyConfig,
                SponsoredResponsesProxy.SponsoredResponsesProxyConfig.of({
                  apiKey: sponsoredConfiguration.apiKey,
                  upstreamUrl: "https://api.openai.com/v1/responses",
                  allowedModels: sponsoredConfiguration.allowedModels,
                  maxOutputTokens: sponsoredConfiguration.maxOutputTokens,
                  turnMicros: sponsoredConfiguration.maxTurnMicros,
                  userMicros: sponsoredConfiguration.userMicros,
                  pilotMicros: sponsoredConfiguration.pilotMicros,
                  inputMicrosPerMillionTokens: sponsoredConfiguration.inputMicrosPerMillionTokens,
                  outputMicrosPerMillionTokens: sponsoredConfiguration.outputMicrosPerMillionTokens,
                  timeoutMs: sponsoredConfiguration.timeoutMs,
                  fetch: globalThis.fetch,
                }),
              ),
            ),
          ),
        )
      : SponsoredResponsesProxy.layerUnavailable;

    const runtimeServicesLayer = Layer.empty.pipe(
      Layer.provideMerge(MobileRegistrations.layer),
      Layer.provideMerge(AgentActivityPublisher.layer),
      Layer.provideMerge(EnvironmentConnector.layer),
      Layer.provideMerge(EnvironmentLinker.layer),
      Layer.provideMerge(EnvironmentPublishSignatures.layer),
      Layer.provideMerge(
        ManagedEndpointProvider.layerCloudflareBindings(
          managedEndpointTunnelBinding,
          managedEndpointDnsBinding,
          alchemyRuntimeContext,
        ),
      ),
      Layer.provideMerge(DpopProofs.layer),
      Layer.provideMerge(ApnsDeliveries.layer),
      Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
      Layer.provideMerge(
        ApnsDeliveryQueue.layerCloudflareQueues(apnsDeliveryQueueSender, alchemyRuntimeContext),
      ),
      Layer.provideMerge(AgentActivityRows.layer),
      Layer.provideMerge(Devices.layer),
      Layer.provideMerge(EnvironmentCredentials.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          EnvironmentLinks.layer,
          ManagedEndpointAllocations.layer,
          ManagedTunnelLimits.layer,
        ),
      ),
      Layer.provideMerge(LiveActivities.layer),
      Layer.provideMerge(Layer.merge(DeliveryAttempts.layer, SupportIssues.layer)),
      Layer.provideMerge(bootstrapCredentialsLayer),
      Layer.provideMerge(
        HostedSandboxes.layer.pipe(
          Layer.provideMerge(hostedSandboxProviderLayer),
          Layer.provideMerge(HostedSandboxRepository.layer),
          Layer.provideMerge(sponsoredInferenceLayer),
          Layer.provideMerge(canaryBudgetLayer),
          Layer.provideMerge(bootstrapCredentialsLayer),
        ),
      ),
      Layer.provideMerge(
        Layer.merge(
          HostedSandboxIdleDrain.layer.pipe(
            Layer.provideMerge(hostedSandboxProviderLayer),
            Layer.provideMerge(HostedSandboxRepository.layer),
            Layer.provideMerge(webcryptoLayer),
            Layer.provideMerge(bootstrapCredentialsLayer),
          ),
          HostedSandboxControlRotation.layer.pipe(
            Layer.provideMerge(hostedSandboxProviderLayer),
            Layer.provideMerge(HostedSandboxRepository.layer),
            Layer.provideMerge(bootstrapCredentialsLayer),
          ),
        ),
      ),
      Layer.provideMerge(
        Layer.merge(canaryBudgetLayer, Layer.merge(sponsoredResponsesLayer, RelayTokens.layer)),
      ),
    );
    const runtimeLayer = runtimeServicesLayer.pipe(
      Layer.provideMerge(
        RelayDb.RelayTransactions.layer.pipe(
          Layer.provideMerge(Layer.succeed(RelayDb.RelayDb, db)),
        ),
      ),
      Layer.provideMerge(
        Layer.merge(
          Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings),
          webcryptoLayer,
        ),
      ),
    );

    const appLayer = relayApiLayer.pipe(
      Layer.provideMerge(relayClientAuthLayer),
      Layer.provideMerge(relayDpopClientAuthLayer),
      Layer.provideMerge(relayEnvironmentAuthLayer),
      Layer.provide(runtimeLayer),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      apnsDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "5 seconds",
        retryDelay: "30 seconds",
        deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.apn_delivery_queue.process_batch"),
          Stream.runForEach((message) =>
            ApnsDeliveries.ApnsDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
              Effect.withSpan("relay.apn_delivery_queue.process_message"),
            ),
          ),
          Effect.provide(runtimeLayer),
        ),
    );

    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      DpopProofs.DpopProofReplay.pipe(
        Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
        // Terminal thread rows are kept briefly so finished agents show as
        // Done/Failed in the Live Activity; sweep them once they age out.
        Effect.andThen(
          Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
            Effect.flatMap(([activityRows, now]) =>
              activityRows.pruneTerminal({
                updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
              }),
            ),
          ),
        ),
        Effect.andThen(
          HostedSandboxIdleDrain.HostedSandboxIdleDrain.pipe(
            Effect.flatMap((drain) =>
              DateTime.now.pipe(
                Effect.flatMap((now) =>
                  drain.sweep({
                    idleBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 20 })),
                  }),
                ),
              ),
            ),
          ),
        ),
        Effect.andThen(
          HostedSandboxControlRotation.HostedSandboxControlRotation.pipe(
            Effect.flatMap((rotation) => rotation.sweep()),
          ),
        ),
        Effect.withSpan("relay.cron.prune_expired_state"),
        Effect.provide(runtimeLayer),
      ),
    );

    const fetch = Layer.merge(
      Layer.mergeAll(
        HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(appLayer),
        ),
        HttpApiScalar.layer(RelayApi, { path: "/docs" }),
        relayDocsRedirectRoute,
        Layer.provideMerge(
          Layer.mergeAll(bootstrapRoutesLayer, gauntletRoutesLayer, canaryBudgetRoutesLayer),
          runtimeLayer,
        ),
      ).pipe(Layer.provide([Etag.layerWeak, httpPlatformNotSupportedLayer, relayCors])),
      relayNotFoundRoute,
    ).pipe(
      HttpRouter.toHttpEffect,
      withoutCapturedParentSpan,
      Effect.flatMap((httpEffect) => traceRelayHttpRequestWith(httpEffect, relayTraceLayer)),
    );

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(Cloudflare.Hyperdrive.ConnectBinding),
        Layer.provideMerge(Cloudflare.Workers.CronEventSourceLive),
        Layer.provideMerge(Cloudflare.Queues.WriteQueueBinding),
        Layer.provideMerge(Cloudflare.Queues.EventSourceLive),
        Layer.provideMerge(Cloudflare.Tunnel.ReadWriteTunnelBinding),
        Layer.provideMerge(Cloudflare.DNS.ReadWriteDnsHttp),
      ),
    ),
  ),
);

export default ApiLive;
