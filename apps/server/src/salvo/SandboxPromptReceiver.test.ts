// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  SandboxPromptReceiver,
  SandboxPromptReceiverError,
  makeSandboxPromptFetchHandler,
  type SandboxPromptAuditEvent,
  type SandboxPromptGatewayClient,
} from "./SandboxPromptReceiver.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});
const setup = (overrides: Partial<SandboxPromptGatewayClient> = {}) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "salvo-sandbox-receiver-"));
  dirs.push(dir);
  let calls = 0;
  const events: SandboxPromptAuditEvent[] = [];
  const receiver = new SandboxPromptReceiver({
    filename: NodePath.join(dir, "receipts.sqlite"),
    gateway: {
      execute: async () => {
        calls++;
        return { gatewayProviderReceiptId: "gw-1", text: "done", billedMicros: 12 };
      },
      ...overrides,
    },
    authorizeGrant: async (grant, binding) =>
      grant === `grant:${binding.sandboxId}:${binding.requestId}`,
    audit: (event) => events.push(event),
    makeReceiptId: () => "sandbox-receipt-1",
  });
  const request = {
    sandboxId: "sandbox-a",
    requestId: "request-1",
    turnId: "turn-1",
    model: "codex-mini",
    prompt: "private prompt",
    maxOutputTokens: 100,
    reserveMicros: 1_000,
  };
  return { dir, receiver, request, events, calls: () => calls };
};

describe("SandboxPromptReceiver", () => {
  test("denies wrong sandbox and wrong scoped grant before gateway use", async () => {
    const context = setup();
    await expect(
      context.receiver.execute(
        { sandboxId: "sandbox-b" },
        "grant:sandbox-a:request-1",
        context.request,
      ),
    ).rejects.toMatchObject({ code: "sandbox_mismatch" });
    await expect(
      context.receiver.execute(
        { sandboxId: "sandbox-a" },
        "grant:sandbox-a:other",
        context.request,
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(context.calls()).toBe(0);
    context.receiver.close();
  });

  test("replays the same durable receipt after restart", async () => {
    const context = setup();
    const first = await context.receiver.execute(
      { sandboxId: "sandbox-a" },
      "grant:sandbox-a:request-1",
      context.request,
    );
    context.receiver.close();
    let restartedCalls = 0;
    using restarted = new SandboxPromptReceiver({
      filename: NodePath.join(context.dir, "receipts.sqlite"),
      gateway: {
        execute: async () => {
          restartedCalls++;
          throw new Error("must not call");
        },
      },
      authorizeGrant: async () => true,
    });
    const replay = await restarted.execute(
      { sandboxId: "sandbox-a" },
      "grant:sandbox-a:request-1",
      context.request,
    );
    expect(replay).toEqual({ ...first, replayed: true });
    expect(restartedCalls).toBe(0);
  });

  test("coalesces concurrent duplicates into one gateway call", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const context = setup({
      execute: async () => {
        calls++;
        await blocked;
        return { gatewayProviderReceiptId: "gw-1", text: "done", billedMicros: 12 };
      },
    });
    const first = context.receiver.execute(
      { sandboxId: "sandbox-a" },
      "grant:sandbox-a:request-1",
      context.request,
    );
    const second = context.receiver.execute(
      { sandboxId: "sandbox-a" },
      "grant:sandbox-a:request-1",
      context.request,
    );
    await Promise.resolve();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(a.sandboxExecutionReceiptId).toBe(b.sandboxExecutionReceiptId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    context.receiver.close();
  });

  test("does not persist gateway failures and permits a retry", async () => {
    let attempts = 0;
    const context = setup({
      execute: async () => {
        attempts++;
        if (attempts === 1) throw new Error("temporary");
        return { gatewayProviderReceiptId: "gw-after-retry", text: "done", billedMicros: 12 };
      },
    });
    await expect(
      context.receiver.execute(
        { sandboxId: "sandbox-a" },
        "grant:sandbox-a:request-1",
        context.request,
      ),
    ).rejects.toBeInstanceOf(SandboxPromptReceiverError);
    const result = await context.receiver.execute(
      { sandboxId: "sandbox-a" },
      "grant:sandbox-a:request-1",
      context.request,
    );
    expect(attempts).toBe(2);
    expect(result.gatewayProviderReceiptId).toBe("gw-after-retry");
    context.receiver.close();
  });

  test("emits only allowlisted audit fields and exposes a Fetch handler", async () => {
    const context = setup();
    const handler = makeSandboxPromptFetchHandler({
      receiver: context.receiver,
      authenticate: async () => ({ sandboxId: "sandbox-a" }),
    });
    const response = await handler(
      new Request("https://sandbox.test/salvo/sandbox/prompt", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "salvo-inference-grant": "grant:sandbox-a:request-1",
        },
        body: JSON.stringify(context.request),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      sandboxExecutionReceiptId: "sandbox-receipt-1",
      gatewayProviderReceiptId: "gw-1",
    });
    expect(JSON.stringify(context.events)).not.toContain("private prompt");
    expect(JSON.stringify(context.events)).not.toContain("grant:sandbox");
    for (const event of context.events)
      expect(
        Object.keys(event).every((key) =>
          [
            "event",
            "sandboxId",
            "requestId",
            "reason",
            "sandboxExecutionReceiptId",
            "gatewayProviderReceiptId",
          ].includes(key),
        ),
      ).toBe(true);
    context.receiver.close();
  });
});
