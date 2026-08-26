import { useAuth } from "@clerk/react";
import type { RelayOperatorSupportIssueRecord } from "@t3tools/contracts/relay";
import { InboxIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import {
  listRelayOperatorSupportIssues,
  replyToRelayOperatorSupportIssue,
} from "../../cloud/supportIssues";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";

export function SalvoOperatorInbox() {
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const [issues, setIssues] = useState<readonly RelayOperatorSupportIssueRecord[] | null>(null);
  const [reply, setReply] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const token = await getToken(resolveRelayClerkTokenOptions());
      if (!token) return;
      setIssues(await listRelayOperatorSupportIssues(token));
    } catch {
      // A missing allowlist entry is expected. Fail closed and expose no operator UI.
      setIssues(null);
    }
  }, [getToken, isSignedIn]);

  useEffect(() => void load(), [load]);
  if (issues === null) return null;

  return (
    <Dialog>
      <DialogTrigger
        aria-label="Open Salvo issue inbox"
        className="fixed bottom-4 left-4 z-40"
        render={<Button size="sm" variant="outline" />}
      >
        <InboxIcon /> Issues ({issues.length})
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Salvo issue inbox</DialogTitle>
          <DialogDescription>
            Reply to reports submitted through the hosted Salvo experience.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[65vh] space-y-4 overflow-y-auto">
          {issues.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reports.</p>
          ) : null}
          {issues.map(({ userId, issue }) => (
            <article
              className="space-y-2 rounded-lg border p-3"
              key={`${userId}:${issue.receiptId}`}
            >
              <div>
                <p className="font-medium">{issue.subject}</p>
                <p className="whitespace-pre-wrap text-sm">{issue.description}</p>
                <p className="text-xs text-muted-foreground">
                  {issue.receiptId} · {issue.status}
                </p>
              </div>
              <Textarea
                aria-label={`Reply to ${issue.receiptId}`}
                maxLength={10_000}
                onChange={(event) =>
                  setReply((current) => ({ ...current, [issue.receiptId]: event.target.value }))
                }
                placeholder="Write a reply"
                value={reply[issue.receiptId] ?? ""}
              />
              <Button
                size="sm"
                disabled={!reply[issue.receiptId]?.trim()}
                onClick={async () => {
                  const token = await getToken(resolveRelayClerkTokenOptions());
                  if (!token) return;
                  await replyToRelayOperatorSupportIssue({
                    clerkToken: token,
                    payload: {
                      userId,
                      receiptId: issue.receiptId,
                      status: "resolved",
                      reply: reply[issue.receiptId]!.trim(),
                    },
                  });
                  setReply((current) => ({ ...current, [issue.receiptId]: "" }));
                  await load();
                }}
              >
                Reply and resolve
              </Button>
            </article>
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
