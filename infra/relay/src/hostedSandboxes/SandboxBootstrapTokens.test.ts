import { describe, expect, it } from "@effect/vitest";
import {
  makeSandboxBootstrapTokens,
  type SandboxBootstrapTokenRecord,
} from "./SandboxBootstrapTokens.ts";

const fixture = (clock = { now: 1_000_000 }) => {
  const rows = new Map<string, SandboxBootstrapTokenRecord>();
  const repository = {
    insert: async (row: SandboxBootstrapTokenRecord) => {
      rows.set(row.tokenHash, row);
    },
    consume: async (input: {
      tokenHash: string;
      sandboxId: string;
      userId: string;
      clientToken: string;
      nowMs: number;
    }) => {
      const row = rows.get(input.tokenHash);
      if (
        !row ||
        row.consumedAtMs !== null ||
        row.expiresAtMs <= input.nowMs ||
        row.sandboxId !== input.sandboxId ||
        row.userId !== input.userId ||
        row.clientToken !== input.clientToken
      )
        return false;
      rows.set(input.tokenHash, { ...row, consumedAtMs: input.nowMs });
      return true;
    },
  };
  return {
    clock,
    rows,
    tokens: makeSandboxBootstrapTokens(repository, {
      now: () => clock.now,
      randomBytes: () => Buffer.alloc(32, 7),
      ttlMs: 10_000,
    }),
  };
};

describe("SandboxBootstrapTokens", () => {
  it("stores only a digest and consumes exactly once", async () => {
    const f = fixture();
    const issued = await f.tokens.issue({
      sandboxId: "sandbox-a",
      userId: "user-a",
      clientToken: "salvo-sandbox-a",
    });
    expect([...f.rows.keys()][0]).not.toBe(issued.token);
    const binding = {
      token: issued.token,
      sandboxId: "sandbox-a",
      userId: "user-a",
      clientToken: "salvo-sandbox-a",
    };
    expect(await f.tokens.consume(binding)).toBe(true);
    expect(await f.tokens.consume(binding)).toBe(false);
  });
  it("rejects expiry and every wrong binding", async () => {
    for (const wrong of [
      { sandboxId: "sandbox-b" },
      { userId: "user-b" },
      { clientToken: "salvo-other" },
    ]) {
      const f = fixture();
      const issued = await f.tokens.issue({
        sandboxId: "sandbox-a",
        userId: "user-a",
        clientToken: "salvo-sandbox-a",
      });
      expect(
        await f.tokens.consume({
          token: issued.token,
          sandboxId: "sandbox-a",
          userId: "user-a",
          clientToken: "salvo-sandbox-a",
          ...wrong,
        }),
      ).toBe(false);
    }
    const f = fixture();
    const issued = await f.tokens.issue({
      sandboxId: "sandbox-a",
      userId: "user-a",
      clientToken: "salvo-sandbox-a",
    });
    f.clock.now = issued.expiresAtMs;
    expect(
      await f.tokens.consume({
        token: issued.token,
        sandboxId: "sandbox-a",
        userId: "user-a",
        clientToken: "salvo-sandbox-a",
      }),
    ).toBe(false);
  });
});
