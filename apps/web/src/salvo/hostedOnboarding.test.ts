import { describe, expect, it } from "vite-plus/test";

import {
  createSalvoHostedOnboardingState,
  getSalvoHostedOnboardingAdapter,
  getSalvoHostedOnboardingStartupCommands,
  transitionSalvoHostedOnboarding,
  installSalvoHostedOnboardingAdapter,
  unavailableSalvoHostedOnboardingAdapter,
} from "./hostedOnboarding";

describe("Salvo hosted onboarding", () => {
  it("starts the sandbox as soon as the authenticated experience mounts", () => {
    expect(createSalvoHostedOnboardingState().sandbox).toEqual({ status: "starting" });
    expect(getSalvoHostedOnboardingStartupCommands()).toEqual([{ type: "start-sandbox" }]);
  });

  it("accepts and queues the first prompt while the sandbox starts", () => {
    const initial = createSalvoHostedOnboardingState();
    const drafted = transitionSalvoHostedOnboarding(initial, {
      type: "draft-changed",
      draft: "  Help me organize these photos.  ",
    }).state;
    const submitted = transitionSalvoHostedOnboarding(drafted, { type: "prompt-submitted" });

    expect(submitted.state.draft).toBe("");
    expect(submitted.state.queuedPrompt).toBe("Help me organize these photos.");
    expect(submitted.commands).toEqual([]);

    const ready = transitionSalvoHostedOnboarding(submitted.state, { type: "sandbox-ready" });
    expect(ready.state.queuedPrompt).toBeNull();
    expect(ready.commands).toEqual([
      { type: "send-prompt", prompt: "Help me organize these photos." },
    ]);
  });

  it("sends immediately once the sandbox is ready", () => {
    const state = {
      ...createSalvoHostedOnboardingState(),
      draft: "Write a birthday card",
      sandbox: { status: "ready" as const },
    };
    const result = transitionSalvoHostedOnboarding(state, { type: "prompt-submitted" });

    expect(result.state.draft).toBe("");
    expect(result.commands).toEqual([{ type: "send-prompt", prompt: "Write a birthday card" }]);
  });

  it("preserves a queued prompt across failure and retry", () => {
    const state = {
      ...createSalvoHostedOnboardingState(),
      queuedPrompt: "Find the best flight",
    };
    const failed = transitionSalvoHostedOnboarding(state, {
      type: "sandbox-failed",
      message: "Startup timed out",
    });
    const retried = transitionSalvoHostedOnboarding(failed.state, { type: "retry-requested" });

    expect(retried.state.queuedPrompt).toBe("Find the best flight");
    expect(retried.state.sandbox).toEqual({ status: "starting" });
    expect(retried.commands).toEqual([{ type: "start-sandbox" }]);
  });

  it("does not send empty prompts or replace a queued first prompt", () => {
    const empty = transitionSalvoHostedOnboarding(createSalvoHostedOnboardingState(), {
      type: "prompt-submitted",
    });
    expect(empty.commands).toEqual([]);

    const alreadyQueued = {
      ...createSalvoHostedOnboardingState(),
      draft: "Second prompt",
      queuedPrompt: "First prompt",
    };
    const result = transitionSalvoHostedOnboarding(alreadyQueued, { type: "prompt-submitted" });
    expect(result.state.queuedPrompt).toBe("First prompt");
  });
});

describe("Salvo hosted adapter boundary", () => {
  it("is fail-closed until deployment code installs an adapter", async () => {
    expect(getSalvoHostedOnboardingAdapter()).toBe(unavailableSalvoHostedOnboardingAdapter);
    await expect(
      getSalvoHostedOnboardingAdapter().startSandbox({
        accountId: "family-user",
        readAccessToken: () => Promise.resolve("token"),
      }),
    ).rejects.toThrow("unavailable");
  });

  it("restores the fail-closed adapter when an installation is removed", () => {
    const adapter = {
      startSandbox: async () => ({ sandboxId: "sandbox-1" }),
      sendPrompt: async () => {},
    };
    const uninstall = installSalvoHostedOnboardingAdapter(adapter);
    expect(getSalvoHostedOnboardingAdapter()).toBe(adapter);

    uninstall();
    expect(getSalvoHostedOnboardingAdapter()).toBe(unavailableSalvoHostedOnboardingAdapter);
  });
});
