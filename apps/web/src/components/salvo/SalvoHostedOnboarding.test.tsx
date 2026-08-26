import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { createSalvoHostedOnboardingState } from "../../salvo/hostedOnboarding";
import { SalvoHostedOnboarding } from "./SalvoHostedOnboarding";

const callbacks = {
  onDraftChange: () => {},
  onRetry: () => {},
  onSubmit: () => {},
};

function render(state = createSalvoHostedOnboardingState()) {
  return renderToStaticMarkup(<SalvoHostedOnboarding state={state} {...callbacks} />);
}

describe("SalvoHostedOnboarding", () => {
  it("lets a new family user write a prompt while Salvo starts", () => {
    const markup = render();

    expect(markup).toContain('data-salvo-onboarding="starting"');
    expect(markup).toContain("What can I help with?");
    expect(markup).toContain("Starting Salvo… You can send now.");
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).not.toContain("AWS");
    expect(markup).not.toContain("sandbox");
  });

  it("confirms that a submitted message is safe while startup finishes", () => {
    const markup = render({
      ...createSalvoHostedOnboardingState(),
      queuedPrompt: "Help me plan dinner",
    });

    expect(markup).toContain("Message saved. Starting Salvo…");
    expect(markup).toContain("disabled");
  });

  it("offers one recovery action without exposing infrastructure details", () => {
    const markup = render({
      ...createSalvoHostedOnboardingState(),
      queuedPrompt: "Help me plan dinner",
      sandbox: { status: "error", message: "instance launch failed" },
    });

    expect(markup).toContain("Salvo couldn&#x27;t start. Your message is safe.");
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("instance launch failed");
  });

  it("does not claim a message was saved when none was submitted", () => {
    const markup = render({
      ...createSalvoHostedOnboardingState(),
      sandbox: { status: "error" },
    });

    expect(markup).toContain("Salvo couldn&#x27;t start.");
    expect(markup).not.toContain("Your message is safe.");
  });
});
