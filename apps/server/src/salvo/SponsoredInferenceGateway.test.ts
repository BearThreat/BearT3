// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  issueSponsoredInferenceGrant,
  SponsoredInferenceGateway,
  SponsoredInferenceGatewayError,
} from "./SponsoredInferenceGateway.js";

const directories: Array<string> = [];
const fixture = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "salvo-gateway-"));
  directories.push(directory);
  const calls: Array<unknown> = [];
  const audits: Array<unknown> = [];
  const secret = NodeCrypto.randomBytes(32);
  const options = {
    filename: NodePath.join(directory, "gateway.sqlite"),
    secret,
    calls,
    audits,
    gateway: new SponsoredInferenceGateway({
      filename: NodePath.join(directory, "gateway.sqlite"),
      signingSecret: secret,
      budget: { pilotCapMicros: 1_000, perUserCapMicros: 700, perTurnCapMicros: 500 },
      allowedModels: new Set(["codex-mini"]),
      now: () => 1_000,
      provider: {
        execute: async (input: unknown) => {
          calls.push(input);
          return { text: "done", billedMicros: 200 };
        },
      },
      audit: (event) => audits.push(event),
    }),
  };
  return options;
};
const request = {
  requestId: "r1",
  turnId: "t1",
  model: "codex-mini",
  prompt: "fix it",
  maxOutputTokens: 100,
  reserveMicros: 300,
};
const grant = (f: ReturnType<typeof fixture>, userId = "u1", grantId = "g1", expiresAt = 2_000) =>
  issueSponsoredInferenceGrant({ secret: f.secret, userId, grantId, expiresAt });
const rejects = async (promise: Promise<unknown>, code: SponsoredInferenceGatewayError["code"]) =>
  expect(promise).rejects.toMatchObject({ code });

afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("SponsoredInferenceGateway", () => {
  it("attributes the user, commits the actual cost, and durably replays without another provider call", async () => {
    const f = fixture();
    const first = await f.gateway.execute({ userId: "u1" }, grant(f), request);
    expect(first).toEqual({ requestId: "r1", text: "done", billedMicros: 200, replayed: false });
    f.gateway.close();
    using restarted = new SponsoredInferenceGateway({ ...f.gateway.options, filename: f.filename });
    expect(await restarted.execute({ userId: "u1" }, grant(f), request)).toMatchObject({
      replayed: true,
      billedMicros: 200,
    });
    expect(f.calls).toHaveLength(1);
  });

  it("rejects impersonation, tampering, conflicting replay, and non-allowlisted models", async () => {
    using f = fixture().gateway;
    const secret = f.options.signingSecret;
    const good = issueSponsoredInferenceGrant({
      secret,
      userId: "u1",
      grantId: "g1",
      expiresAt: 2_000,
    });
    await rejects(f.execute({ userId: "u2" }, good, request), "invalid_grant");
    await rejects(f.execute({ userId: "u1" }, `${good}x`, request), "invalid_grant");
    await f.execute({ userId: "u1" }, good, request);
    await rejects(
      f.execute({ userId: "u1" }, good, { ...request, prompt: "changed" }),
      "conflicting_replay",
    );
    await rejects(
      f.execute({ userId: "u1" }, good, { ...request, requestId: "r2", model: "other" }),
      "invalid_request",
    );
    await rejects(
      f.execute({ userId: "u1" }, good, {
        ...request,
        requestId: "r3",
        extra: "not allowed",
      } as typeof request),
      "invalid_request",
    );
  });

  it("enforces revocation, expiry, global stop, and budget caps before provider execution", async () => {
    const f = fixture();
    using gateway = f.gateway;
    gateway.revoke("revoked");
    await rejects(
      gateway.execute({ userId: "u1" }, grant(f, "u1", "revoked"), request),
      "grant_revoked",
    );
    await rejects(
      gateway.execute({ userId: "u1" }, grant(f, "u1", "expired", 1_000), request),
      "grant_expired",
    );
    gateway.setGlobalStop(true);
    await rejects(gateway.execute({ userId: "u1" }, grant(f), request), "global_stop");
    gateway.setGlobalStop(false);
    await rejects(
      gateway.execute({ userId: "u1" }, grant(f), { ...request, reserveMicros: 501 }),
      "budget_denied",
    );
    expect(f.calls).toHaveLength(0);
  });

  it("releases reservations on provider failure and exposes only allowlisted audit fields", async () => {
    const f = fixture();
    f.gateway.close();
    using gateway = new SponsoredInferenceGateway({
      ...f.gateway.options,
      filename: f.filename,
      provider: {
        execute: async () => {
          throw new Error("secret provider detail");
        },
      },
    });
    await rejects(gateway.execute({ userId: "u1" }, grant(f), request), "provider_failed");
    expect(f.audits.at(-1)).toEqual({
      type: "failed",
      requestId: "r1",
      userId: "u1",
      reason: "provider_failed",
    });
    expect(JSON.stringify(f.audits)).not.toContain("prompt");
    expect(JSON.stringify(f.audits)).not.toContain("secret provider detail");
  });
});
