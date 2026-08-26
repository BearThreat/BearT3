import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  deliverRelaySupportIssue,
  listRelayOperatorSupportIssues,
  replyToRelayOperatorSupportIssue,
} from "./supportIssues";

const record = {
  receiptId: "issue_123",
  subject: "Something is broken",
  description: "Send is stuck.",
  diagnosticsConsent: false,
  diagnostics: null,
  status: "received" as const,
  operatorReply: null,
  repliedAt: null,
  createdAt: "2026-08-24T12:00:00.000Z",
  updatedAt: "2026-08-24T12:00:00.000Z",
};

afterEach(() => vi.unstubAllEnvs());

describe("relay support issue delivery", () => {
  it("returns an existing receipt without posting a duplicate", async () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    const relayFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ issues: [record] }));

    await expect(
      deliverRelaySupportIssue(
        {
          clerkToken: "private-token",
          payload: {
            receiptId: record.receiptId,
            subject: record.subject,
            description: record.description,
            diagnosticsConsent: false,
          },
        },
        relayFetch,
      ),
    ).resolves.toEqual(record);

    expect(relayFetch).toHaveBeenCalledTimes(1);
    expect(relayFetch.mock.calls[0]?.[1]).toEqual({
      headers: { authorization: "Bearer private-token" },
    });
  });

  it("posts the same receipt and omits diagnostics without consent", async () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    const relayFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ issues: [] }))
      .mockResolvedValueOnce(Response.json(record));

    await deliverRelaySupportIssue(
      {
        clerkToken: "private-token",
        payload: {
          receiptId: record.receiptId,
          subject: record.subject,
          description: record.description,
          diagnosticsConsent: false,
        },
      },
      relayFetch,
    );

    const request = relayFetch.mock.calls[1]?.[1];
    expect(request?.method).toBe("POST");
    expect(JSON.parse(String(request?.body))).toEqual({
      receiptId: record.receiptId,
      subject: record.subject,
      description: record.description,
      diagnosticsConsent: false,
    });
  });

  it("uses authenticated operator-only endpoints for inbox and replies", async () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    const operatorIssue = { userId: "family-user", issue: record };
    const relayFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ issues: [operatorIssue] }))
      .mockResolvedValueOnce(Response.json(operatorIssue));

    await expect(listRelayOperatorSupportIssues("operator-token", relayFetch)).resolves.toEqual([
      operatorIssue,
    ]);
    await expect(
      replyToRelayOperatorSupportIssue(
        {
          clerkToken: "operator-token",
          payload: {
            userId: "family-user",
            receiptId: record.receiptId,
            status: "resolved",
            reply: "Fixed. Please try again.",
          },
        },
        relayFetch,
      ),
    ).resolves.toEqual(operatorIssue);

    expect(new URL(String(relayFetch.mock.calls[0]?.[0])).pathname).toBe(
      "/v1/operator/support-issues",
    );
    expect(new URL(String(relayFetch.mock.calls[1]?.[0])).pathname).toBe(
      "/v1/operator/support-issues/reply",
    );
    expect(relayFetch.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
    });
  });
});
