import type { StateStorage } from "./lib/storage";

export const SALVO_ISSUE_REPORTS_STORAGE_KEY = "salvo.issue-reports.v1";

export const SALVO_ISSUE_CATEGORIES = [
  "Something is broken",
  "Agent gave a bad result",
  "Account or access",
  "Suggestion",
  "Other",
] as const;

export type SalvoIssueCategory = (typeof SALVO_ISSUE_CATEGORIES)[number];
export type SalvoIssueStatus = "queued" | "received" | "reviewing" | "resolved" | "closed";

export interface SalvoIssueReport {
  readonly id: string;
  readonly category: SalvoIssueCategory;
  readonly message: string;
  readonly includeDiagnosticContext: boolean;
  readonly context?: {
    readonly path: string;
    readonly runtime: "web" | "desktop";
  };
  readonly createdAt: string;
  readonly status: SalvoIssueStatus;
  readonly operatorTarget: "site-owner";
}

export interface CreateSalvoIssueReportInput {
  readonly category: SalvoIssueCategory;
  readonly message: string;
  readonly includeDiagnosticContext?: boolean;
  readonly path?: string;
  readonly runtime?: "web" | "desktop";
}

function isIssueReport(value: unknown): value is SalvoIssueReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<SalvoIssueReport>;
  return (
    typeof report.id === "string" &&
    SALVO_ISSUE_CATEGORIES.includes(report.category as SalvoIssueCategory) &&
    typeof report.message === "string" &&
    typeof report.createdAt === "string" &&
    report.operatorTarget === "site-owner" &&
    ["queued", "received", "reviewing", "resolved", "closed"].includes(report.status ?? "")
  );
}

export function readSalvoIssueReports(storage: StateStorage): SalvoIssueReport[] {
  const raw = storage.getItem(SALVO_ISSUE_REPORTS_STORAGE_KEY);
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isIssueReport) : [];
  } catch {
    return [];
  }
}

export function createSalvoIssueReport(
  input: CreateSalvoIssueReportInput,
  options: { readonly id: string; readonly now: string },
): SalvoIssueReport {
  const message = input.message.trim();
  if (!message) throw new Error("Tell us what went wrong.");
  if (message.length > 4_000) throw new Error("Keep the report under 4,000 characters.");

  const includeDiagnosticContext = input.includeDiagnosticContext === true;
  return {
    id: options.id,
    category: input.category,
    message,
    includeDiagnosticContext,
    ...(includeDiagnosticContext
      ? {
          context: {
            path: input.path ?? "/",
            runtime: input.runtime ?? "web",
          },
        }
      : {}),
    createdAt: options.now,
    status: "queued",
    operatorTarget: "site-owner",
  };
}

export function queueSalvoIssueReport(
  storage: StateStorage,
  report: SalvoIssueReport,
): SalvoIssueReport[] {
  const reports = [...readSalvoIssueReports(storage), report];
  storage.setItem(SALVO_ISSUE_REPORTS_STORAGE_KEY, JSON.stringify(reports));
  return reports;
}

export interface SalvoIssueDeliveryReceipt {
  readonly receiptId: string;
  readonly status: Exclude<SalvoIssueStatus, "queued">;
}

export type DeliverSalvoIssueReport = (
  report: SalvoIssueReport,
) => Promise<SalvoIssueDeliveryReceipt>;

function writeSalvoIssueReports(storage: StateStorage, reports: readonly SalvoIssueReport[]): void {
  storage.setItem(SALVO_ISSUE_REPORTS_STORAGE_KEY, JSON.stringify(reports));
}

export async function drainSalvoIssueReportOutbox(
  storage: StateStorage,
  deliver: DeliverSalvoIssueReport,
): Promise<SalvoIssueReport[]> {
  let reports = readSalvoIssueReports(storage);
  for (const report of reports) {
    if (report.status !== "queued") continue;
    try {
      const receipt = await deliver(report);
      if (receipt.receiptId !== report.id) continue;
      reports = reports.map((candidate) =>
        candidate.id === report.id ? { ...candidate, status: receipt.status } : candidate,
      );
      writeSalvoIssueReports(storage, reports);
    } catch {
      // The durable queued record is the retry mechanism. A network failure is not delivery.
    }
  }
  return reports;
}
