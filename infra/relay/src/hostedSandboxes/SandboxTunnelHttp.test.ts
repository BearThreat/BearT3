// @effect-diagnostics globalErrorInEffectFailure:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { SandboxBootstrapCredentials } from "./SandboxBootstrapTokens.ts";
import { routes } from "./SandboxTunnelHttp.ts";

const setup = () => {
  const calls: Array<{
    url: string;
    authorization: string | null;
    idempotency: string | null;
    body: string;
  }> = [];
  const credentials = SandboxBootstrapCredentials.of({
    issue: () => Effect.fail(new Error("unused")),
    redeem: () => Effect.fail(new Error("unused")),
    authenticate: () => Effect.succeed(null),
    resolve: (sandboxId) =>
      Effect.succeed(
        sandboxId === "sandbox-a"
          ? {
              sandboxId,
              userId: "user-a",
              providerRef: "i-owned",
              controlSecret: "private-control-secret",
              tunnelEndpoint: "https://private.sandbox.test",
            }
          : null,
      ),
    revoke: () => Effect.succeed({ revoked: 0, tunnelsRetired: 0 }),
    listExpiring: () => Effect.succeed([]),
  });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    calls.push({
      url: String(input),
      authorization: headers.get("authorization"),
      idempotency: headers.get("idempotency-key"),
      body,
    });
    return Response.json(
      String(input).endsWith("/health")
        ? { ready: true, sandboxId: "sandbox-a" }
        : {
            requestId: "request-a",
            sandboxId: "sandbox-a",
            sandboxExecutionReceiptId: "execution-a",
            gatewayProviderReceiptId: "provider-a",
            acceptedAt: "2026-08-25T00:00:00Z",
          },
    );
  };
  const web = HttpRouter.toWebHandler(
    routes("gateway-secret", { fetch }).pipe(
      Layer.provideMerge(Layer.succeed(SandboxBootstrapCredentials, credentials)),
    ),
    { disableLogger: true },
  );
  return { calls, web };
};

describe("SandboxTunnelHttp", () => {
  it("binds health to the durable instance and authenticates the private receiver", async () => {
    const f = setup();
    expect(
      (
        await f.web.handler(
          new Request("https://relay.test/v1/sandboxes/sandbox-a/health?instanceId=i-wrong", {
            headers: { authorization: "Bearer gateway-secret" },
          }),
        )
      ).status,
    ).toBe(403);
    const response = await f.web.handler(
      new Request("https://relay.test/v1/sandboxes/sandbox-a/health?instanceId=i-owned", {
        headers: { authorization: "Bearer gateway-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(f.calls[0]).toMatchObject({
      url: "https://private.sandbox.test/v1/sandboxes/sandbox-a/health",
      authorization: "Bearer private-control-secret",
    });
    await f.web.dispose();
  });

  it("proxies one bounded idempotent prompt without returning or logging credentials", async () => {
    const f = setup();
    const body = JSON.stringify({
      sandboxId: "sandbox-a",
      requestId: "request-a",
      prompt: "private prompt",
    });
    const response = await f.web.handler(
      new Request("https://relay.test/v1/sandboxes/sandbox-a/prompts", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
          "idempotency-key": "request-a",
        },
        body,
      }),
    );
    expect(response.status).toBe(200);
    expect(f.calls[0]).toMatchObject({ idempotency: "request-a", body });
    expect(JSON.stringify(await response.json())).not.toContain("private-control-secret");
    await f.web.dispose();
  });
});
