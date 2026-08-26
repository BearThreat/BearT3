import { describe, expect, it } from "vite-plus/test";

import { createMemoryStorage } from "./lib/storage";
import {
  createSalvoIssueReport,
  drainSalvoIssueReportOutbox,
  queueSalvoIssueReport,
  readSalvoIssueReports,
  SALVO_ISSUE_REPORTS_STORAGE_KEY,
} from "./salvoIssueReport";

const fixed = { id: "issue_123", now: "2026-08-24T12:00:00.000Z" };

describe("Salvo issue reports", () => {
  it("omits diagnostic context by default and creates a durable operator receipt", () => {
    const storage = createMemoryStorage();
    const report = createSalvoIssueReport(
      { category: "Something is broken", message: "  Send button is stuck.  ", path: "/private" },
      fixed,
    );

    expect(report).toEqual({
      id: "issue_123",
      category: "Something is broken",
      message: "Send button is stuck.",
      includeDiagnosticContext: false,
      createdAt: fixed.now,
      status: "queued",
      operatorTarget: "site-owner",
    });
    queueSalvoIssueReport(storage, report);
    expect(readSalvoIssueReports(storage)).toEqual([report]);
  });

  it("includes only bounded diagnostics when the user opts in", () => {
    const report = createSalvoIssueReport(
      {
        category: "Agent gave a bad result",
        message: "It edited the wrong file.",
        includeDiagnosticContext: true,
        path: "/environment/thread",
        runtime: "desktop",
      },
      fixed,
    );

    expect(report.context).toEqual({ path: "/environment/thread", runtime: "desktop" });
    expect(JSON.stringify(report)).not.toContain("conversation");
  });

  it("rejects empty and oversized reports", () => {
    expect(() => createSalvoIssueReport({ category: "Other", message: "   " }, fixed)).toThrow(
      "Tell us what went wrong.",
    );
    expect(() =>
      createSalvoIssueReport({ category: "Other", message: "x".repeat(4_001) }, fixed),
    ).toThrow("Keep the report under 4,000 characters.");
  });

  it("fails closed when persisted data is invalid", () => {
    const storage = createMemoryStorage();
    storage.setItem(SALVO_ISSUE_REPORTS_STORAGE_KEY, "not json");
    expect(readSalvoIssueReports(storage)).toEqual([]);
  });

  it("marks a queued report received only after a matching server receipt", async () => {
    const storage = createMemoryStorage();
    const report = createSalvoIssueReport(
      { category: "Suggestion", message: "Add dark mode." },
      fixed,
    );
    queueSalvoIssueReport(storage, report);

    await drainSalvoIssueReportOutbox(storage, async ({ id }) => ({
      receiptId: id,
      status: "received",
    }));

    expect(readSalvoIssueReports(storage)[0]?.status).toBe("received");
  });

  it("keeps failed and mismatched deliveries queued and retries with the same receipt", async () => {
    const storage = createMemoryStorage();
    const report = createSalvoIssueReport(
      { category: "Something is broken", message: "Cannot open a thread." },
      fixed,
    );
    queueSalvoIssueReport(storage, report);
    const attemptedIds: string[] = [];

    await drainSalvoIssueReportOutbox(storage, async ({ id }) => {
      attemptedIds.push(id);
      throw new Error("offline");
    });
    await drainSalvoIssueReportOutbox(storage, async ({ id }) => {
      attemptedIds.push(id);
      return { receiptId: "wrong-receipt", status: "received" };
    });
    await drainSalvoIssueReportOutbox(storage, async ({ id }) => {
      attemptedIds.push(id);
      return { receiptId: id, status: "received" };
    });

    expect(attemptedIds).toEqual([report.id, report.id, report.id]);
    expect(readSalvoIssueReports(storage)[0]?.status).toBe("received");
  });

  it("does not redeliver a report after a server receipt", async () => {
    const storage = createMemoryStorage();
    queueSalvoIssueReport(
      storage,
      createSalvoIssueReport({ category: "Other", message: "A received report." }, fixed),
    );
    let deliveries = 0;
    const deliver = async (report: { readonly id: string }) => {
      deliveries += 1;
      return { receiptId: report.id, status: "received" as const };
    };

    await drainSalvoIssueReportOutbox(storage, deliver);
    await drainSalvoIssueReportOutbox(storage, deliver);

    expect(deliveries).toBe(1);
  });
});
