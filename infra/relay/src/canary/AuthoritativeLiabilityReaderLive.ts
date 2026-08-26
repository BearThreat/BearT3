// @effect-diagnostics globalDate:off preferSchemaOverJson:off -- Provider HTTP and WebCrypto are isolated at this Worker boundary.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  AuthoritativeLiabilityReader,
  CanaryBudgetDenied,
  type AuthoritativeLiabilityReading,
} from "./CanaryBudgetAuthority.ts";
import type { AwsTemporaryCredentials } from "../hostedSandboxes/WorkerAwsSandboxLifecycleClient.ts";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AuthoritativeReaderConfig = {
  readonly openAiAdminKey: string;
  readonly openAiProjectId: string;
  readonly awsCredentials: AwsTemporaryCredentials;
  readonly timeoutMs?: number;
};

const encoder = new TextEncoder();
const unavailable = () => new CanaryBudgetDenied({ code: "authoritative_unavailable" });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (input: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
const hmac = async (key: Uint8Array, input: string) => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(input)));
};

export async function signCostExplorerRequest(input: {
  readonly credentials: AwsTemporaryCredentials;
  readonly body: string;
  readonly now: Date;
}) {
  const host = "ce.us-east-1.amazonaws.com";
  const target = "AWSInsightsIndexService.GetCostAndUsage";
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const date = amzDate.slice(0, 8);
  const canonicalHeaders = `content-type:application/x-amz-json-1.1\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-security-token:${input.credentials.sessionToken}\nx-amz-target:${target}\n`;
  const signedHeaders = "content-type;host;x-amz-date;x-amz-security-token;x-amz-target";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hex(await sha256(input.body))}`;
  const scope = `${date}/us-east-1/ce/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonicalRequest))}`;
  const dateKey = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), date);
  const regionKey = await hmac(dateKey, "us-east-1");
  const serviceKey = await hmac(regionKey, "ce");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  return {
    endpoint: `https://${host}/`,
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-date": amzDate,
      "x-amz-security-token": input.credentials.sessionToken,
      "x-amz-target": target,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

const usdToMicros = (value: unknown) => {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/u.test(value))
    throw unavailable();
  const micros = Math.round(Number(value) * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros < 0) throw unavailable();
  return micros;
};

const parseOpenAiPage = (value: unknown) => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    !(value.has_more === undefined || typeof value.has_more === "boolean") ||
    !(
      value.next_page === undefined ||
      value.next_page === null ||
      typeof value.next_page === "string"
    )
  )
    throw unavailable();
  let billedMicros = 0;
  for (const bucket of value.data) {
    if (
      !isRecord(bucket) ||
      typeof bucket.start_time !== "number" ||
      typeof bucket.end_time !== "number" ||
      !Array.isArray(bucket.results)
    )
      throw unavailable();
    for (const result of bucket.results) {
      if (!isRecord(result) || !isRecord(result.amount) || result.amount.currency !== "usd")
        throw unavailable();
      billedMicros += usdToMicros(result.amount.value);
    }
  }
  return {
    billedMicros,
    hasMore: value.has_more === true,
    nextPage: typeof value.next_page === "string" ? value.next_page : null,
  };
};

const parseAwsPage = (value: unknown) => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.ResultsByTime) ||
    !(value.NextPageToken === undefined || typeof value.NextPageToken === "string")
  )
    throw unavailable();
  let billedMicros = 0;
  for (const period of value.ResultsByTime) {
    if (
      !isRecord(period) ||
      !isRecord(period.TimePeriod) ||
      typeof period.TimePeriod.Start !== "string" ||
      typeof period.TimePeriod.End !== "string" ||
      !isRecord(period.Total)
    )
      throw unavailable();
    const total = period.Total.UnblendedCost;
    if (!isRecord(total) || total.Unit !== "USD") throw unavailable();
    billedMicros += usdToMicros(total.Amount);
  }
  return {
    billedMicros,
    nextPageToken: typeof value.NextPageToken === "string" ? value.NextPageToken : null,
  };
};

export const makeAuthoritativeLiabilityReader = (
  config: AuthoritativeReaderConfig,
  dependencies: { readonly fetch: Fetch; readonly now?: () => Date } = {
    fetch: globalThis.fetch.bind(globalThis),
  },
) => {
  const now = dependencies.now ?? (() => new Date());
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? 8_000, 1_000), 15_000);
  const requestJson = async (url: string, init: RequestInit) => {
    const response = await dependencies.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw unavailable();
    return (await response.json()) as unknown;
  };
  const readOpenAi = async (): Promise<AuthoritativeLiabilityReading> => {
    const readAt = now();
    const start = Date.UTC(readAt.getUTCFullYear(), readAt.getUTCMonth(), 1) / 1_000;
    const end = Math.floor(readAt.getTime() / 1_000) + 1;
    let page: string | null = null;
    let billedMicros = 0;
    for (let count = 0; count < 10; count++) {
      const url = new URL("https://api.openai.com/v1/organization/costs");
      url.searchParams.set("start_time", String(start));
      url.searchParams.set("end_time", String(end));
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.append("project_ids[]", config.openAiProjectId);
      if (page) url.searchParams.set("page", page);
      const parsed = parseOpenAiPage(
        await requestJson(url.href, {
          headers: { authorization: `Bearer ${config.openAiAdminKey}` },
        }),
      );
      billedMicros += parsed.billedMicros;
      if (!parsed.hasMore)
        return {
          provider: "openai",
          billedMicros,
          observedAtMs: now().getTime(),
          source: `openai-organization-costs:project:${config.openAiProjectId}`,
        };
      if (!parsed.nextPage) throw unavailable();
      page = parsed.nextPage;
    }
    throw unavailable();
  };
  const readAws = async (): Promise<AuthoritativeLiabilityReading> => {
    const readAt = now();
    const start = `${readAt.getUTCFullYear()}-${String(readAt.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const endDate = new Date(
      Date.UTC(readAt.getUTCFullYear(), readAt.getUTCMonth(), readAt.getUTCDate() + 1),
    );
    const end = endDate.toISOString().slice(0, 10);
    let nextPageToken: string | null = null;
    let billedMicros = 0;
    for (let count = 0; count < 10; count++) {
      const body = JSON.stringify({
        TimePeriod: { Start: start, End: end },
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        ...(nextPageToken ? { NextPageToken: nextPageToken } : {}),
      });
      const signed = await signCostExplorerRequest({
        credentials: config.awsCredentials,
        body,
        now: now(),
      });
      const parsed = parseAwsPage(
        await requestJson(signed.endpoint, { method: "POST", headers: signed.headers, body }),
      );
      billedMicros += parsed.billedMicros;
      if (!parsed.nextPageToken)
        return {
          provider: "aws",
          billedMicros,
          observedAtMs: now().getTime(),
          source: "aws-cost-explorer:GetCostAndUsage:account",
        };
      nextPageToken = parsed.nextPageToken;
    }
    throw unavailable();
  };
  return AuthoritativeLiabilityReader.of({
    read: () =>
      Effect.tryPromise({
        try: async () =>
          (await Promise.all([readAws(), readOpenAi()])) as readonly [
            AuthoritativeLiabilityReading,
            AuthoritativeLiabilityReading,
          ],
        catch: unavailable,
      }),
  });
};

export const layer = (
  config: AuthoritativeReaderConfig,
  dependencies: { readonly fetch: Fetch; readonly now?: () => Date } = {
    fetch: globalThis.fetch.bind(globalThis),
  },
) =>
  Layer.succeed(
    AuthoritativeLiabilityReader,
    makeAuthoritativeLiabilityReader(config, dependencies),
  );
