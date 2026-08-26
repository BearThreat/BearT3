import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeInMemory, SponsoredInferenceUnavailable } from "./SponsoredInferenceGateway.ts";

const receipt = (requestId: string) => ({
  requestId,
  providerReceiptId: `provider-${requestId}`,
  acceptedAt: "2026-08-24T12:00:00.000Z",
});

describe("Salvo sponsored inference gateway", () => {
  it.effect("binds grants to their owner and sandbox and attributes the prompt", () => {
    const calls: Array<unknown> = [];
    const gateway = makeInMemory({
      nowMs: () => 1_777_000_000_000,
      token: () => "grant-1",
      provider: {
        execute: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return receipt(input.requestId);
          }),
      },
    });
    return Effect.gen(function* () {
      const grant = yield* gateway.service.issueGrant({
        userId: "member-1",
        sandboxId: "sandbox-1",
      });
      yield* gateway.service.execute({
        grant,
        userId: "member-1",
        sandboxId: "sandbox-1",
        requestId: "prompt-1",
        prompt: "hello",
      });
      expect(calls).toEqual([
        { userId: "member-1", sandboxId: "sandbox-1", requestId: "prompt-1", prompt: "hello" },
      ]);
      for (const identity of [
        { userId: "member-2", sandboxId: "sandbox-1" },
        { userId: "member-1", sandboxId: "sandbox-2" },
      ]) {
        const error = yield* Effect.flip(
          gateway.service.execute({ grant, ...identity, requestId: "denied", prompt: "no" }),
        );
        expect(error).toBeInstanceOf(SponsoredInferenceUnavailable);
      }
      expect(calls).toHaveLength(1);
    });
  });

  it.effect("enforces revocation and global stop before provider execution", () => {
    let calls = 0;
    let next = 0;
    const gateway = makeInMemory({
      nowMs: () => 1_777_000_000_000,
      token: () => `grant-${++next}`,
      provider: {
        execute: (input) =>
          Effect.sync(() => {
            calls++;
            return receipt(input.requestId);
          }),
      },
    });
    return Effect.gen(function* () {
      const revoked = yield* gateway.service.issueGrant({
        userId: "member-1",
        sandboxId: "sandbox-1",
      });
      gateway.revoke(revoked.token);
      yield* Effect.flip(
        gateway.service.execute({
          grant: revoked,
          userId: "member-1",
          sandboxId: "sandbox-1",
          requestId: "r1",
          prompt: "no",
        }),
      );
      const stopped = yield* gateway.service.issueGrant({
        userId: "member-1",
        sandboxId: "sandbox-1",
      });
      gateway.setGlobalStop(true);
      yield* Effect.flip(
        gateway.service.execute({
          grant: stopped,
          userId: "member-1",
          sandboxId: "sandbox-1",
          requestId: "r2",
          prompt: "no",
        }),
      );
      expect(calls).toBe(0);
    });
  });
});
