import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadStatus } from "./threadPresentation";

const NOW = "2026-08-27T12:00:00.000Z";

function makeThread(input: Partial<EnvironmentThreadShell>): EnvironmentThreadShell {
  return {
    id: ThreadId.make("thread"),
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

describe("resolveThreadStatus activity labels", () => {
  it("labels an active recovery before the generic session state", () => {
    const status = resolveThreadStatus(
      makeThread({
        latestTurn: {
          turnId: TurnId.make("turn"),
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
          recovery: true,
        },
        session: {
          threadId: ThreadId.make("thread"),
          status: "starting",
          providerName: "Codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn"),
          lastError: null,
          updatedAt: NOW,
        },
      }),
    );

    expect(status).toMatchObject({ label: "Recovering", kind: "working", pulse: true });
  });

  it("distinguishes monitoring from active background work", () => {
    expect(resolveThreadStatus(makeThread({ backgroundLiveness: "monitoring" }))).toMatchObject({
      label: "Monitoring",
      kind: "working",
      pulse: false,
    });
    expect(resolveThreadStatus(makeThread({ backgroundLiveness: "working" }))).toMatchObject({
      label: "Working",
      kind: "working",
      pulse: true,
    });
  });

  it("keeps user-blocking states above recovery and background activity", () => {
    expect(
      resolveThreadStatus(makeThread({ hasPendingApprovals: true, backgroundLiveness: "working" })),
    ).toMatchObject({ label: "Needs Approval", kind: "pending-approval" });
    expect(
      resolveThreadStatus(makeThread({ hasPendingUserInput: true, backgroundLiveness: "working" })),
    ).toMatchObject({ label: "Awaiting Input", kind: "awaiting-input" });
  });
});
