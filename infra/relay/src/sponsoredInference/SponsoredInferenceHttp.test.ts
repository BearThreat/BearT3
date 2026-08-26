// @effect-diagnostics globalErrorInEffectFailure:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import { SandboxBootstrapCredentials } from "../hostedSandboxes/SandboxBootstrapTokens.ts";
import {
  SponsoredInferenceGateway,
  SponsoredInferenceUnavailable,
} from "./SponsoredInferenceGateway.ts";
import { routes } from "./SponsoredInferenceHttp.ts";

const setup = () => {
  const calls: Array<Record<string, unknown>> = [];
  const credentials = SandboxBootstrapCredentials.of({
    issue: () => Effect.fail(new Error("unused")),
    redeem: () => Effect.fail(new Error("unused")),
    authenticate: (secret) =>
      Effect.succeed(
        secret === "sandbox-control-secret" ? { userId: "user-a", sandboxId: "sandbox-a" } : null,
      ),
    resolve: () => Effect.succeed(null),
    revoke: () => Effect.succeed({ revoked: 0, tunnelsRetired: 0 }),
    listExpiring: () => Effect.succeed([]),
  });
  const gateway = SponsoredInferenceGateway.of({
    issueGrant: () => Effect.fail(new SponsoredInferenceUnavailable({ code: "invalid_request" })),
    execute: (input) => {
      calls.push(input as unknown as Record<string, unknown>);
      return Effect.succeed({
        requestId: input.requestId,
        text: "safe output",
        billedMicros: 17,
        replayed: false,
        providerReceiptId: "provider-receipt-a",
        acceptedAt: "2026-08-25T01:02:03Z",
      });
    },
  });
  const layer = routes.pipe(
    Layer.provideMerge(Layer.succeed(SandboxBootstrapCredentials, credentials)),
    Layer.provideMerge(Layer.succeed(SponsoredInferenceGateway, gateway)),
  );
  return { calls, web: HttpRouter.toWebHandler(layer, { disableLogger: true }) };
};

const request = (authorization = "Bearer sandbox-control-secret") =>
  new Request("https://relay.test/v1/sponsored-inference/execute", {
    method: "POST",
    headers: {
      authorization,
      "salvo-inference-grant": "grant-token-a",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: "request-a",
      turnId: "turn-a",
      model: "salvo-default",
      prompt: "hello",
      maxOutputTokens: 100,
      reserveMicros: 100,
    }),
  });

describe("SponsoredInferenceHttp", () => {
  it("mounts authenticated sandbox execution and derives identity from the durable bootstrap principal", async () => {
    const { calls, web } = setup();
    const response = await web.handler(request(), undefined as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      requestId: "request-a",
      text: "safe output",
      billedMicros: 17,
      replayed: false,
      gatewayProviderReceiptId: "provider-receipt-a",
      acceptedAt: "2026-08-25T01:02:03Z",
    });
    expect(calls).toEqual([
      {
        requestId: "request-a",
        turnId: "turn-a",
        model: "salvo-default",
        prompt: "hello",
        maxOutputTokens: 100,
        reserveMicros: 100,
        userId: "user-a",
        sandboxId: "sandbox-a",
        grant: { token: "grant-token-a", userId: "user-a", sandboxId: "sandbox-a" },
      },
    ]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await web.dispose();
  });

  it("rejects an unknown sandbox secret before gateway execution", async () => {
    const { calls, web } = setup();
    const response = await web.handler(request("Bearer wrong-secret"), undefined as never);
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
    await web.dispose();
  });

  it("returns only a safe stable error code", async () => {
    const credentials = SandboxBootstrapCredentials.of({
      issue: () => Effect.fail(new Error("unused")),
      redeem: () => Effect.fail(new Error("unused")),
      authenticate: () => Effect.succeed({ userId: "user-a", sandboxId: "sandbox-a" }),
      resolve: () => Effect.succeed(null),
      revoke: () => Effect.succeed({ revoked: 0, tunnelsRetired: 0 }),
      listExpiring: () => Effect.succeed([]),
    });
    const gateway = SponsoredInferenceGateway.of({
      issueGrant: () => Effect.fail(new SponsoredInferenceUnavailable({ code: "invalid_request" })),
      execute: () => Effect.fail(new SponsoredInferenceUnavailable({ code: "budget_denied" })),
    });
    const web = HttpRouter.toWebHandler(
      routes.pipe(
        Layer.provideMerge(Layer.succeed(SandboxBootstrapCredentials, credentials)),
        Layer.provideMerge(Layer.succeed(SponsoredInferenceGateway, gateway)),
      ),
      { disableLogger: true },
    );
    const response = await web.handler(request(), undefined as never);
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ code: "budget_denied" });
    await web.dispose();
  });
});
