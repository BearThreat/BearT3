import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterResumeError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function mapAcpResumeError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (!isAcpRequestError(error)) {
    return mapAcpToAdapterError(provider, threadId, "session/load", error);
  }

  const message = error.errorMessage.trim().toLowerCase();
  const reason =
    error.code === -32601
      ? "unsupported_resume"
      : /(?:unknown|missing|invalid) session|session (?:was )?not found|session .*does not exist/.test(
            message,
          )
        ? "session_missing"
        : /(?:expired|stale) session|session (?:has )?expired/.test(message)
          ? "session_stale"
          : undefined;

  if (!reason) {
    return mapAcpToAdapterError(provider, threadId, "session/load", error);
  }

  return new ProviderAdapterResumeError({
    provider,
    method: "session/load",
    reason,
    detail: `ACP session/load cannot restore the persisted provider session (${reason}).`,
    cause: error,
  });
}

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}
