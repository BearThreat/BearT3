import { describe, expect, it } from "vite-plus/test";

import {
  latestConversationProjectSuggestion,
  projectSuggestionMoveInput,
  resolveSuggestedProject,
} from "./conversationOrganizer";

describe("conversation organizer presentation", () => {
  it("uses the latest valid suggestion and ignores malformed activities", () => {
    expect(
      latestConversationProjectSuggestion([
        { id: "first", kind: "organizer.project.suggested", payload: null },
        {
          id: "second",
          kind: "organizer.project.suggested",
          payload: { projectId: "project-2", projectTitle: "Project Two" },
        },
      ]),
    ).toEqual({ activityId: "second", projectId: "project-2", projectTitle: "Project Two" });
  });

  it("resolves a project only inside the active environment", () => {
    const projects = [
      { id: "same-id", environmentId: "other", title: "Wrong" },
      { id: "same-id", environmentId: "active", title: "Right" },
    ];
    const suggestion = {
      activityId: "activity",
      projectId: "same-id",
      projectTitle: "Right",
    };

    expect(resolveSuggestedProject(projects, "active", suggestion)?.title).toBe("Right");
    expect(resolveSuggestedProject(projects, "missing", suggestion)).toBeNull();
  });

  it("preserves both a worktree path and an intentional null while moving", () => {
    expect(
      projectSuggestionMoveInput({
        threadId: "thread",
        projectId: "project",
        worktreePath: "/repo/.t3/worktrees/thread",
      }).worktreePath,
    ).toBe("/repo/.t3/worktrees/thread");
    expect(
      projectSuggestionMoveInput({
        threadId: "thread",
        projectId: "project",
        worktreePath: null,
      }).worktreePath,
    ).toBeNull();
  });
});
