// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { MessageId, ThreadId, type OrchestrationMessage } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  PROVIDER_RECOVERY_BUNDLE_MAX_ATTACHMENT_BYTES,
  PROVIDER_RECOVERY_BUNDLE_MAX_MESSAGES,
  writeProviderRecoveryBundle,
} from "./ProviderRecoveryBundle.ts";

const roots: Array<string> = [];
const makeRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-bundle-"));
  roots.push(root);
  return root;
};
const message = (index: number, text = `message ${index}`): OrchestrationMessage => ({
  id: MessageId.make(`message-${index}`),
  role: index % 2 === 0 ? "assistant" : "user",
  text,
  attachments:
    index === 1
      ? [
          {
            id: "attachment-1",
            type: "image",
            name: "secret.png",
            mimeType: "image/png",
            sizeBytes: 42,
          },
        ]
      : [],
  turnId: null,
  streaming: false,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
});

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("writeProviderRecoveryBundle", () => {
  it("writes an immutable bounded workspace-relative manifest", () => {
    const cwd = makeRoot();
    const messages = Array.from({ length: PROVIDER_RECOVERY_BUNDLE_MAX_MESSAGES + 5 }, (_, index) =>
      message(index + 1),
    );
    const result = writeProviderRecoveryBundle({
      cwd,
      attachmentsDir: NodePath.join(cwd, "attachments"),
      threadId: ThreadId.make("thread-a"),
      currentMessageId: MessageId.make("message-37"),
      messages,
      nowMs: 1,
    });
    expect(NodePath.isAbsolute(result.manifestRelativePath)).toBe(false);
    expect(result.messageCount).toBe(PROVIDER_RECOVERY_BUNDLE_MAX_MESSAGES);
    expect(result.omittedMessageCount).toBe(4);
    const manifestPath = NodePath.join(cwd, result.manifestRelativePath);
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
    expect(manifest.agentInputBoundary.cannotSee).toContain("attachment bytes");
    expect(manifest.messages[0].attachments).toEqual([]);
    expect(manifest.messages.at(-1).id).toBe("message-36");
    expect(NodeFS.statSync(manifestPath).mode & 0o777).toBe(0o600);

    const repeated = writeProviderRecoveryBundle({
      cwd,
      attachmentsDir: NodePath.join(cwd, "attachments"),
      threadId: ThreadId.make("thread-a"),
      currentMessageId: MessageId.make("message-37"),
      messages,
      nowMs: 2,
    });
    expect(repeated.bundleId).toBe(result.bundleId);
    expect(NodeFS.readFileSync(manifestPath, "utf8")).toContain(result.bundleId);
  });

  it("does not place historical message or attachment content in the reference string", () => {
    const cwd = makeRoot();
    const secret = "TOP-SECRET-MESSAGE";
    const result = writeProviderRecoveryBundle({
      cwd,
      attachmentsDir: NodePath.join(cwd, "attachments"),
      threadId: ThreadId.make("thread-secret"),
      currentMessageId: MessageId.make("current"),
      messages: [message(1, secret)],
      nowMs: 1,
    });
    expect(result.manifestRelativePath).not.toContain(secret);
    expect(result.manifestRelativePath).not.toContain("secret.png");
    const manifest = NodeFS.readFileSync(NodePath.join(cwd, result.manifestRelativePath), "utf8");
    expect(manifest).not.toContain(secret);
    expect(
      NodeFS.readFileSync(
        NodePath.join(
          NodePath.dirname(NodePath.join(cwd, result.manifestRelativePath)),
          "message-001.txt",
        ),
        "utf8",
      ),
    ).toBe(secret);
  });

  it("copies an allowlisted attachment into the private bounded bundle", () => {
    const cwd = makeRoot();
    const attachmentsDir = NodePath.join(cwd, "attachments");
    NodeFS.mkdirSync(attachmentsDir);
    const attachmentId = "thread-a-12345678-1234-1234-1234-123456789abc";
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachmentId}.png`), "png-bytes");
    const historical = {
      ...message(1),
      attachments: [
        {
          id: attachmentId,
          type: "image" as const,
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 9,
        },
      ],
    };
    const result = writeProviderRecoveryBundle({
      cwd,
      attachmentsDir,
      threadId: ThreadId.make("thread-a"),
      currentMessageId: MessageId.make("current"),
      messages: [historical],
      nowMs: 1,
    });
    const manifestPath = NodePath.join(cwd, result.manifestRelativePath);
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
    const copied = manifest.messages[0].attachments[0];
    expect(copied).toMatchObject({ contentAvailable: true, file: "attachment-001.png" });
    const copiedPath = NodePath.join(NodePath.dirname(manifestPath), copied.file);
    expect(NodeFS.readFileSync(copiedPath, "utf8")).toBe("png-bytes");
    expect(NodeFS.statSync(copiedPath).mode & 0o777).toBe(0o600);
  });

  it("keeps over-limit and symlinked attachments as metadata only", () => {
    const cwd = makeRoot();
    const attachmentsDir = NodePath.join(cwd, "attachments");
    NodeFS.mkdirSync(attachmentsDir);
    const largeId = "thread-a-12345678-1234-1234-1234-123456789abc";
    const linkId = "thread-a-abcdefab-1234-1234-1234-123456789abc";
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${largeId}.png`), "x");
    NodeFS.truncateSync(
      NodePath.join(attachmentsDir, `${largeId}.png`),
      PROVIDER_RECOVERY_BUNDLE_MAX_ATTACHMENT_BYTES + 1,
    );
    NodeFS.writeFileSync(NodePath.join(cwd, "outside.png"), "outside");
    NodeFS.symlinkSync(
      NodePath.join(cwd, "outside.png"),
      NodePath.join(attachmentsDir, `${linkId}.png`),
    );
    const historical = {
      ...message(2),
      attachments: [
        {
          id: largeId,
          type: "image" as const,
          name: "large.png",
          mimeType: "image/png",
          sizeBytes: PROVIDER_RECOVERY_BUNDLE_MAX_ATTACHMENT_BYTES + 1,
        },
        {
          id: linkId,
          type: "image" as const,
          name: "link.png",
          mimeType: "image/png",
          sizeBytes: 7,
        },
      ],
    };
    const result = writeProviderRecoveryBundle({
      cwd,
      attachmentsDir,
      threadId: ThreadId.make("thread-a"),
      currentMessageId: MessageId.make("current"),
      messages: [historical],
      nowMs: 1,
    });
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(cwd, result.manifestRelativePath), "utf8"),
    );
    expect(manifest.messages[0].attachments).toMatchObject([
      { contentAvailable: false, unavailableReason: "attachment_byte_limit" },
      { contentAvailable: false, unavailableReason: "attachment_not_regular_file" },
    ]);
  });

  it("rejects a symlinked recovery root", () => {
    const cwd = makeRoot();
    const outside = makeRoot();
    NodeFS.mkdirSync(NodePath.join(cwd, ".t3"), { recursive: true });
    NodeFS.symlinkSync(outside, NodePath.join(cwd, ".t3", "recovery-context"));
    expect(() =>
      writeProviderRecoveryBundle({
        cwd,
        attachmentsDir: NodePath.join(cwd, "attachments"),
        threadId: ThreadId.make("thread-a"),
        currentMessageId: MessageId.make("current"),
        messages: [message(1)],
        nowMs: 1,
      }),
    ).toThrow("symbolic link");
    expect(NodeFS.readdirSync(outside)).toEqual([]);
  });

  it("rejects a pre-created symlink in an otherwise valid bundle", () => {
    const cwd = makeRoot();
    const first = writeProviderRecoveryBundle({
      cwd,
      attachmentsDir: NodePath.join(cwd, "attachments"),
      threadId: ThreadId.make("thread-a"),
      currentMessageId: MessageId.make("current"),
      messages: [message(1)],
      nowMs: 1,
    });
    const bundleRoot = NodePath.dirname(NodePath.join(cwd, first.manifestRelativePath));
    const messagePath = NodePath.join(bundleRoot, "message-001.txt");
    NodeFS.writeFileSync(NodePath.join(cwd, "outside.txt"), "outside", "utf8");
    NodeFS.unlinkSync(messagePath);
    NodeFS.symlinkSync(NodePath.join(cwd, "outside.txt"), messagePath);
    expect(() =>
      writeProviderRecoveryBundle({
        cwd,
        attachmentsDir: NodePath.join(cwd, "attachments"),
        threadId: ThreadId.make("thread-a"),
        currentMessageId: MessageId.make("current"),
        messages: [message(1)],
        nowMs: 2,
      }),
    ).toThrow("regular file");
  });

  it("retains no more than the configured number of bundles per thread", () => {
    const cwd = makeRoot();
    const attachmentsDir = NodePath.join(cwd, "attachments");
    let lastManifest = "";
    for (let index = 0; index < 10; index += 1) {
      lastManifest = writeProviderRecoveryBundle({
        cwd,
        attachmentsDir,
        threadId: ThreadId.make("thread-a"),
        currentMessageId: MessageId.make(`current-${index}`),
        messages: [message(1)],
        nowMs: 1,
      }).manifestRelativePath;
    }
    const threadRoot = NodePath.dirname(NodePath.dirname(NodePath.join(cwd, lastManifest)));
    expect(NodeFS.readdirSync(threadRoot)).toHaveLength(8);
  });
});
