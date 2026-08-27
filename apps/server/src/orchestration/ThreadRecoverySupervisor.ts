import type { OrchestrationThreadShell } from "@t3tools/contracts";

export const THREAD_RECOVERY_PROMPT = `System recovery: the previous agent turn was interrupted by a BearT3 server restart. Resume the user's existing objective autonomously. First inspect the conversation, current workspace, completed artifacts, running or completed subagents, and provider state. Reconstruct a remaining-work checklist and continue from the last verified state. Do not blindly repeat tool calls or any external, destructive, paid, message-sending, publishing, deployment, or credential-changing action; verify whether it already happened before retrying it. Preserve completed work, report a concrete blocker only when safe continuation is impossible, and otherwise continue until the original objective is genuinely handled.`;

export const DEFAULT_RECOVERY_GRACE_MS = 30_000;
export const DEFAULT_GRACEFUL_SHUTDOWN_RECOVERY_MAX_AGE_MS = 5 * 60_000;

export interface GracefulShutdownRecoveryMarker {
  readonly turnId: string;
  readonly stoppedAt: string;
}

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
  readonly source?: "orphan" | "graceful-shutdown";
  readonly gracefulShutdownStoppedAt?: string;
}

function gracefulShutdownRecoveryMarker(
  runtimePayload: unknown,
): GracefulShutdownRecoveryMarker | null {
  if (
    runtimePayload === null ||
    typeof runtimePayload !== "object" ||
    Array.isArray(runtimePayload)
  ) {
    return null;
  }
  const marker = (runtimePayload as { readonly gracefulShutdownRecovery?: unknown })
    .gracefulShutdownRecovery;
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) return null;
  const { turnId, stoppedAt } = marker as {
    readonly turnId?: unknown;
    readonly stoppedAt?: unknown;
  };
  if (typeof turnId !== "string" || turnId.length === 0 || typeof stoppedAt !== "string") {
    return null;
  }
  const manualInterruptTurnId = (runtimePayload as { readonly manualInterruptTurnId?: unknown })
    .manualInterruptTurnId;
  return manualInterruptTurnId === turnId ? null : { turnId, stoppedAt };
}

export function hasGracefulShutdownRecoveryMarker(runtimePayload: unknown): boolean {
  return (
    runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload) &&
    "gracefulShutdownRecovery" in runtimePayload &&
    runtimePayload.gracefulShutdownRecovery !== null &&
    runtimePayload.gracefulShutdownRecovery !== undefined
  );
}

export function hasManualInterruptForTurn(runtimePayload: unknown, turnId: string): boolean {
  return (
    runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload) &&
    (runtimePayload as { readonly manualInterruptTurnId?: unknown }).manualInterruptTurnId ===
      turnId
  );
}

function isFreshGracefulShutdownRecoveryMarker(
  marker: GracefulShutdownRecoveryMarker,
  observedAt: string,
  maxAgeMs: number,
): boolean {
  const stoppedAtMs = Date.parse(marker.stoppedAt);
  const observedAtMs = Date.parse(observedAt);
  const ageMs = observedAtMs - stoppedAtMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= Math.max(0, maxAgeMs);
}

function hasGracefulShutdownLifecycle(
  thread: RecoveryThread,
  turnId: string,
  phase: "startup" | "after-grace",
): boolean {
  if (thread.latestTurn?.turnId !== turnId) return false;
  if (
    thread.latestTurn.state === "interrupted" &&
    thread.session?.status === "stopped" &&
    thread.session.activeTurnId === null
  ) {
    return true;
  }
  if (
    thread.latestTurn.state === "error" &&
    thread.session?.status === "error" &&
    thread.session.activeTurnId === null
  ) {
    return true;
  }
  return (
    phase === "startup" &&
    thread.latestTurn.state === "running" &&
    thread.session?.status === "running" &&
    thread.session.activeTurnId === turnId
  );
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

export function descriptorFromGracefulShutdown(
  threadId: string,
  thread: RecoveryThread,
  runtimePayload: unknown,
  observedAt: string,
  maxAgeMs = DEFAULT_GRACEFUL_SHUTDOWN_RECOVERY_MAX_AGE_MS,
): ThreadRecoveryDescriptor | null {
  const marker = gracefulShutdownRecoveryMarker(runtimePayload);
  if (marker === null) return null;
  if (!isFreshGracefulShutdownRecoveryMarker(marker, observedAt, maxAgeMs)) return null;
  if (
    thread.archivedAt !== null ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.recovery != null ||
    !hasGracefulShutdownLifecycle(thread, marker.turnId, "startup")
  ) {
    return null;
  }
  return {
    threadId,
    interruptedTurnId: marker.turnId,
    latestUserMessageAt: thread.latestUserMessageAt,
    source: "graceful-shutdown",
    gracefulShutdownStoppedAt: marker.stoppedAt,
  };
}

export function matchesGracefulShutdownRecoveryMarker(
  runtimePayload: unknown,
  descriptor: ThreadRecoveryDescriptor,
  observedAt?: string,
  maxAgeMs = DEFAULT_GRACEFUL_SHUTDOWN_RECOVERY_MAX_AGE_MS,
): boolean {
  if (descriptor.source !== "graceful-shutdown") return true;
  const marker = gracefulShutdownRecoveryMarker(runtimePayload);
  return (
    marker !== null &&
    marker.turnId === descriptor.interruptedTurnId &&
    marker.stoppedAt === descriptor.gracefulShutdownStoppedAt &&
    (observedAt === undefined ||
      isFreshGracefulShutdownRecoveryMarker(marker, observedAt, maxAgeMs))
  );
}

export function isEligibleAfterGracefulShutdown(
  thread: RecoveryThread,
  descriptor: ThreadRecoveryDescriptor,
): boolean {
  return (
    descriptor.source === "graceful-shutdown" &&
    thread.archivedAt === null &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    thread.recovery == null &&
    thread.latestUserMessageAt === descriptor.latestUserMessageAt &&
    hasGracefulShutdownLifecycle(thread, descriptor.interruptedTurnId, "after-grace")
  );
}

export function isEligibleAfterRecoveryGrace(
  thread: RecoveryThread,
  descriptor: ThreadRecoveryDescriptor,
  orphanError: string,
): boolean {
  return descriptor.source === "graceful-shutdown"
    ? isEligibleAfterGracefulShutdown(thread, descriptor)
    : isEligibleAfterOrphanReconciliation(thread, descriptor, orphanError);
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
