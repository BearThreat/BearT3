// @effect-diagnostics globalDate:off globalTimers:off preferSchemaOverJson:off instanceOfSchema:off -- WebCrypto signing, bounded platform polling, and Worker fetch live at this audited boundary.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  AwsSandboxLifecycleClient,
  AwsSandboxClientError,
  type AwsSandboxInstance,
} from "./AwsHostedSandboxProvider.ts";

export type AwsTemporaryCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiresAt: string;
};

export type WorkerAwsSandboxClientConfig = {
  readonly region: string;
  readonly promotedImageId: string;
  readonly imageRelease: string;
  readonly launchTemplateId: string;
  readonly launchTemplateVersion: string;
  readonly gatewayOrigin: string;
  readonly gatewayToken: string;
  readonly credentials: AwsTemporaryCredentials;
  readonly requestTimeoutMs?: number;
  readonly maxAttempts?: number;
};

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const encoder = new TextEncoder();
const ALLOWED_ACTIONS = new Set([
  "DescribeImages",
  "DescribeInstances",
  "DescribeVolumes",
  "RunInstances",
  "StartInstances",
  "StopInstances",
]);
const INSTANCE_STATES = new Set([
  "pending",
  "running",
  "stopping",
  "stopped",
  "hibernating",
  "hibernated",
  "terminated",
]);

function hex(bytes: ArrayBuffer | Uint8Array) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(input: string | Uint8Array) {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      (typeof input === "string" ? encoder.encode(input) : input) as BufferSource,
    ),
  );
}

async function hmac(key: Uint8Array, input: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(input)));
}

async function signJsonRequest(input: {
  region: string;
  service: "ssm";
  target: string;
  credentials: AwsTemporaryCredentials;
  body: string;
  now: Date;
}) {
  const host = `${input.service}.${input.region}.amazonaws.com`;
  const endpoint = `https://${host}/`;
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const canonicalHeaders = `content-type:application/x-amz-json-1.1\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-security-token:${input.credentials.sessionToken}\nx-amz-target:${input.target}\n`;
  const signedHeaders = "content-type;host;x-amz-date;x-amz-security-token;x-amz-target";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hex(await sha256(input.body))}`;
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonicalRequest))}`;
  const dateKey = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), date);
  const regionKey = await hmac(dateKey, input.region);
  const serviceKey = await hmac(regionKey, input.service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  return {
    endpoint,
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-date": amzDate,
      "x-amz-security-token": input.credentials.sessionToken,
      "x-amz-target": input.target,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function xmlValues(xml: string, tag: string) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...xml.matchAll(new RegExp(`<${escaped}>([^<]*)</${escaped}>`, "g"))].map(
    (match) => match[1] ?? "",
  );
}

function xmlValue(xml: string, tag: string) {
  return xmlValues(xml, tag)[0];
}

function blocks(xml: string, tag: string) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...xml.matchAll(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, "g"))].map(
    (match) => match[1] ?? "",
  );
}

function entityBlocks(xml: string, setTag: string, idTag: string) {
  const set = blocks(xml, setTag)[0] ?? "";
  return [
    ...set.matchAll(
      new RegExp(`<item>(?=<${idTag}>)([\\s\\S]*?)<\\/item>(?=<item><${idTag}>|$)`, "g"),
    ),
  ].map((match) => match[1] ?? "");
}

function tags(xml: string) {
  return Object.fromEntries(
    [...xml.matchAll(/<item>\s*<key>([^<]+)<\/key>\s*<value>([^<]*)<\/value>\s*<\/item>/g)].map(
      (match) => [match[1]!, match[2]!],
    ),
  );
}

function parseCredentials(raw: string, now = Date.now()): AwsTemporaryCredentials | null {
  try {
    const value = JSON.parse(raw) as Partial<AwsTemporaryCredentials>;
    if (
      ![value.accessKeyId, value.secretAccessKey, value.sessionToken, value.expiresAt].every(
        (field) => typeof field === "string" && field.length > 0,
      )
    )
      return null;
    const expiry = Date.parse(value.expiresAt!);
    // Long-lived access keys are rejected: Salvo requires expiring session credentials.
    if (!Number.isFinite(expiry) || expiry <= now + 60_000 || expiry > now + 12 * 60 * 60_000)
      return null;
    return value as AwsTemporaryCredentials;
  } catch {
    return null;
  }
}

export { parseCredentials as parseAwsTemporaryCredentials };

export async function signEc2Request(input: {
  readonly region: string;
  readonly credentials: AwsTemporaryCredentials;
  readonly parameters: Readonly<Record<string, string>>;
  readonly now: Date;
}) {
  const action = input.parameters.Action;
  if (!action || !ALLOWED_ACTIONS.has(action)) throw new Error("EC2 operation is not allowlisted");
  const host = `ec2.${input.region}.amazonaws.com`;
  const endpoint = `https://${host}/`;
  const body = new URLSearchParams(
    Object.entries(input.parameters).sort(([a], [b]) => a.localeCompare(b)),
  ).toString();
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = hex(await sha256(body));
  const canonicalHeaders = `content-type:application/x-www-form-urlencoded; charset=utf-8\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-security-token:${input.credentials.sessionToken}\n`;
  const signedHeaders = "content-type;host;x-amz-date;x-amz-security-token";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${input.region}/ec2/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonicalRequest))}`;
  const dateKey = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), date);
  const regionKey = await hmac(dateKey, input.region);
  const serviceKey = await hmac(regionKey, "ec2");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  return {
    endpoint,
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      "x-amz-date": amzDate,
      "x-amz-security-token": input.credentials.sessionToken,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function error(operation: string, cause: unknown) {
  const safeCause = cause instanceof Error ? cause.message : String(cause);
  return new AwsSandboxClientError({ operation, cause: safeCause.slice(0, 500) });
}

export function makeWorkerAwsSandboxLifecycleClient(
  config: WorkerAwsSandboxClientConfig,
  dependencies: {
    readonly fetch?: Fetch;
    readonly now?: () => Date;
    readonly delay?: (ms: number) => Promise<void>;
  } = {},
) {
  const fetchFn = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const now = dependencies.now ?? (() => new Date());
  const timeoutMs = Math.min(Math.max(config.requestTimeoutMs ?? 8_000, 1_000), 15_000);
  const maxAttempts = Math.min(Math.max(config.maxAttempts ?? 2, 1), 3);
  const delay =
    dependencies.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const ec2 = async (
    operation: string,
    parameters: Readonly<Record<string, string>>,
    write = false,
  ) => {
    let last: unknown = "request failed";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const signed = await signEc2Request({
          region: config.region,
          credentials: config.credentials,
          parameters: { ...parameters, Version: "2016-11-15" },
          now: now(),
        });
        const response = await fetchFn(signed.endpoint, {
          method: "POST",
          headers: signed.headers,
          body: signed.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = (await response.text()).slice(0, 1_000_000);
        if (response.ok) return text;
        const code = xmlValue(text, "Code") ?? `HTTP_${response.status}`;
        if (write || response.status < 500 || attempt === maxAttempts)
          throw new Error(`${operation} failed: ${code}`);
        last = code;
      } catch (cause) {
        last = cause;
        if (write || attempt === maxAttempts) throw error(operation, cause);
      }
    }
    throw error(operation, last);
  };

  const gateway = async (operation: string, path: string, init: RequestInit) => {
    try {
      const response = await fetchFn(new URL(path, config.gatewayOrigin), {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${config.gatewayToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`${operation} failed: HTTP_${response.status}`);
      return (await response.json()) as unknown;
    } catch (cause) {
      throw error(operation, cause);
    }
  };

  const issueBootstrap = async (input: {
    sandboxId: string;
    userId: string;
    clientToken: string;
  }) => {
    const value = (await gateway(
      "IssueBootstrapToken",
      `/v1/sandboxes/${encodeURIComponent(input.sandboxId)}/bootstrap-tokens`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: input.userId, clientToken: input.clientToken }),
      },
    )) as Record<string, unknown>;
    if (
      typeof value.token !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.token) ||
      typeof value.bootstrapUrl !== "string" ||
      typeof value.expiresAt !== "string"
    )
      throw new Error("bootstrap token response invalid");
    return { token: value.token, bootstrapUrl: value.bootstrapUrl, expiresAt: value.expiresAt };
  };
  const ssm = async (target: string, body: Record<string, unknown>) => {
    const encoded = JSON.stringify(body);
    const signed = await signJsonRequest({
      region: config.region,
      service: "ssm",
      target,
      credentials: config.credentials,
      body: encoded,
      now: now(),
    });
    const response = await fetchFn(signed.endpoint, {
      method: "POST",
      headers: signed.headers,
      body: encoded,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(`${target} failed: HTTP_${response.status}`);
    return value;
  };

  return AwsSandboxLifecycleClient.of({
    findBySandboxId: ({ sandboxId }) =>
      Effect.tryPromise({
        try: async () => {
          const instanceXml = await ec2("DescribeInstances", {
            Action: "DescribeInstances",
            "Filter.1.Name": "tag:salvo:sandbox-id",
            "Filter.1.Value.1": sandboxId,
            "Filter.2.Name": "instance-state-name",
            "Filter.2.Value.1": "pending",
            "Filter.2.Value.2": "running",
            "Filter.2.Value.3": "stopping",
            "Filter.2.Value.4": "stopped",
          });
          const instances = entityBlocks(instanceXml, "instancesSet", "instanceId");
          const result: AwsSandboxInstance[] = [];
          for (const instance of instances) {
            const instanceId = xmlValue(instance, "instanceId");
            const imageId = xmlValue(instance, "imageId");
            const state = blocks(instance, "instanceState").map((block) =>
              xmlValue(block, "name"),
            )[0];
            const volumeId = blocks(instance, "ebs").map((block) => xmlValue(block, "volumeId"))[0];
            const instanceTags = tags(instance);
            if (!instanceId || !imageId || !state || !INSTANCE_STATES.has(state) || !volumeId)
              continue;
            const volumeXml = await ec2("DescribeVolumes", {
              Action: "DescribeVolumes",
              "VolumeId.1": volumeId,
            });
            const volume = entityBlocks(volumeXml, "volumeSet", "volumeId")[0] ?? "";
            const volumeTags = tags(volume);
            result.push({
              instanceId,
              imageId,
              state: state as AwsSandboxInstance["state"],
              sandboxId: instanceTags["salvo:sandbox-id"] ?? "",
              userId: instanceTags["salvo:user-id"] ?? "",
              volume: {
                volumeId,
                encrypted: xmlValue(volume, "encrypted") === "true",
                sandboxId: volumeTags["salvo:sandbox-id"] ?? "",
                userId: volumeTags["salvo:user-id"] ?? "",
              },
            });
          }
          return result;
        },
        catch: (cause) =>
          cause instanceof AwsSandboxClientError ? cause : error("DescribeInstances", cause),
      }),
    runInstance: (input) =>
      Effect.tryPromise({
        try: async () => {
          if (
            input.imageId !== config.promotedImageId ||
            input.imageRelease !== config.imageRelease ||
            !input.encryptedVolume
          )
            throw new Error("unpromoted or unencrypted launch rejected");
          const imageXml = await ec2("DescribeImages", {
            Action: "DescribeImages",
            "ImageId.1": config.promotedImageId,
          });
          const image = entityBlocks(imageXml, "imagesSet", "imageId")[0] ?? "";
          const imageTags = tags(image);
          if (
            xmlValue(image, "imageId") !== config.promotedImageId ||
            xmlValue(image, "imageState") !== "available" ||
            imageTags["salvo:image-release"] !== config.imageRelease
          )
            throw new Error("promoted AMI validation failed");
          const bootstrap = await issueBootstrap(input);
          const stage = (name: string, value: string) =>
            `printf '%s' '${btoa(value)}' | base64 -d > /run/salvo/${name}`;
          const userData = `#!/bin/sh\nset -eu\numask 077\ninstall -d -m 0700 /run/salvo\n${stage("bootstrap-token", bootstrap.token)}\n${stage("bootstrap-url", bootstrap.bootstrapUrl)}\n${stage("sandbox-id", input.sandboxId)}\n${stage("user-id", input.userId)}\n${stage("client-token", input.clientToken)}\n`;
          const parameters: Record<string, string> = {
            Action: "RunInstances",
            MinCount: "1",
            MaxCount: "1",
            ClientToken: input.clientToken,
            "LaunchTemplate.LaunchTemplateId": config.launchTemplateId,
            "LaunchTemplate.Version": config.launchTemplateVersion,
            UserData: btoa(userData),
            "TagSpecification.1.ResourceType": "instance",
            "TagSpecification.2.ResourceType": "volume",
          };
          const launchTags = Object.entries(input.tags).sort(([a], [b]) => a.localeCompare(b));
          for (const [index, [key, value]] of launchTags.entries()) {
            for (const spec of [1, 2]) {
              parameters[`TagSpecification.${spec}.Tag.${index + 1}.Key`] = key;
              parameters[`TagSpecification.${spec}.Tag.${index + 1}.Value`] = value;
            }
          }
          const xml = await ec2("RunInstances", parameters, true);
          const instanceId = xmlValue(xml, "instanceId");
          if (!instanceId) throw new Error("RunInstances response omitted instanceId");
          return { instanceId };
        },
        catch: (cause) =>
          cause instanceof AwsSandboxClientError ? cause : error("RunInstances", cause),
      }),
    startInstance: ({ instanceId }) =>
      Effect.tryPromise({
        try: async () => {
          await ec2(
            "StartInstances",
            { Action: "StartInstances", "InstanceId.1": instanceId },
            true,
          );
        },
        catch: (cause) =>
          cause instanceof AwsSandboxClientError ? cause : error("StartInstances", cause),
      }),
    rebootstrapInstance: (input) =>
      Effect.tryPromise({
        try: async () => {
          if (
            !/^i-[a-z0-9]+$/u.test(input.instanceId) ||
            !/^[A-Za-z0-9_-]{1,64}$/u.test(input.sandboxId) ||
            input.clientToken !== `salvo-${input.sandboxId}`.slice(0, 64)
          )
            throw new Error("invalid_rebootstrap_binding");
          let online = false;
          for (let attempt = 0; attempt < 20; attempt++) {
            const instances = await Effect.runPromise(
              makeWorkerAwsSandboxLifecycleClient(config, dependencies).findBySandboxId({
                sandboxId: input.sandboxId,
              }),
            );
            const owned = instances.filter(
              (instance) =>
                instance.instanceId === input.instanceId &&
                instance.userId === input.userId &&
                instance.sandboxId === input.sandboxId &&
                instance.volume.encrypted &&
                instance.volume.userId === input.userId &&
                instance.volume.sandboxId === input.sandboxId,
            );
            if (owned.length !== 1) throw new Error("rebootstrap_instance_not_owned");
            if (owned[0]!.state === "running") {
              const information = await ssm("AmazonSSM.DescribeInstanceInformation", {
                Filters: [{ Key: "InstanceIds", Values: [input.instanceId] }],
                MaxResults: 5,
              });
              const entries = Array.isArray(information.InstanceInformationList)
                ? (information.InstanceInformationList as Array<Record<string, unknown>>)
                : [];
              if (
                entries.some(
                  (entry) => entry.InstanceId === input.instanceId && entry.PingStatus === "Online",
                )
              ) {
                online = true;
                break;
              }
            }
            await delay(1_000);
          }
          if (!online) throw new Error("rebootstrap_instance_not_online");
          const bootstrap = await issueBootstrap(input);
          const encoded = (value: string) => btoa(value);
          const command = [
            "set -eu",
            "umask 077",
            "install -d -m 0700 /run/salvo",
            `printf '%s' '${encoded(bootstrap.token)}' | base64 -d > /run/salvo/bootstrap-token`,
            `printf '%s' '${encoded(bootstrap.bootstrapUrl)}' | base64 -d > /run/salvo/bootstrap-url`,
            `printf '%s' '${encoded(input.sandboxId)}' | base64 -d > /run/salvo/sandbox-id`,
            `printf '%s' '${encoded(input.userId)}' | base64 -d > /run/salvo/user-id`,
            `printf '%s' '${encoded(input.clientToken)}' | base64 -d > /run/salvo/client-token`,
            "systemctl stop salvo-readiness.service salvo-tunnel.service salvo.service",
            "systemctl reset-failed salvo-bootstrap.service",
            "systemctl restart salvo-bootstrap.service",
            "systemctl restart salvo.service salvo-tunnel.service salvo-readiness.service",
          ].join("\n");
          const body = {
            DocumentName: "AWS-RunShellScript",
            InstanceIds: [input.instanceId],
            Parameters: { commands: [command] },
            ClientToken: NodeCrypto.createHash("sha256")
              .update(`${input.sandboxId}:${bootstrap.expiresAt}`)
              .digest("hex")
              .slice(0, 64),
            TimeoutSeconds: 120,
            Comment: `salvo-rebootstrap:${input.sandboxId}`,
          };
          const sent = await ssm("AmazonSSM.SendCommand", body);
          const commandId = (sent.Command as Record<string, unknown> | undefined)?.CommandId;
          if (typeof commandId !== "string") throw new Error("SendCommand omitted command ID");
          let succeeded = false;
          for (let attempt = 0; attempt < 120; attempt++) {
            const invocation = await ssm("AmazonSSM.GetCommandInvocation", {
              CommandId: commandId,
              InstanceId: input.instanceId,
            });
            if (invocation.Status === "Success") {
              succeeded = true;
              break;
            }
            if (
              ["Cancelled", "TimedOut", "Failed", "Cancelling"].includes(String(invocation.Status))
            )
              throw new Error(`rebootstrap_command_${String(invocation.Status).toLowerCase()}`);
            await delay(1_000);
          }
          if (!succeeded) throw new Error("rebootstrap_command_timeout");
          const health = (await gateway(
            "TunnelHealth",
            `/v1/sandboxes/${encodeURIComponent(input.sandboxId)}/health?instanceId=${encodeURIComponent(input.instanceId)}`,
            { method: "GET" },
          )) as Record<string, unknown>;
          if (health.ready !== true || typeof health.endpoint !== "string")
            throw new Error("rebootstrap_credential_or_tunnel_not_ready");
          return { commandId };
        },
        catch: (cause) =>
          cause instanceof AwsSandboxClientError ? cause : error("SendCommand", cause),
      }),
    stopInstance: ({ instanceId, hibernate }) =>
      Effect.tryPromise({
        try: async () => {
          await ec2(
            "StopInstances",
            {
              Action: "StopInstances",
              "InstanceId.1": instanceId,
              Hibernate: hibernate ? "true" : "false",
            },
            true,
          );
        },
        catch: (cause) =>
          cause instanceof AwsSandboxClientError ? cause : error("StopInstances", cause),
      }),
    tunnelHealth: ({ instanceId, sandboxId }) =>
      Effect.tryPromise({
        try: async () => {
          const value = await gateway(
            "TunnelHealth",
            `/v1/sandboxes/${encodeURIComponent(sandboxId)}/health?instanceId=${encodeURIComponent(instanceId)}`,
            { method: "GET" },
          );
          if (!value || typeof value !== "object") return { ready: false, endpoint: null };
          const record = value as Record<string, unknown>;
          return {
            ready: record.ready === true && typeof record.endpoint === "string",
            endpoint:
              record.ready === true && typeof record.endpoint === "string" ? record.endpoint : null,
          };
        },
        catch: (cause) =>
          cause instanceof AwsSandboxClientError ? cause : error("TunnelHealth", cause),
      }),
    sendPrompt: (input) =>
      Effect.tryPromise({
        try: async () => {
          const value = await gateway(
            "SendPrompt",
            `/v1/sandboxes/${encodeURIComponent(input.sandboxId)}/prompts`,
            {
              method: "POST",
              headers: { "content-type": "application/json", "idempotency-key": input.requestId },
              body: JSON.stringify(input),
            },
          );
          const record =
            value && typeof value === "object" ? (value as Record<string, unknown>) : {};
          for (const key of [
            "requestId",
            "sandboxId",
            "sandboxExecutionReceiptId",
            "gatewayProviderReceiptId",
            "acceptedAt",
          ] as const)
            if (typeof record[key] !== "string") throw new Error(`prompt response omitted ${key}`);
          return {
            requestId: record.requestId as string,
            sandboxId: record.sandboxId as string,
            sandboxExecutionReceiptId: record.sandboxExecutionReceiptId as string,
            gatewayProviderReceiptId: record.gatewayProviderReceiptId as string,
            acceptedAt: record.acceptedAt as string,
          };
        },
        catch: (cause) =>
          cause instanceof AwsSandboxClientError ? cause : error("SendPrompt", cause),
      }),
  });
}

export const layerWorkerAwsSandboxLifecycleClient = (
  config: WorkerAwsSandboxClientConfig,
  dependencies?: {
    readonly fetch?: Fetch;
    readonly now?: () => Date;
    readonly delay?: (ms: number) => Promise<void>;
  },
) =>
  Layer.succeed(
    AwsSandboxLifecycleClient,
    makeWorkerAwsSandboxLifecycleClient(config, dependencies),
  );
