const ORGANIZER_MESSAGE_MILESTONES = [1, 2, 3, 5] as const;

export function shouldRunConversationOrganizer(userMessageCount: number): boolean {
  if (!Number.isInteger(userMessageCount) || userMessageCount < 1) return false;
  let scale = 1;
  while (scale <= userMessageCount) {
    if (ORGANIZER_MESSAGE_MILESTONES.some((milestone) => milestone * scale === userMessageCount)) {
      return true;
    }
    scale *= 10;
  }
  return false;
}

export function normalizeOrganizerText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function resolveConversationProjectSuggestion<
  T extends { readonly id: string; readonly title: string },
>(input: {
  readonly projects: ReadonlyArray<T>;
  readonly currentProjectId: string;
  readonly userMessages: ReadonlyArray<string>;
}): T | undefined {
  const conversation = ` ${normalizeOrganizerText(input.userMessages.join("\n"))} `;
  if (conversation.trim().length === 0) return undefined;

  const matches = input.projects.filter((project) => {
    if (project.id === input.currentProjectId || project.title === "Unassigned") return false;
    const title = normalizeOrganizerText(project.title);
    // Short names create too many accidental matches. Exact IDs remain
    // available to the user through the normal project picker.
    if (title.length < 4) return false;
    return conversation.includes(` ${title} `);
  });

  // A suggestion is useful only when the conversation names one owner.
  return matches.length === 1 ? matches[0] : undefined;
}
