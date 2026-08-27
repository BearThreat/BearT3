import type { MessageId, OrchestrationMessage } from "@t3tools/contracts";

export const PROVIDER_RECOVERY_CONTEXT_MAX_CHARS = 100_000;
const FIRST_USER_MAX_CHARS = 8_000;
const HEADER = `[BearT3 provider-session recovery context]
The previous provider session could not be resumed. Treat the bounded transcript below as prior conversation context. The workspace contains the current source of truth. Historical image contents are not embedded.`;
const OMITTED = "[Earlier messages omitted to stay within the recovery limit.]";

function formatMessage(message: OrchestrationMessage): string {
  const attachmentLines = (message.attachments ?? []).map(
    (attachment) =>
      `[Historical image: ${attachment.name}; id=${attachment.id}; type=${attachment.mimeType}; bytes=${attachment.sizeBytes}]`,
  );
  return `${message.role.toUpperCase()}:\n${[message.text.trim(), ...attachmentLines]
    .filter((part) => part.length > 0)
    .join("\n")}`;
}

export function buildProviderRecoveryContext(
  messages: ReadonlyArray<OrchestrationMessage>,
  currentMessageId: MessageId,
  maxChars = PROVIDER_RECOVERY_CONTEXT_MAX_CHARS,
): string {
  const historical = messages.filter(
    (message) => message.id !== currentMessageId && !message.streaming,
  );
  const firstUser = historical.find((message) => message.role === "user");
  const pinned = firstUser ? formatMessage(firstUser).slice(0, FIRST_USER_MAX_CHARS) : "";
  const fixed = [HEADER, pinned].filter((part) => part.length > 0).join("\n\n");
  const budget = Math.max(0, maxChars - fixed.length - OMITTED.length - 4);
  const retained: Array<string> = [];
  let used = 0;
  let omitted = false;

  for (const message of historical.toReversed()) {
    if (message.id === firstUser?.id) continue;
    const section = formatMessage(message);
    const separator = retained.length > 0 ? 2 : 0;
    if (used + separator + section.length > budget) {
      omitted = true;
      break;
    }
    retained.unshift(section);
    used += separator + section.length;
  }

  return [fixed, ...(omitted ? [OMITTED] : []), ...retained]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .slice(0, maxChars);
}
