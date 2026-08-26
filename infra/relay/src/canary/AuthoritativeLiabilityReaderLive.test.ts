// @effect-diagnostics globalDate:off -- Fixed Date inputs make signing and freshness tests deterministic.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeAuthoritativeLiabilityReader,
  signCostExplorerRequest,
} from "./AuthoritativeLiabilityReaderLive.ts";

const credentials = {
  accessKeyId: "ASIATEST",
  secretAccessKey: "secret",
  sessionToken: "session",
  expiresAt: "2026-08-26T12:00:00Z",
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("AuthoritativeLiabilityReaderLive", () => {
  it.effect("reads scoped OpenAI costs and AWS Cost Explorer through injected fetch", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; init?: RequestInit }> = [];
      const reader = makeAuthoritativeLiabilityReader(
        { openAiAdminKey: "admin", openAiProjectId: "proj_canary", awsCredentials: credentials },
        {
          now: () => new Date("2026-08-26T04:00:00Z"),
          fetch: async (input, init) => {
            const url = String(input);
            seen.push(init ? { url, init } : { url });
            return url.includes("api.openai.com")
              ? response({
                  data: [
                    {
                      start_time: 1,
                      end_time: 2,
                      results: [{ amount: { value: "1.250001", currency: "usd" } }],
                    },
                  ],
                  has_more: false,
                  next_page: null,
                })
              : response({
                  ResultsByTime: [
                    {
                      TimePeriod: { Start: "2026-08-01", End: "2026-08-02" },
                      Total: { UnblendedCost: { Amount: "2.5", Unit: "USD" } },
                    },
                  ],
                });
          },
        },
      );
      const readings = yield* reader.read();
      expect(readings).toEqual([
        {
          provider: "aws",
          billedMicros: 2_500_000,
          observedAtMs: Date.parse("2026-08-26T04:00:00Z"),
          source: "aws-cost-explorer:GetCostAndUsage:account",
        },
        {
          provider: "openai",
          billedMicros: 1_250_001,
          observedAtMs: Date.parse("2026-08-26T04:00:00Z"),
          source: "openai-organization-costs:project:proj_canary",
        },
      ]);
      const openAi = seen.find((entry) => entry.url.includes("api.openai.com"))!;
      expect(openAi.url).toContain("project_ids%5B%5D=proj_canary");
      expect((openAi.init?.headers as Record<string, string>).authorization).toBe("Bearer admin");
      const aws = seen.find((entry) => entry.url.includes("ce.us-east-1.amazonaws.com"))!;
      expect((aws.init?.headers as Record<string, string>)["x-amz-target"]).toBe(
        "AWSInsightsIndexService.GetCostAndUsage",
      );
      expect(String(aws.init?.body)).toContain('"UnblendedCost"');
    }),
  );

  it.effect("fails closed on malformed provider responses", () =>
    Effect.gen(function* () {
      const reader = makeAuthoritativeLiabilityReader(
        { openAiAdminKey: "admin", openAiProjectId: "proj", awsCredentials: credentials },
        {
          now: () => new Date("2026-08-26T04:00:00Z"),
          fetch: async (input) =>
            String(input).includes("api.openai.com")
              ? response({ data: "invalid" })
              : response({ ResultsByTime: [] }),
        },
      );
      const error = yield* Effect.flip(reader.read());
      expect(error.code).toBe("authoritative_unavailable");
    }),
  );

  it("signs Cost Explorer with the fixed billing endpoint and temporary-session headers", async () => {
    const signed = await signCostExplorerRequest({
      credentials,
      body: "{}",
      now: new Date("2026-08-26T04:00:00Z"),
    });
    expect(signed.endpoint).toBe("https://ce.us-east-1.amazonaws.com/");
    expect(signed.headers.authorization).toContain("/us-east-1/ce/aws4_request");
    expect(signed.headers["x-amz-security-token"]).toBe("session");
  });
});
