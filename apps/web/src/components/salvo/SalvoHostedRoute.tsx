import { useAuth, useClerk } from "@clerk/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import {
  createSalvoHostedOnboardingState,
  getSalvoHostedOnboardingAdapter,
  getSalvoHostedOnboardingStartupCommands,
  transitionSalvoHostedOnboarding,
  type SalvoHostedOnboardingAdapter,
  type SalvoHostedOnboardingCommand,
  type SalvoHostedSandbox,
} from "../../salvo/hostedOnboarding";
import { Button } from "../ui/button";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { SalvoHostedOnboarding } from "./SalvoHostedOnboarding";
import { SalvoIssueReporter } from "../SalvoIssueReporter";
import { SalvoOperatorInbox } from "./SalvoOperatorInbox";

export function SalvoHostedRoute({
  adapter = getSalvoHostedOnboardingAdapter(),
}: {
  readonly adapter?: SalvoHostedOnboardingAdapter;
}) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const clerk = useClerk();
  const [state, setState] = useState(createSalvoHostedOnboardingState);
  const stateRef = useRef(state);
  const sandboxRef = useRef<SalvoHostedSandbox | null>(null);
  const startedAccountRef = useRef<string | null>(null);
  const executeRef = useRef<(commands: readonly SalvoHostedOnboardingCommand[]) => void>(() => {});

  const session = useMemo(
    () =>
      userId
        ? {
            accountId: userId,
            readAccessToken: () => getToken(resolveRelayClerkTokenOptions()),
          }
        : null,
    [getToken, userId],
  );

  const execute = useCallback(
    async (commands: readonly SalvoHostedOnboardingCommand[]) => {
      if (!session) return;
      for (const command of commands) {
        if (command.type === "start-sandbox") {
          try {
            const sandbox = await adapter.startSandbox(session);
            if (startedAccountRef.current !== session.accountId) return;
            sandboxRef.current = sandbox;
            const ready = transitionSalvoHostedOnboarding(stateRef.current, {
              type: "sandbox-ready",
            });
            stateRef.current = ready.state;
            setState(ready.state);
            executeRef.current(ready.commands);
          } catch {
            if (startedAccountRef.current !== session.accountId) return;
            const failed = transitionSalvoHostedOnboarding(stateRef.current, {
              type: "sandbox-failed",
            });
            stateRef.current = failed.state;
            setState(failed.state);
          }
          continue;
        }

        const sandbox = sandboxRef.current;
        if (!sandbox) {
          const failed = transitionSalvoHostedOnboarding(stateRef.current, {
            type: "sandbox-failed",
          });
          stateRef.current = failed.state;
          setState(failed.state);
          continue;
        }
        try {
          await adapter.sendPrompt({ session, sandbox, prompt: command.prompt });
        } catch {
          if (startedAccountRef.current !== session.accountId) return;
          const failed = transitionSalvoHostedOnboarding(stateRef.current, {
            type: "sandbox-failed",
          });
          stateRef.current = failed.state;
          setState(failed.state);
        }
      }
    },
    [adapter, session],
  );

  executeRef.current = (commands) => {
    void execute(commands);
  };

  useEffect(() => {
    if (!session) {
      startedAccountRef.current = null;
      sandboxRef.current = null;
      return;
    }
    if (startedAccountRef.current === session.accountId) return;
    startedAccountRef.current = session.accountId;
    sandboxRef.current = null;
    const initial = createSalvoHostedOnboardingState();
    stateRef.current = initial;
    setState(initial);
    void execute(getSalvoHostedOnboardingStartupCommands());
  }, [execute, session]);

  if (!isLoaded) return null;
  if (!isSignedIn || !session) {
    return (
      <>
        <main className="flex min-h-dvh items-center justify-center bg-background px-4">
          <section className="space-y-5 text-center">
            <p className="text-sm font-medium text-primary">Salvo</p>
            <h1 className="text-3xl font-semibold tracking-tight">
              Your agent, ready on your phone.
            </h1>
            <Button
              onClick={() => clerk.openSignIn(resolveClerkSignInProps(window.location.href, false))}
            >
              Continue
            </Button>
          </section>
        </main>
        <SalvoIssueReporter />
        <SalvoOperatorInbox />
      </>
    );
  }

  const apply = (event: Parameters<typeof transitionSalvoHostedOnboarding>[1]) => {
    const transition = transitionSalvoHostedOnboarding(stateRef.current, event);
    stateRef.current = transition.state;
    setState(transition.state);
    executeRef.current(transition.commands);
  };

  return (
    <>
      <SalvoHostedOnboarding
        state={state}
        onDraftChange={(draft) => apply({ type: "draft-changed", draft })}
        onSubmit={() => apply({ type: "prompt-submitted" })}
        onRetry={() => apply({ type: "retry-requested" })}
      />
      <SalvoIssueReporter />
      <SalvoOperatorInbox />
    </>
  );
}
