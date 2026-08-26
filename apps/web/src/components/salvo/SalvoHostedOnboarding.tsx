import { AlertCircleIcon, ArrowUpIcon, LoaderCircleIcon, RotateCwIcon } from "lucide-react";
import type { FormEvent } from "react";

import type { SalvoHostedOnboardingState } from "../../salvo/hostedOnboarding";
import { Button } from "../ui/button";

export interface SalvoHostedOnboardingProps {
  state: SalvoHostedOnboardingState;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  onRetry: () => void;
}

export function SalvoHostedOnboarding({
  state,
  onDraftChange,
  onSubmit,
  onRetry,
}: SalvoHostedOnboardingProps) {
  const isStarting = state.sandbox.status === "starting";
  const hasQueuedPrompt = state.queuedPrompt !== null;
  const hasError = state.sandbox.status === "error";

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <main
      className="flex min-h-full items-center justify-center bg-background px-4 py-10"
      data-salvo-onboarding={state.sandbox.status}
    >
      <section className="w-full max-w-2xl space-y-6" aria-labelledby="salvo-welcome-title">
        <div className="space-y-2 text-center">
          <p className="text-sm font-medium text-primary">Salvo</p>
          <h1 id="salvo-welcome-title" className="text-3xl font-semibold tracking-tight">
            What can I help with?
          </h1>
          <p className="text-muted-foreground">Ask normally. Salvo can handle the setup.</p>
        </div>

        <form className="rounded-2xl border bg-card p-3 shadow-sm" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="salvo-first-prompt">
            Ask Salvo
          </label>
          <textarea
            id="salvo-first-prompt"
            className="min-h-28 w-full resize-none bg-transparent px-2 py-2 text-base outline-none placeholder:text-muted-foreground"
            value={state.draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="What would you like to get done?"
            disabled={hasQueuedPrompt}
            autoFocus
          />
          <div className="flex items-center justify-between gap-3 px-1">
            <SandboxStatus state={state} />
            {hasError ? (
              <Button size="lg" type="button" onClick={onRetry}>
                <RotateCwIcon />
                Try again
              </Button>
            ) : (
              <Button
                size="icon-xl"
                type="submit"
                aria-label="Send message"
                disabled={state.draft.trim().length === 0 || hasQueuedPrompt}
              >
                <ArrowUpIcon />
              </Button>
            )}
          </div>
        </form>
      </section>
    </main>
  );
}

function SandboxStatus({ state }: { state: SalvoHostedOnboardingState }) {
  if (state.sandbox.status === "error") {
    return (
      <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
        <AlertCircleIcon className="size-4" />
        {state.queuedPrompt
          ? "Salvo couldn't start. Your message is safe."
          : "Salvo couldn't start."}
      </p>
    );
  }

  if (state.queuedPrompt) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />
        Message saved. Starting Salvo…
      </p>
    );
  }

  if (state.sandbox.status === "starting") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />
        Starting Salvo… You can send now.
      </p>
    );
  }

  return <p className="text-sm text-muted-foreground">Ready</p>;
}
