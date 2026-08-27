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

it.each([
  "http://127.0.0.1:8793",
  "https://127.255.255.254",
  "http://localhost:8793",
  "http://LOCALHOST",
  "http://[::1]:8793",
])("allows an explicit loopback sidecar URL: %s", async (baseUrl) => {
  const fetchFn = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ contractVersion: 1, results: [] }));
  expect(
    await searchThreadSidecar({ query: "token", limit: 10, documents, baseUrl, fetchFn }),
  ).toEqual([]);
  expect(fetchFn).toHaveBeenCalledOnce();
});

it.each([
  "not a URL",
  "file:///tmp/search",
  "ftp://127.0.0.1/search",
  "http://user@127.0.0.1:8793",
  "http://user:secret@localhost:8793",
  "http://localhost.example:8793",
  "http://localhost.:8793",
  "http://127.0.0.1.example:8793",
  "http://127.0.0.1@remote.example:8793",
  "http://2130706433:8793",
  "http://0177.0.0.1:8793",
  "http://0x7f000001:8793",
  "http://127.1:8793",
  "http://127.000.000.001:8793",
  "http://192.168.1.10:8793",
  "http://8.8.8.8:8793",
  "http://[::ffff:127.0.0.1]:8793",
  "http://[::ffff:192.168.1.10]:8793",
  "http://[fe80::1]:8793",
])("rejects an unsafe sidecar URL before sending documents: %s", async (baseUrl) => {
  const fetchFn = vi.fn<typeof fetch>();
  expect(
    await searchThreadSidecar({ query: "token", limit: 10, documents, baseUrl, fetchFn }),
  ).toBeNull();
  expect(fetchFn).not.toHaveBeenCalled();
});

it("does not follow redirects that could leave loopback", async () => {
  const fetchFn = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://remote.example" } }),
    );
  expect(
    await searchThreadSidecar({
      query: "token",
      limit: 10,
      documents,
      baseUrl: "http://127.0.0.1:8793",
      fetchFn,
    }),
  ).toBeNull();
  expect(fetchFn).toHaveBeenCalledWith(
    new URL("http://127.0.0.1:8793/v1/search"),
    expect.objectContaining({ redirect: "manual" }),
  );
});

it("fails open on transport, status, and contract errors", async () => {
  const common = { query: "token", limit: 10, documents, baseUrl: "http://127.0.0.1:8793" };
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
