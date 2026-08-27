export type ConversationProjectSuggestion = {
  readonly activityId: string;
  readonly projectId: string;
  readonly projectTitle: string;
};

export function latestConversationProjectSuggestion(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly payload: unknown;
  }>,
): ConversationProjectSuggestion | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "organizer.project.suggested") continue;
    const payload = activity.payload;
    if (!payload || typeof payload !== "object") continue;
    const projectId = "projectId" in payload ? payload.projectId : undefined;
    const projectTitle = "projectTitle" in payload ? payload.projectTitle : undefined;
    if (typeof projectId !== "string" || typeof projectTitle !== "string") continue;
    return { activityId: activity.id, projectId, projectTitle };
  }
  return null;
}

export function resolveSuggestedProject<
  T extends { readonly id: string; readonly environmentId: string },
>(
  projects: ReadonlyArray<T>,
  environmentId: string,
  suggestion: ConversationProjectSuggestion | null,
): T | null {
  if (!suggestion) return null;
  return (
    projects.find(
      (project) => project.environmentId === environmentId && project.id === suggestion.projectId,
    ) ?? null
  );
}

export function projectSuggestionMoveInput<
  TThreadId extends string,
  TProjectId extends string,
>(input: {
  readonly threadId: TThreadId;
  readonly projectId: TProjectId;
  readonly worktreePath: string | null;
}) {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    worktreePath: input.worktreePath,
  };
}
