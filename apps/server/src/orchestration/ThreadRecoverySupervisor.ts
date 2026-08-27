import type { OrchestrationThreadShell } from "@t3tools/contracts";

export const THREAD_RECOVERY_PROMPT = `System recovery: the previous agent turn was interrupted by a BearT3 server restart. Resume the user's existing objective autonomously. First inspect the conversation, current workspace, completed artifacts, running or completed subagents, and provider state. Reconstruct a remaining-work checklist and continue from the last verified state. Do not blindly repeat tool calls or any external, destructive, paid, message-sending, publishing, deployment, or credential-changing action; verify whether it already happened before retrying it. Preserve completed work, report a concrete blocker only when safe continuation is impossible, and otherwise continue until the original objective is genuinely handled.`;

export const DEFAULT_RECOVERY_GRACE_MS = 30_000;

export type ThreadRecoveryPolicy =
  | {
      readonly mode: "paused";
      readonly fallbackAt?: string | undefined;
      readonly event?: string | undefined;
    }
  | { readonly mode: "finished"; readonly reason?: string | undefined };

export type RecoveryThread = Pick<
  OrchestrationThreadShell,
  | "archivedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "latestTurn"
  | "latestUserMessageAt"
  | "recovery"
  | "session"
>;

export interface ThreadRecoveryDescriptor {
  readonly threadId: string;
  readonly interruptedTurnId: string;
  readonly latestUserMessageAt: string | null;
}

export function automaticRecoveryDelayMs(
  policy: ThreadRecoveryPolicy | null | undefined,
  defaultGraceMs = DEFAULT_RECOVERY_GRACE_MS,
): number | null {
  if (policy?.mode === "finished" || policy?.mode === "paused") return null;
  return Math.max(0, defaultGraceMs);
}

export function interruptedTurnForAutomaticRecovery(thread: RecoveryThread): string | null {
  if (thread.archivedAt !== null) return null;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput || thread.recovery != null)
    return null;
  if (thread.session?.status !== "running" || thread.session.activeTurnId === null) return null;
  if (thread.latestTurn?.state !== "running") return null;
  if (thread.latestTurn.turnId !== thread.session.activeTurnId) return null;
  return thread.session.activeTurnId;
}

export function isEligibleAfterOrphanReconciliation(
  thread: RecoveryThread,
  descriptor: ThreadRecoveryDescriptor,
  orphanError: string,
): boolean {
  return (
    thread.archivedAt === null &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    thread.recovery == null &&
    thread.latestUserMessageAt === descriptor.latestUserMessageAt &&
    thread.latestTurn?.turnId === descriptor.interruptedTurnId &&
    thread.latestTurn.state === "running" &&
    thread.session?.status === "error" &&
    thread.session.activeTurnId === null &&
    thread.session.lastError === orphanError
  );
}

export function descriptorFromReconciledOrphan(
  threadId: string,
  thread: RecoveryThread,
  orphanError: string,
): ThreadRecoveryDescriptor | null {
  const latestTurn = thread.latestTurn;
  if (latestTurn === null) return null;
  const descriptor = {
    threadId,
    interruptedTurnId: latestTurn.turnId,
    latestUserMessageAt: thread.latestUserMessageAt,
  } satisfies ThreadRecoveryDescriptor;
  return isEligibleAfterOrphanReconciliation(thread, descriptor, orphanError) ? descriptor : null;
}

export function recoveryCommandKey(threadId: string, interruptedTurnId: string): string {
  return `thread-recovery:${threadId}:${interruptedTurnId}`;
}

export function recoveryMessageId(threadId: string, interruptedTurnId: string): string {
  return `server:${recoveryCommandKey(threadId, interruptedTurnId)}`;
}

export function isRecoveryMessageId(messageId: string | null | undefined): boolean {
  return messageId?.startsWith("server:thread-recovery:") === true;
}
