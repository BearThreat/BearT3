import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { routes } from "./SandboxBootstrapHttp.ts";
import { SandboxBootstrapCredentials } from "./SandboxBootstrapTokens.ts";

const setup = () => {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const service = SandboxBootstrapCredentials.of({
    issue: (value) => {
      calls.push({ kind: "issue", value });
      return Effect.succeed({
        token: "aa".repeat(32),
        bootstrapUrl: "https://relay.test/v1/bootstrap/redeem",
        expiresAt: "2026-08-25T00:05:00Z",
      });
    },
    redeem: (value) => {
      calls.push({ kind: "redeem", value });
      return Effect.succeed({
        controlSecret: "secret".repeat(8),
        environment: "SALVO_SANDBOX_ID=sandbox-a\n",
        tunnelToken: "token".repeat(8),
        tunnelEndpoint: "https://sandbox.test",
      });
    },
    authenticate: () => Effect.succeed(null),
    resolve: () => Effect.succeed(null),
    revoke: () => Effect.succeed({ revoked: 0, tunnelsRetired: 0 }),
    listExpiring: () => Effect.succeed([]),
  });
  const app = Layer.provideMerge(
    routes("gateway-secret"),
    Layer.succeed(SandboxBootstrapCredentials, service),
  );
  return { calls, web: HttpRouter.toWebHandler(app, { disableLogger: true }) };
};

describe("SandboxBootstrapHttp", () => {
  it("requires gateway authentication and binds issue input to the route sandbox", async () => {
    const { calls, web } = setup();
    const body = JSON.stringify({ userId: "user-a", clientToken: "salvo-sandbox-a" });
    expect(
      (
        await web.handler(
          new Request("https://relay.test/v1/sandboxes/sandbox-a/bootstrap-tokens", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        )
      ).status,
    ).toBe(401);
    const response = await web.handler(
      new Request("https://relay.test/v1/sandboxes/sandbox-a/bootstrap-tokens", {
        method: "POST",
        headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(201);
    expect(calls).toEqual([
      {
        kind: "issue",
        value: { sandboxId: "sandbox-a", userId: "user-a", clientToken: "salvo-sandbox-a" },
      },
    ]);
    await web.dispose();
  });

  it("redeems the capability without requiring the control-plane bearer", async () => {
    const { calls, web } = setup();
    const value = {
      token: "aa".repeat(32),
      sandboxId: "sandbox-a",
      userId: "user-a",
      clientToken: "salvo-sandbox-a",
    };
    const response = await web.handler(
      new Request("https://relay.test/v1/bootstrap/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ kind: "redeem", value }]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await web.dispose();
  });
});
