// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  issueSponsoredInferenceGrant,
  SponsoredInferenceGateway,
} from "./SponsoredInferenceGateway.js";
import { makeSponsoredInferenceHttpHandler } from "./SponsoredInferenceHttpHandler.js";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("sponsored inference HTTP boundary", () => {
  it("derives attribution from authentication, not the body, and returns an allowlisted response", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "salvo-http-"));
    directories.push(directory);
    const secret = NodeCrypto.randomBytes(32);
    const calls: Array<unknown> = [];
    using gateway = new SponsoredInferenceGateway({
      filename: NodePath.join(directory, "gateway.sqlite"),
      signingSecret: secret,
      budget: { pilotCapMicros: 1_000, perUserCapMicros: 700, perTurnCapMicros: 500 },
      allowedModels: new Set(["codex-mini"]),
      now: () => 1_000,
      provider: {
        execute: async (input) => {
          calls.push(input);
          return { text: "safe", billedMicros: 12 };
        },
      },
    });
    const handler = makeSponsoredInferenceHttpHandler({
      gateway,
      authenticate: async (request) =>
        request.headers.get("authorization") === "Bearer family-session"
          ? { userId: "family-user" }
          : null,
    });
    const signedGrant = issueSponsoredInferenceGrant({
      secret,
      grantId: "sandbox-1",
      userId: "family-user",
      expiresAt: 2_000,
    });
    const response = await handler(
      new Request("https://salvo.test/inference", {
        method: "POST",
        headers: {
          authorization: "Bearer family-session",
          "salvo-inference-grant": signedGrant,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: "r1",
          turnId: "t1",
          model: "codex-mini",
          prompt: "hello",
          maxOutputTokens: 100,
          reserveMicros: 100,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      requestId: "r1",
      text: "safe",
      billedMicros: 12,
      replayed: false,
    });
    expect(calls).toEqual([
      { idempotencyKey: "r1", model: "codex-mini", prompt: "hello", maxOutputTokens: 100 },
    ]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unauthenticated and body-attribution attempts before provider execution", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "salvo-http-"));
    directories.push(directory);
    const secret = NodeCrypto.randomBytes(32);
    let calls = 0;
    using gateway = new SponsoredInferenceGateway({
      filename: NodePath.join(directory, "gateway.sqlite"),
      signingSecret: secret,
      budget: { pilotCapMicros: 1_000, perUserCapMicros: 700, perTurnCapMicros: 500 },
      allowedModels: new Set(["codex-mini"]),
      now: () => 1_000,
      provider: {
        execute: async () => {
          calls++;
          return { text: "unsafe", billedMicros: 1 };
        },
      },
    });
    const handler = makeSponsoredInferenceHttpHandler({ gateway, authenticate: async () => null });
    const response = await handler(
      new Request("https://salvo.test/inference", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "admin" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "authentication_required" });
    expect(calls).toBe(0);
  });

  it("rejects malformed authenticated JSON with a bounded error response", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "salvo-http-"));
    directories.push(directory);
    const secret = NodeCrypto.randomBytes(32);
    using gateway = new SponsoredInferenceGateway({
      filename: NodePath.join(directory, "gateway.sqlite"),
      signingSecret: secret,
      budget: { pilotCapMicros: 1_000, perUserCapMicros: 700, perTurnCapMicros: 500 },
      allowedModels: new Set(["codex-mini"]),
      provider: { execute: async () => ({ text: "must not run", billedMicros: 1 }) },
    });
    const handler = makeSponsoredInferenceHttpHandler({
      gateway,
      authenticate: async () => ({ userId: "family-user" }),
    });
    const response = await handler(
      new Request("https://salvo.test/inference", {
        method: "POST",
        headers: { "content-type": "application/json", "salvo-inference-grant": "invalid" },
        body: "null",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "invalid_request" });
  });
});
