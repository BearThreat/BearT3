// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { MessageId, OrchestrationMessage, ThreadId } from "@t3tools/contracts";

import { resolveAttachmentPath } from "../attachmentStore.ts";

export const PROVIDER_RECOVERY_BUNDLE_MAX_MESSAGES = 32;
export const PROVIDER_RECOVERY_BUNDLE_MAX_MESSAGE_CHARS = 32_000;
export const PROVIDER_RECOVERY_BUNDLE_MAX_TOTAL_CHARS = 512_000;
export const PROVIDER_RECOVERY_BUNDLE_MAX_BUNDLES = 8;
export const PROVIDER_RECOVERY_BUNDLE_TTL_MS = 24 * 60 * 60 * 1_000;
export const PROVIDER_RECOVERY_BUNDLE_MAX_ATTACHMENTS = 4;
export const PROVIDER_RECOVERY_BUNDLE_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const PROVIDER_RECOVERY_BUNDLE_MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const RECOVERY_ROOT = NodePath.join(".t3", "recovery-context");

type RecoveryBundleMessage = {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly createdAt: string;
  readonly textFile: string;
  readonly truncated: boolean;
  readonly attachments: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly contentAvailable: boolean;
    readonly file?: string;
    readonly unavailableReason?: string;
  }>;
};

export type ProviderRecoveryBundleResult = {
  readonly bundleId: string;
  readonly manifestRelativePath: string;
  readonly messageCount: number;
  readonly omittedMessageCount: number;
};

function assertContained(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${NodePath.sep}`)) {
    throw new Error("Recovery bundle path escaped its workspace root.");
  }
}

function assertNoSymlinkPath(root: string, candidate: string): void {
  const relative = NodePath.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(NodePath.sep).filter((part) => part.length > 0)) {
    current = NodePath.join(current, segment);
    if (NodeFS.existsSync(current) && NodeFS.lstatSync(current).isSymbolicLink()) {
      throw new Error("Recovery bundle path contains a symbolic link.");
    }
  }
}

function ensurePrivateDirectory(path: string): void {
  NodeFS.mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = NodeFS.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Recovery bundle path is not a private directory.");
  }
  NodeFS.chmodSync(path, 0o700);
}

function verifyPrivateFile(path: string): void {
  const stat = NodeFS.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Recovery bundle file is not a regular file.");
  }
  NodeFS.chmodSync(path, 0o600);
}

function stableBundleId(
  threadId: ThreadId,
  currentMessageId: MessageId,
  messages: ReadonlyArray<OrchestrationMessage>,
): string {
  const hash = NodeCrypto.createHash("sha256");
  hash.update(String(threadId));
  hash.update("\0");
  hash.update(String(currentMessageId));
  for (const message of messages) {
    hash.update("\0");
    hash.update(String(message.id));
    hash.update("\0");
    hash.update(message.role);
    hash.update("\0");
    hash.update(message.text);
    for (const attachment of message.attachments ?? []) {
      hash.update("\0");
      hash.update(
        `${attachment.id}:${attachment.name}:${attachment.mimeType}:${attachment.sizeBytes}`,
      );
    }
  }
  return hash.digest("hex").slice(0, 24);
}

function selectMessages(
  messages: ReadonlyArray<OrchestrationMessage>,
  currentMessageId: MessageId,
): { readonly selected: ReadonlyArray<OrchestrationMessage>; readonly omitted: number } {
  const historical = messages.filter(
    (message) => message.id !== currentMessageId && !message.streaming,
  );
  const selected: Array<OrchestrationMessage> = [];
  let used = 0;
  for (const message of historical.toReversed()) {
    const chars = Math.min(message.text.length, PROVIDER_RECOVERY_BUNDLE_MAX_MESSAGE_CHARS);
    if (
      selected.length >= PROVIDER_RECOVERY_BUNDLE_MAX_MESSAGES ||
      used + chars > PROVIDER_RECOVERY_BUNDLE_MAX_TOTAL_CHARS
    ) {
      continue;
    }
    selected.unshift(message);
    used += chars;
  }
  return { selected, omitted: historical.length - selected.length };
}

function cleanupBundles(threadRoot: string, keepBundleId: string, nowMs: number): void {
  const candidates = NodeFS.readdirSync(threadRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== keepBundleId)
    .map((entry) => {
      const path = NodePath.join(threadRoot, entry.name);
      return { path, mtimeMs: NodeFS.statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const [index, candidate] of candidates.entries()) {
    if (
      nowMs - candidate.mtimeMs > PROVIDER_RECOVERY_BUNDLE_TTL_MS ||
      index >= PROVIDER_RECOVERY_BUNDLE_MAX_BUNDLES - 1
    ) {
      NodeFS.rmSync(candidate.path, { recursive: true, force: true });
    }
  }
}

export function writeProviderRecoveryBundle(input: {
  readonly cwd: string;
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly currentMessageId: MessageId;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly nowMs: number;
}): ProviderRecoveryBundleResult {
  const workspaceRoot = NodeFS.realpathSync(input.cwd);
  const recoveryRoot = NodePath.resolve(workspaceRoot, RECOVERY_ROOT);
  assertContained(workspaceRoot, recoveryRoot);
  assertNoSymlinkPath(workspaceRoot, recoveryRoot);
  ensurePrivateDirectory(recoveryRoot);
  const resolvedRecoveryRoot = NodeFS.realpathSync(recoveryRoot);
  assertContained(workspaceRoot, resolvedRecoveryRoot);

  const threadKey = NodeCrypto.createHash("sha256")
    .update(String(input.threadId))
    .digest("hex")
    .slice(0, 16);
  const threadRoot = NodePath.join(resolvedRecoveryRoot, threadKey);
  assertContained(resolvedRecoveryRoot, threadRoot);
  ensurePrivateDirectory(threadRoot);

  const { selected, omitted } = selectMessages(input.messages, input.currentMessageId);
  const bundleId = stableBundleId(input.threadId, input.currentMessageId, input.messages);
  const bundleRoot = NodePath.join(threadRoot, bundleId);
  assertContained(threadRoot, bundleRoot);
  ensurePrivateDirectory(bundleRoot);

  const manifestMessages: Array<RecoveryBundleMessage> = [];
  let copiedAttachmentCount = 0;
  let copiedAttachmentBytes = 0;
  const attachmentStoreRoot = NodeFS.existsSync(input.attachmentsDir)
    ? NodeFS.realpathSync(input.attachmentsDir)
    : undefined;
  selected.forEach((message, index) => {
    const textFile = `message-${String(index + 1).padStart(3, "0")}.txt`;
    const text = message.text.slice(0, PROVIDER_RECOVERY_BUNDLE_MAX_MESSAGE_CHARS);
    const textPath = NodePath.join(bundleRoot, textFile);
    assertContained(bundleRoot, textPath);
    if (!NodeFS.existsSync(textPath)) {
      NodeFS.writeFileSync(textPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    verifyPrivateFile(textPath);
    const attachments = (message.attachments ?? []).map((attachment) => {
      const unavailable = (unavailableReason: string) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        contentAvailable: false,
        unavailableReason,
      });
      if (attachmentStoreRoot === undefined) return unavailable("attachment_store_missing");
      if (copiedAttachmentCount >= PROVIDER_RECOVERY_BUNDLE_MAX_ATTACHMENTS) {
        return unavailable("attachment_count_limit");
      }
      const sourcePath = resolveAttachmentPath({
        attachmentsDir: input.attachmentsDir,
        attachment,
      });
      if (sourcePath === null || !NodeFS.existsSync(sourcePath)) {
        return unavailable("attachment_missing");
      }
      const sourceStat = NodeFS.lstatSync(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        return unavailable("attachment_not_regular_file");
      }
      const realSourcePath = NodeFS.realpathSync(sourcePath);
      try {
        assertContained(attachmentStoreRoot, realSourcePath);
      } catch {
        return unavailable("attachment_outside_store");
      }
      if (
        sourceStat.size > PROVIDER_RECOVERY_BUNDLE_MAX_ATTACHMENT_BYTES ||
        copiedAttachmentBytes + sourceStat.size >
          PROVIDER_RECOVERY_BUNDLE_MAX_TOTAL_ATTACHMENT_BYTES
      ) {
        return unavailable("attachment_byte_limit");
      }
      const extension = NodePath.extname(realSourcePath).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".bin"].includes(extension)) {
        return unavailable("attachment_type_not_allowlisted");
      }
      const file = `attachment-${String(copiedAttachmentCount + 1).padStart(3, "0")}${extension}`;
      const destinationPath = NodePath.join(bundleRoot, file);
      assertContained(bundleRoot, destinationPath);
      if (!NodeFS.existsSync(destinationPath)) {
        NodeFS.copyFileSync(sourcePath, destinationPath, NodeFS.constants.COPYFILE_EXCL);
      }
      verifyPrivateFile(destinationPath);
      copiedAttachmentCount += 1;
      copiedAttachmentBytes += sourceStat.size;
      return {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        contentAvailable: true,
        file,
      };
    });
    manifestMessages.push({
      id: String(message.id),
      role: message.role,
      createdAt: message.createdAt,
      textFile,
      truncated: text.length < message.text.length,
      attachments,
    });
  });

  const manifestRelativePath = NodePath.join(RECOVERY_ROOT, threadKey, bundleId, "manifest.json");
  const manifestPath = NodePath.join(bundleRoot, "manifest.json");
  const manifest = {
    version: 1,
    bundleId,
    threadId: String(input.threadId),
    currentMessageId: String(input.currentMessageId),
    bounds: {
      maxMessages: PROVIDER_RECOVERY_BUNDLE_MAX_MESSAGES,
      maxMessageChars: PROVIDER_RECOVERY_BUNDLE_MAX_MESSAGE_CHARS,
      maxTotalChars: PROVIDER_RECOVERY_BUNDLE_MAX_TOTAL_CHARS,
      maxAttachments: PROVIDER_RECOVERY_BUNDLE_MAX_ATTACHMENTS,
      maxAttachmentBytes: PROVIDER_RECOVERY_BUNDLE_MAX_ATTACHMENT_BYTES,
      maxTotalAttachmentBytes: PROVIDER_RECOVERY_BUNDLE_MAX_TOTAL_ATTACHMENT_BYTES,
    },
    omittedMessageCount: omitted,
    messages: manifestMessages,
    agentInputBoundary: {
      seesNow: "Only the recovery prompt and this manifest path.",
      canFetch: "This manifest and listed message text files through workspace file tools.",
      cannotSee:
        "Unlisted messages and attachment bytes that were missing, unsafe, unsupported, or over a bundle limit.",
    },
  };
  if (!NodeFS.existsSync(manifestPath)) {
    NodeFS.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }
  verifyPrivateFile(manifestPath);
  cleanupBundles(threadRoot, bundleId, input.nowMs);
  return {
    bundleId,
    manifestRelativePath,
    messageCount: selected.length,
    omittedMessageCount: omitted,
  };
}
