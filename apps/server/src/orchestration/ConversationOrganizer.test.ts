import { describe, expect, it } from "vite-plus/test";

import {
  resolveConversationProjectSuggestion,
  shouldRunConversationOrganizer,
} from "./ConversationOrganizer.ts";

describe("conversation organizer", () => {
  it("uses bounded early and logarithmic message milestones", () => {
    for (const count of [1, 2, 3, 5, 10, 20, 30, 50, 100]) {
      expect(shouldRunConversationOrganizer(count)).toBe(true);
    }
    for (const count of [0, 4, 6, 9, 11, 31, 99]) {
      expect(shouldRunConversationOrganizer(count)).toBe(false);
    }
  });

  it("suggests one explicitly named different project", () => {
    const result = resolveConversationProjectSuggestion({
      projects: [
        { id: "current", title: "Unassigned" },
        { id: "bear", title: "BearT3 Release Orchestrator" },
        { id: "mobile", title: "Mobile Thread List" },
      ],
      currentProjectId: "current",
      userMessages: ["Please continue the BearT3 release-orchestrator work."],
    });

    expect(result?.id).toBe("bear");
  });

  it("does not suggest the current, unassigned, ambiguous, or implied owner", () => {
    const projects = [
      { id: "current", title: "Mobile Thread List" },
      { id: "one", title: "Bear-T3" },
      { id: "two", title: "Bear T3" },
      { id: "unassigned", title: "Unassigned" },
    ];

    expect(
      resolveConversationProjectSuggestion({
        projects,
        currentProjectId: "current",
        userMessages: ["The mobile thread list still needs work."],
      }),
    ).toBeUndefined();
    expect(
      resolveConversationProjectSuggestion({
        projects,
        currentProjectId: "current",
        userMessages: ["Continue BearT3."],
      }),
    ).toBeUndefined();
    expect(
      resolveConversationProjectSuggestion({
        projects,
        currentProjectId: "current",
        userMessages: ["This sounds related to a release process."],
      }),
    ).toBeUndefined();
  });
});
