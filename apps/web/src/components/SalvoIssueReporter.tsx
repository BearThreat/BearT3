import { useAuth } from "@clerk/react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CircleCheckIcon, MessageCircleWarningIcon } from "lucide-react";

import {
  createSalvoIssueReport,
  drainSalvoIssueReportOutbox,
  queueSalvoIssueReport,
  readSalvoIssueReports,
  SALVO_ISSUE_CATEGORIES,
  type SalvoIssueCategory,
} from "../salvoIssueReport";
import { resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { deliverRelaySupportIssue } from "../cloud/supportIssues";
import { isElectron } from "../env";
import { randomUUID } from "../lib/utils";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

function makeReceiptId(): string {
  return `issue_${randomUUID()}`;
}

export function SalvoIssueReporter() {
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<SalvoIssueCategory>("Something is broken");
  const [message, setMessage] = useState("");
  const [includeContext, setIncludeContext] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [delivered, setDelivered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deliverQueuedReports = useCallback(async () => {
    if (!isSignedIn) return;
    let clerkToken: string | null = null;
    try {
      clerkToken = await getToken(resolveRelayClerkTokenOptions());
    } catch {
      return;
    }
    if (!clerkToken) return;
    await drainSalvoIssueReportOutbox(window.localStorage, async (report) => {
      const receipt = await deliverRelaySupportIssue({
        clerkToken,
        payload: {
          receiptId: report.id,
          subject: report.category,
          description: report.message,
          diagnosticsConsent: report.includeDiagnosticContext,
          ...(report.includeDiagnosticContext && report.context
            ? {
                diagnostics: {
                  route: report.context.path,
                  platform: report.context.runtime,
                },
              }
            : {}),
        },
      });
      return { receiptId: receipt.receiptId, status: receipt.status };
    });
  }, [getToken, isSignedIn]);

  useEffect(() => {
    const retry = () => void deliverQueuedReports();
    retry();
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [deliverQueuedReports]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const report = createSalvoIssueReport(
        {
          category,
          message,
          includeDiagnosticContext: includeContext,
          path: window.location.pathname,
          runtime: isElectron ? "desktop" : "web",
        },
        { id: makeReceiptId(), now: new Date().toISOString() },
      );
      queueSalvoIssueReport(window.localStorage, report);
      await deliverQueuedReports();
      const saved = readSalvoIssueReports(window.localStorage).find(({ id }) => id === report.id);
      setReceiptId(report.id);
      setDelivered(saved?.status !== "queued");
      setMessage("");
      setIncludeContext(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the report.");
    }
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setReceiptId(null);
          setDelivered(false);
          setError(null);
        }
      }}
      open={open}
    >
      <DialogTrigger
        aria-label="Report a problem"
        className="fixed bottom-4 right-4 z-40"
        render={<Button size="sm" variant="outline" />}
      >
        <MessageCircleWarningIcon />
        Report a problem
      </DialogTrigger>
      <DialogPopup>
        {receiptId ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CircleCheckIcon className="text-success" />{" "}
                {delivered ? "Report received" : "Report saved"}
              </DialogTitle>
              <DialogDescription>
                {delivered
                  ? `Barrett received your report. Receipt: ${receiptId}`
                  : `Your report is saved on this device and will retry when Salvo reconnects. Receipt: ${receiptId}`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Report a problem</DialogTitle>
              <DialogDescription>
                Send this directly to Barrett. Salvo saves a receipt so the report is not lost.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="salvo-issue-category">What happened?</Label>
                <select
                  className="min-h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  id="salvo-issue-category"
                  onChange={(event) => setCategory(event.target.value as SalvoIssueCategory)}
                  value={category}
                >
                  {SALVO_ISSUE_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="salvo-issue-message">What should Barrett know?</Label>
                <Textarea
                  id="salvo-issue-message"
                  maxLength={4_000}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Tell me what you expected and what happened."
                  required
                  value={message}
                />
              </div>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <Checkbox
                  checked={includeContext}
                  onCheckedChange={(checked) => setIncludeContext(checked === true)}
                />
                <span>
                  Include basic diagnostics
                  <span className="block text-muted-foreground">
                    Adds this screen and app type. It never includes chats, prompts, or files.
                  </span>
                </span>
              </label>
              {error && (
                <p className="text-destructive text-sm" role="alert">
                  {error}
                </p>
              )}
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Send report</Button>
            </DialogFooter>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  );
}
