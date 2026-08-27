const DEFAULT_TIMEOUT_MS = 900;

export interface ThreadSearchSidecarDocument {
  readonly id: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly text: string;
}

interface ThreadSearchSidecarResponse {
  readonly contractVersion: 1;
  readonly results: ReadonlyArray<{ readonly threadId: string }>;
}

export interface ThreadSearchRankingEntry<T> {
  readonly key: string;
  readonly item: T;
}

export function isThreadSearchSidecarEnabled(): boolean {
  return (process.env.T3_THREAD_SEARCH_SIDECAR_URL?.trim().length ?? 0) > 0;
}

function isSearchResponse(value: unknown): value is ThreadSearchSidecarResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as { contractVersion?: unknown; results?: unknown };
  return (
    response.contractVersion === 1 &&
    Array.isArray(response.results) &&
    response.results.every(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        typeof (result as { threadId?: unknown }).threadId === "string",
    )
  );
}

export async function searchThreadSidecar(input: {
  readonly query: string;
  readonly limit: number;
  readonly documents: ReadonlyArray<ThreadSearchSidecarDocument>;
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<ReadonlyArray<string> | null> {
  const configuredUrl = input.baseUrl ?? process.env.T3_THREAD_SEARCH_SIDECAR_URL;
  if (configuredUrl === undefined || configuredUrl.trim() === "") return null;

  try {
    const response = await (input.fetchFn ?? fetch)(
      `${configuredUrl.trim().replace(/\/$/, "")}/v1/search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: input.query,
          limit: input.limit,
          documents: input.documents,
        }),
        signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isSearchResponse(body)) return null;

    const allowed = new Set(input.documents.map((document) => document.threadId));
    const seen = new Set<string>();
    return body.results.flatMap((result) => {
      if (!allowed.has(result.threadId) || seen.has(result.threadId)) return [];
      seen.add(result.threadId);
      return [result.threadId];
    });
  } catch {
    return null;
  }
}

/** Core exact results remain authoritative; sidecar overlap can improve ranking. */
export function mergeThreadSearchRankings<T>(input: {
  readonly exact: ReadonlyArray<ThreadSearchRankingEntry<T>>;
  readonly sidecar: ReadonlyArray<ThreadSearchRankingEntry<T>>;
  readonly limit: number;
}): ReadonlyArray<T> {
  const fused = new Map<string, { item: T; score: number; firstSeen: number }>();
  let firstSeen = 0;
  const add = (ranking: ReadonlyArray<ThreadSearchRankingEntry<T>>, weight: number) => {
    ranking.forEach((entry, rank) => {
      const score = weight / (60 + rank + 1);
      const current = fused.get(entry.key);
      if (current === undefined) {
        fused.set(entry.key, { item: entry.item, score, firstSeen });
        firstSeen += 1;
      } else {
        current.score += score;
      }
    });
  };
  add(input.exact, 2);
  add(input.sidecar, 1);
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.firstSeen - right.firstSeen)
    .slice(0, input.limit)
    .map(({ item }) => item);
}
