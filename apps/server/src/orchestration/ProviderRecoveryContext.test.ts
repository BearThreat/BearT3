import { describe, expect, it } from "vite-plus/test";
import { MessageId, type OrchestrationMessage, TurnId } from "@t3tools/contracts";

import { buildProviderRecoveryContext } from "./ProviderRecoveryContext.ts";

function message(
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  overrides: Partial<OrchestrationMessage> = {},
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: TurnId.make(`turn-${id}`),
    streaming: false,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildProviderRecoveryContext", () => {
  it("pins the first user request and retains the recent transcript", () => {
    const context = buildProviderRecoveryContext(
      [
        message("first", "user", "Build the recovery system."),
        message("answer", "assistant", "I changed the protocol reader."),
        message("current", "user", "Continue."),
      ],
      MessageId.make("current"),
    );

    expect(context).toContain("USER:\nBuild the recovery system.");
    expect(context).toContain("ASSISTANT:\nI changed the protocol reader.");
    expect(context).not.toContain("USER:\nContinue.");
  });

  it("omits old middle messages before exceeding the limit", () => {
    const context = buildProviderRecoveryContext(
      [
        message("first", "user", "Original objective"),
        message("old", "assistant", "x".repeat(400)),
        message("recent", "assistant", "Recent verified state"),
        message("current", "user", "Continue"),
      ],
      MessageId.make("current"),
      500,
    );

    expect(context.length).toBeLessThanOrEqual(500);
    expect(context).toContain("Original objective");
    expect(context).toContain("Recent verified state");
    expect(context).toContain("Earlier messages omitted");
  });

  it("records attachment metadata without embedding image bytes", () => {
    const context = buildProviderRecoveryContext(
      [
        message("first", "user", "Inspect this", {
          attachments: [
            {
              type: "image",
              id: "image-1",
              name: "failure.png",
              mimeType: "image/png",
              sizeBytes: 4096,
            },
          ],
        }),
        message("current", "user", "Continue"),
      ],
      MessageId.make("current"),
    );

    expect(context).toContain("failure.png; id=image-1; type=image/png; bytes=4096");
    expect(context).not.toContain("data:image");
  });
});
