import { describe, expect, it } from "vite-plus/test";

import {
  automaticRecoveryDelayMs,
  descriptorFromGracefulShutdown,
  descriptorFromReconciledOrphan,
  hasGracefulShutdownRecoveryMarker,
  hasManualInterruptForTurn,
  interruptedTurnForAutomaticRecovery,
  isEligibleAfterGracefulShutdown,
  isEligibleAfterOrphanReconciliation,
  isRecoveryMessageId,
  recoveryCommandKey,
  recoveryMessageId,
} from "./ThreadRecoverySupervisor.ts";

const orphanError =
  "Provider session did not survive a server restart. Send a new message to continue.";
const runningThread = {
  archivedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestUserMessageAt: "2026-08-17T19:00:00.000Z",
  recovery: null,
  latestTurn: { turnId: "turn-1", state: "running" },
  session: { status: "running", activeTurnId: "turn-1", lastError: null },
} as const;
const descriptor = {
  threadId: "thread-1",
  interruptedTurnId: "turn-1",
  latestUserMessageAt: runningThread.latestUserMessageAt,
};
const reconciledThread = {
  ...runningThread,
  session: { status: "error", activeTurnId: null, lastError: orphanError },
} as const;

describe("ThreadRecoverySupervisor", () => {
  it("selects only a matching interrupted active turn", () => {
    expect(interruptedTurnForAutomaticRecovery(runningThread as never)).toBe("turn-1");
    expect(
      interruptedTurnForAutomaticRecovery({
        ...runningThread,
        latestTurn: { turnId: "turn-old", state: "running" },
      } as never),
    ).toBeNull();
  });

  it.each([
    { archivedAt: "2026-08-17T00:00:00.000Z" },
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { recovery: { phase: "candidate" } },
    { session: { status: "stopped", activeTurnId: null, lastError: null } },
    { session: { status: "error", activeTurnId: null, lastError: orphanError } },
    { session: { status: "ready", activeTurnId: null, lastError: null } },
    { latestTurn: { turnId: "turn-1", state: "completed" } },
  ])("does not capture blocked or terminal state: %o", (patch) => {
    expect(interruptedTurnForAutomaticRecovery({ ...runningThread, ...patch } as never)).toBeNull();
  });

  it.each([
    { latestUserMessageAt: "2026-08-17T20:00:00.000Z" },
    { archivedAt: "2026-08-17T20:00:00.000Z" },
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { recovery: { phase: "candidate" } },
    { latestTurn: { turnId: "turn-1", state: "completed" } },
    { latestTurn: { turnId: "turn-2", state: "running" } },
    { session: { status: "ready", activeTurnId: null, lastError: null } },
    { session: { status: "error", activeTurnId: null, lastError: "different" } },
  ])("cancels recovery when a post-grace guard changes: %o", (patch) => {
    expect(
      isEligibleAfterOrphanReconciliation(
        { ...reconciledThread, ...patch } as never,
        descriptor,
        orphanError,
      ),
    ).toBe(false);
  });

  it("accepts only the known orphan cleanup state", () => {
    expect(
      isEligibleAfterOrphanReconciliation(reconciledThread as never, descriptor, orphanError),
    ).toBe(true);
    expect(
      descriptorFromReconciledOrphan("thread-1", reconciledThread as never, orphanError),
    ).toEqual(descriptor);
  });

  it("accepts a fresh exact graceful-shutdown marker", () => {
    const stoppedAt = "2026-08-17T19:00:10.000Z";
    const stoppedThread = {
      ...runningThread,
      latestTurn: {
        ...runningThread.latestTurn,
        state: "interrupted",
        completedAt: stoppedAt,
      },
      session: {
        status: "stopped",
        activeTurnId: null,
        lastError: null,
        updatedAt: stoppedAt,
      },
    } as const;
    const graceful = descriptorFromGracefulShutdown(
      "thread-1",
      stoppedThread as never,
      { gracefulShutdownRecovery: { turnId: "turn-1", stoppedAt } },
      "2026-08-17T19:01:00.000Z",
    );
    expect(graceful).toEqual({
      ...descriptor,
      source: "graceful-shutdown",
      gracefulShutdownStoppedAt: stoppedAt,
    });
    expect(isEligibleAfterGracefulShutdown(stoppedThread as never, graceful!)).toBe(true);
  });

  it("arms from the exact running marker and accepts its shutdown error state", () => {
    const stoppedAt = "2026-08-17T19:00:10.000Z";
    const payload = { gracefulShutdownRecovery: { turnId: "turn-1", stoppedAt } };
    const graceful = descriptorFromGracefulShutdown(
      "thread-1",
      runningThread as never,
      payload,
      "2026-08-17T19:01:00.000Z",
    );
    expect(graceful).not.toBeNull();
    expect(
      isEligibleAfterGracefulShutdown(
        {
          ...runningThread,
          latestTurn: { ...runningThread.latestTurn, state: "error" },
          session: { status: "error", activeTurnId: null, lastError: "shutdown" },
        } as never,
        graceful!,
      ),
    ).toBe(true);
  });

  it("detects marker presence but suppresses a matching manual interruption", () => {
    const payload = {
      gracefulShutdownRecovery: {
        turnId: "turn-1",
        stoppedAt: "2026-08-17T19:00:10.000Z",
      },
      manualInterruptTurnId: "turn-1",
    };
    expect(hasGracefulShutdownRecoveryMarker(payload)).toBe(true);
    expect(hasManualInterruptForTurn(payload, "turn-1")).toBe(true);
    expect(
      descriptorFromGracefulShutdown(
        "thread-1",
        runningThread as never,
        payload,
        "2026-08-17T19:01:00.000Z",
      ),
    ).toBeNull();
  });

  it.each([
    { name: "missing marker", payload: {}, observedAt: "2026-08-17T19:01:00.000Z" },
    {
      name: "manual interruption marker cleared",
      payload: { gracefulShutdownRecovery: null },
      observedAt: "2026-08-17T19:01:00.000Z",
    },
    {
      name: "different turn",
      payload: {
        gracefulShutdownRecovery: {
          turnId: "turn-old",
          stoppedAt: "2026-08-17T19:00:10.000Z",
        },
      },
      observedAt: "2026-08-17T19:01:00.000Z",
    },
    {
      name: "stale restart",
      payload: {
        gracefulShutdownRecovery: {
          turnId: "turn-1",
          stoppedAt: "2026-08-17T18:00:00.000Z",
        },
      },
      observedAt: "2026-08-17T19:01:00.000Z",
    },
  ])("rejects $name", ({ payload, observedAt }) => {
    const stoppedThread = {
      ...runningThread,
      latestTurn: { ...runningThread.latestTurn, state: "interrupted" },
      session: { status: "stopped", activeTurnId: null, lastError: null },
    } as const;
    expect(
      descriptorFromGracefulShutdown("thread-1", stoppedThread as never, payload, observedAt),
    ).toBeNull();
  });

  it("suppresses paused and finished policies", () => {
    expect(automaticRecoveryDelayMs(null)).toBe(30_000);
    expect(automaticRecoveryDelayMs({ mode: "paused" })).toBeNull();
    expect(automaticRecoveryDelayMs({ mode: "finished", reason: "done" })).toBeNull();
  });

  it("derives stable command and message identities", () => {
    expect(recoveryCommandKey("thread-1", "turn-1")).toBe("thread-recovery:thread-1:turn-1");
    expect(recoveryMessageId("thread-1", "turn-1")).toBe("server:thread-recovery:thread-1:turn-1");
    expect(isRecoveryMessageId(recoveryMessageId("thread-1", "turn-1"))).toBe(true);
    expect(isRecoveryMessageId("user-message-1")).toBe(false);
  });
});
