import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./publicConfig", () => ({
  resolveCloudPublicConfig: () => ({ relayUrl: "https://relay.example.test" }),
}));

import { createRelayHostedOnboardingAdapter } from "./hostedSandboxes";

const ready = (sandboxId: string) =>
  new Response(
    JSON.stringify({
      sandboxId,
      status: "ready",
      endpoint: "https://sandbox.example.test",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:01.000Z",
    }),
    { status: 200 },
  );

describe("relay hosted onboarding adapter", () => {
  it("uses the active Clerk account token and isolates request replay across account switches", async () => {
    const calls: Array<{ authorization: string | null; body: unknown }> = [];
    const relayFetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return ready(`sandbox-${calls.length}`);
    });
    let nextId = 0;
    const adapter = createRelayHostedOnboardingAdapter({
      relayFetch: relayFetch as typeof fetch,
      requestId: () => `request-${++nextId}`,
    });

    await adapter.startSandbox({ accountId: "account-a", readAccessToken: async () => "token-a" });
    await adapter.startSandbox({
      accountId: "account-a",
      readAccessToken: async () => "token-a-refreshed",
    });
    await adapter.startSandbox({ accountId: "account-b", readAccessToken: async () => "token-b" });

    expect(calls).toEqual([
      { authorization: "Bearer token-a", body: { requestId: "request-1" } },
      { authorization: "Bearer token-a-refreshed", body: { requestId: "request-1" } },
      { authorization: "Bearer token-b", body: { requestId: "request-2" } },
    ]);
  });

  it("keeps starting as an expected state and reconciles until ready", async () => {
    let calls = 0;
    const relayFetch = vi.fn(async () => {
      calls++;
      return new Response(
        JSON.stringify({
          sandboxId: "sandbox-1",
          status: calls < 3 ? "starting" : "ready",
          endpoint: calls < 3 ? null : "https://sandbox.test",
          createdAt: "2026-08-24T00:00:00.000Z",
          updatedAt: "2026-08-24T00:00:00.000Z",
        }),
        { status: 200 },
      );
    });
    const adapter = createRelayHostedOnboardingAdapter({
      relayFetch: relayFetch as typeof fetch,
      requestId: () => "request-1",
      wait: async () => {},
      readinessAttempts: 3,
    });
    await expect(
      adapter.startSandbox({ accountId: "a", readAccessToken: async () => "token" }),
    ).resolves.toEqual({ sandboxId: "sandbox-1" });
    expect(calls).toBe(3);
  });

  it("bounds readiness reconciliation and reports a timeout", async () => {
    const relayFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sandboxId: "sandbox-1",
            status: "starting",
            endpoint: null,
            createdAt: "2026-08-24T00:00:00.000Z",
            updatedAt: "2026-08-24T00:00:00.000Z",
          }),
          { status: 200 },
        ),
    );
    const adapter = createRelayHostedOnboardingAdapter({
      relayFetch: relayFetch as typeof fetch,
      wait: async () => {},
      readinessAttempts: 2,
    });
    await expect(
      adapter.startSandbox({ accountId: "a", readAccessToken: async () => "token" }),
    ).rejects.toThrow("timed out");
    expect(relayFetch).toHaveBeenCalledTimes(3);
  });

  it("sends a prompt with the active account token to the owned sandbox path", async () => {
    const relayFetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://relay.example.test/v1/client/hosted-sandboxes/sandbox-1/prompts",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer account-token");
      expect(JSON.parse(String(init?.body))).toMatchObject({ prompt: "Help me plan dinner" });
      return new Response(
        JSON.stringify({
          requestId: "prompt-1",
          sandboxId: "sandbox-1",
          acceptedAt: "2026-08-24T00:00:00.000Z",
        }),
        { status: 200 },
      );
    });
    const adapter = createRelayHostedOnboardingAdapter({ relayFetch: relayFetch as typeof fetch });
    await adapter.sendPrompt({
      session: { accountId: "account-a", readAccessToken: async () => "account-token" },
      sandbox: { sandboxId: "sandbox-1" },
      prompt: "Help me plan dinner",
    });
    expect(relayFetch).toHaveBeenCalledOnce();
  });
});
