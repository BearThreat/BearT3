import type { RelayHostedSandboxRecord } from "@t3tools/contracts/relay";

import { resolveCloudPublicConfig } from "./publicConfig";
import { randomUUID } from "../lib/utils";
import {
  installSalvoHostedOnboardingAdapter,
  type SalvoHostedOnboardingAdapter,
  type SalvoHostedSession,
} from "../salvo/hostedOnboarding";

type RelayFetch = typeof globalThis.fetch;

async function authenticatedRequest<T>(
  session: SalvoHostedSession,
  path: string,
  init: RequestInit,
  relayFetch: RelayFetch,
): Promise<T> {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (!relayUrl) throw new Error("Salvo hosted control plane is unavailable.");
  const token = await session.readAccessToken();
  if (!token) throw new Error("Salvo sign-in expired.");
  const response = await relayFetch(new URL(path, relayUrl), {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Salvo hosted control plane failed (${response.status}).`);
  return (await response.json()) as T;
}

export function createRelayHostedOnboardingAdapter(input?: {
  readonly relayFetch?: RelayFetch;
  readonly requestId?: () => string;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly readinessAttempts?: number;
}): SalvoHostedOnboardingAdapter {
  const relayFetch = input?.relayFetch ?? globalThis.fetch;
  const requestIds = new Map<string, string>();
  const wait =
    input?.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const readinessAttempts = input?.readinessAttempts ?? 120;
  return {
    startSandbox: async (session) => {
      const requestId = requestIds.get(session.accountId) ?? input?.requestId?.() ?? randomUUID();
      requestIds.set(session.accountId, requestId);
      const record = await authenticatedRequest<RelayHostedSandboxRecord>(
        session,
        "/v1/client/hosted-sandboxes/start",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId }),
        },
        relayFetch,
      );
      let current = record;
      for (
        let attempt = 0;
        current.status === "starting" && attempt < readinessAttempts;
        attempt++
      ) {
        await wait(500);
        current = await authenticatedRequest<RelayHostedSandboxRecord>(
          session,
          `/v1/client/hosted-sandboxes/${encodeURIComponent(record.sandboxId)}`,
          { method: "GET" },
          relayFetch,
        );
      }
      if (current.status !== "ready")
        throw new Error(
          current.status === "failed" ? "Salvo failed to start." : "Salvo startup timed out.",
        );
      return { sandboxId: current.sandboxId };
    },
    sendPrompt: async ({ session, sandbox, prompt }) => {
      await authenticatedRequest(
        session,
        `/v1/client/hosted-sandboxes/${encodeURIComponent(sandbox.sandboxId)}/prompts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId: randomUUID(), prompt }),
        },
        relayFetch,
      );
    },
  };
}

export function installRelayHostedOnboardingAdapter(): () => void {
  return installSalvoHostedOnboardingAdapter(createRelayHostedOnboardingAdapter());
}
