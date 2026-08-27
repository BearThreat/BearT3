import { expect, it, vi } from "vite-plus/test";

import { mergeThreadSearchRankings, searchThreadSidecar } from "./ThreadSearchSidecar.ts";

const documents = [
  { id: "env/auth", threadId: "auth", projectId: "project", title: "Auth", text: "Token" },
];

it("does not call the network when the sidecar is not configured", async () => {
  const fetchFn = vi.fn<typeof fetch>();
  expect(
    await searchThreadSidecar({ query: "token", limit: 10, documents, fetchFn, baseUrl: "" }),
  ).toBeNull();
  expect(fetchFn).not.toHaveBeenCalled();
});

it("accepts only known, unique thread ids from a compatible response", async () => {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      contractVersion: 1,
      results: [{ threadId: "auth" }, { threadId: "unknown" }, { threadId: "auth" }],
    }),
  );
  expect(
    await searchThreadSidecar({
      query: "token",
      limit: 10,
      documents,
      baseUrl: "http://127.0.0.1:8793/",
      fetchFn,
    }),
  ).toEqual(["auth"]);
});

it("sends the bounded document payload unchanged", async () => {
  let body: unknown;
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ contractVersion: 1, results: [] });
  });
  await searchThreadSidecar({
    query: "token",
    limit: 10,
    documents,
    baseUrl: "http://127.0.0.1:8793",
    fetchFn,
  });
  expect(body).toEqual({ query: "token", limit: 10, documents });
});

it("fails open on transport, status, and contract errors", async () => {
  const common = { query: "token", limit: 10, documents, baseUrl: "http://sidecar" };
  expect(
    await searchThreadSidecar({
      ...common,
      fetchFn: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    }),
  ).toBeNull();
  expect(
    await searchThreadSidecar({
      ...common,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    }),
  ).toBeNull();
  expect(
    await searchThreadSidecar({
      ...common,
      fetchFn: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ contractVersion: 2, results: [] })),
    }),
  ).toBeNull();
});

it("boosts overlap while keeping exact-only results ahead of sidecar-only results", () => {
  const result = mergeThreadSearchRankings({
    exact: [
      { key: "exact", item: "exact" },
      { key: "both", item: "both-from-exact" },
    ],
    sidecar: [
      { key: "both", item: "both-from-sidecar" },
      { key: "semantic", item: "semantic" },
    ],
    limit: 3,
  });
  expect(result).toEqual(["both-from-exact", "exact", "semantic"]);
});
