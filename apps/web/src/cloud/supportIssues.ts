import type {
  RelayCreateSupportIssueRequest,
  RelayListSupportIssuesResponse,
  RelayOperatorListSupportIssuesResponse,
  RelayOperatorSupportIssueRecord,
  RelayOperatorReplySupportIssueRequest,
  RelaySupportIssueRecord,
} from "@t3tools/contracts/relay";

import { resolveCloudPublicConfig } from "./publicConfig";

type RelayFetch = typeof globalThis.fetch;

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Relay support request failed (${response.status}).`);
  return (await response.json()) as T;
}

export async function listRelayOperatorSupportIssues(
  clerkToken: string,
  relayFetch: RelayFetch = globalThis.fetch,
): Promise<readonly RelayOperatorSupportIssueRecord[]> {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (!relayUrl) throw new Error("Relay is unavailable.");
  const response = await relayFetch(new URL("/v1/operator/support-issues", relayUrl), {
    headers: { authorization: `Bearer ${clerkToken}` },
  });
  return (await readJson<RelayOperatorListSupportIssuesResponse>(response)).issues;
}

export async function replyToRelayOperatorSupportIssue(
  input: { readonly clerkToken: string; readonly payload: RelayOperatorReplySupportIssueRequest },
  relayFetch: RelayFetch = globalThis.fetch,
): Promise<RelayOperatorSupportIssueRecord> {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (!relayUrl) throw new Error("Relay is unavailable.");
  const response = await relayFetch(new URL("/v1/operator/support-issues/reply", relayUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.clerkToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.payload),
  });
  return readJson<RelayOperatorSupportIssueRecord>(response);
}

export async function listRelaySupportIssues(
  clerkToken: string,
  relayFetch: RelayFetch = globalThis.fetch,
): Promise<readonly RelaySupportIssueRecord[]> {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (!relayUrl) throw new Error("Relay is unavailable.");
  const response = await relayFetch(new URL("/v1/client/support-issues", relayUrl), {
    headers: { authorization: `Bearer ${clerkToken}` },
  });
  return (await readJson<RelayListSupportIssuesResponse>(response)).issues;
}

export async function deliverRelaySupportIssue(
  input: {
    readonly clerkToken: string;
    readonly payload: RelayCreateSupportIssueRequest;
  },
  relayFetch: RelayFetch = globalThis.fetch,
): Promise<RelaySupportIssueRecord> {
  const existing = (await listRelaySupportIssues(input.clerkToken, relayFetch)).find(
    ({ receiptId }) => receiptId === input.payload.receiptId,
  );
  if (existing) return existing;

  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (!relayUrl) throw new Error("Relay is unavailable.");
  const response = await relayFetch(new URL("/v1/client/support-issues", relayUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.clerkToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.payload),
  });
  return readJson<RelaySupportIssueRecord>(response);
}
