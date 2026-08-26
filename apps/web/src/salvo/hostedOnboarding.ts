export type SalvoSandboxState =
  | { status: "starting" }
  | { status: "ready" }
  | { status: "error"; message?: string };

export interface SalvoHostedOnboardingState {
  draft: string;
  queuedPrompt: string | null;
  sandbox: SalvoSandboxState;
}

export type SalvoHostedOnboardingEvent =
  | { type: "draft-changed"; draft: string }
  | { type: "prompt-submitted" }
  | { type: "sandbox-ready" }
  | { type: "sandbox-failed"; message?: string }
  | { type: "retry-requested" };

export type SalvoHostedOnboardingCommand =
  | { type: "start-sandbox" }
  | { type: "send-prompt"; prompt: string };

export interface SalvoHostedOnboardingTransition {
  state: SalvoHostedOnboardingState;
  commands: SalvoHostedOnboardingCommand[];
}

export interface SalvoHostedSession {
  readonly accountId: string;
  readonly readAccessToken: () => Promise<string | null>;
}

export interface SalvoHostedSandbox {
  readonly sandboxId: string;
}

/**
 * Transport boundary for the hosted Salvo control plane. The web client owns
 * onboarding state, while deployment code supplies the authenticated sandbox
 * implementation. Keeping this interface transport-neutral prevents the
 * public/local T3 flows from acquiring a speculative provisioning endpoint.
 */
export interface SalvoHostedOnboardingAdapter {
  startSandbox: (session: SalvoHostedSession) => Promise<SalvoHostedSandbox>;
  sendPrompt: (input: {
    readonly session: SalvoHostedSession;
    readonly sandbox: SalvoHostedSandbox;
    readonly prompt: string;
  }) => Promise<void>;
}

export const unavailableSalvoHostedOnboardingAdapter: SalvoHostedOnboardingAdapter = {
  startSandbox: () => Promise.reject(new Error("Salvo hosted provisioning is unavailable.")),
  sendPrompt: () => Promise.reject(new Error("Salvo hosted provisioning is unavailable.")),
};

let hostedAdapter: SalvoHostedOnboardingAdapter = unavailableSalvoHostedOnboardingAdapter;

export function installSalvoHostedOnboardingAdapter(
  adapter: SalvoHostedOnboardingAdapter,
): () => void {
  hostedAdapter = adapter;
  return () => {
    if (hostedAdapter === adapter) hostedAdapter = unavailableSalvoHostedOnboardingAdapter;
  };
}

export function getSalvoHostedOnboardingAdapter(): SalvoHostedOnboardingAdapter {
  return hostedAdapter;
}

export function createSalvoHostedOnboardingState(): SalvoHostedOnboardingState {
  return {
    draft: "",
    queuedPrompt: null,
    sandbox: { status: "starting" },
  };
}

export function getSalvoHostedOnboardingStartupCommands(): SalvoHostedOnboardingCommand[] {
  return [{ type: "start-sandbox" }];
}

export function transitionSalvoHostedOnboarding(
  state: SalvoHostedOnboardingState,
  event: SalvoHostedOnboardingEvent,
): SalvoHostedOnboardingTransition {
  switch (event.type) {
    case "draft-changed":
      return { state: { ...state, draft: event.draft }, commands: [] };

    case "prompt-submitted": {
      const prompt = state.draft.trim();
      if (prompt.length === 0) return { state, commands: [] };
      if (state.queuedPrompt !== null) return { state, commands: [] };
      if (state.sandbox.status === "ready") {
        return {
          state: { ...state, draft: "" },
          commands: [{ type: "send-prompt", prompt }],
        };
      }
      if (state.sandbox.status === "starting") {
        return {
          state: { ...state, draft: "", queuedPrompt: prompt },
          commands: [],
        };
      }
      return { state, commands: [] };
    }

    case "sandbox-ready": {
      const commands: SalvoHostedOnboardingCommand[] = state.queuedPrompt
        ? [{ type: "send-prompt", prompt: state.queuedPrompt }]
        : [];
      return {
        state: { ...state, queuedPrompt: null, sandbox: { status: "ready" } },
        commands,
      };
    }

    case "sandbox-failed":
      return {
        state: {
          ...state,
          sandbox: {
            status: "error",
            ...(event.message === undefined ? {} : { message: event.message }),
          },
        },
        commands: [],
      };

    case "retry-requested":
      return {
        state: { ...state, sandbox: { status: "starting" } },
        commands: [{ type: "start-sandbox" }],
      };
  }
}
