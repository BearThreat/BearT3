import type {
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionRecovery,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
} from "../Errors.ts";

export interface ProviderRuntimeBinding {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  /**
   * Routing key for the configured provider instance that owns this
   * session. The persistence layer promotes legacy null rows before
   * exposing bindings; runtime callers must not infer this from `provider`.
   */
  readonly providerInstanceId?: ProviderInstanceId;
  readonly adapterKey?: string;
  readonly status?: ProviderSessionRuntimeStatus;
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: unknown | null;
  readonly runtimeMode?: RuntimeMode;
}

export interface ProviderRuntimeBindingWithMetadata extends ProviderRuntimeBinding {
  readonly lastSeenAt: string;
}

export interface ProviderRuntimeCandidateBinding {
  readonly threadId: ThreadId;
  readonly recoveryId: string;
  readonly recovery: ProviderSessionRecovery;
  readonly resumeCursor: unknown | null;
  readonly runtimePayload: unknown | null;
  readonly status: "staged" | "dispatch-committed" | "turn-started";
  readonly turnId: string | null;
  readonly updatedAt: string;
}

export interface StageProviderRuntimeCandidateInput {
  readonly threadId: ThreadId;
  readonly recoveryId: string;
  readonly recovery: ProviderSessionRecovery;
  readonly resumeCursor: unknown | null;
  readonly runtimePayload: unknown | null;
}

export interface ProviderRuntimeCandidateKey {
  readonly threadId: ThreadId;
  readonly recoveryId: string;
}

export type ProviderSessionDirectoryReadError = ProviderSessionDirectoryPersistenceError;

export type ProviderSessionDirectoryWriteError =
  | ProviderValidationError
  | ProviderSessionDirectoryPersistenceError;

export interface ProviderSessionDirectoryShape {
  readonly upsert: (
    binding: ProviderRuntimeBinding,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;

  readonly getProvider: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderDriverKind, ProviderSessionDirectoryReadError>;

  readonly getBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProviderRuntimeBinding>, ProviderSessionDirectoryReadError>;

  readonly listThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProviderSessionDirectoryPersistenceError
  >;

  readonly listBindings: () => Effect.Effect<
    ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
    ProviderSessionDirectoryPersistenceError
  >;

  readonly stageCandidate: (
    input: StageProviderRuntimeCandidateInput,
  ) => Effect.Effect<boolean, ProviderSessionDirectoryPersistenceError>;

  readonly getCandidate: (
    input: ProviderRuntimeCandidateKey,
  ) => Effect.Effect<
    Option.Option<ProviderRuntimeCandidateBinding>,
    ProviderSessionDirectoryPersistenceError
  >;
  readonly listCandidates: () => Effect.Effect<
    ReadonlyArray<ProviderRuntimeCandidateBinding>,
    ProviderSessionDirectoryPersistenceError
  >;

  readonly markCandidateDispatchCommitted: (
    input: ProviderRuntimeCandidateKey,
  ) => Effect.Effect<boolean, ProviderSessionDirectoryPersistenceError>;

  readonly markCandidateTurnStarted: (
    input: ProviderRuntimeCandidateKey & { readonly turnId: string },
  ) => Effect.Effect<boolean, ProviderSessionDirectoryPersistenceError>;

  readonly promoteCandidate: (
    input: ProviderRuntimeCandidateKey,
  ) => Effect.Effect<boolean, ProviderSessionDirectoryPersistenceError>;

  readonly rollbackCandidate: (
    input: ProviderRuntimeCandidateKey,
  ) => Effect.Effect<boolean, ProviderSessionDirectoryPersistenceError>;
}

export class ProviderSessionDirectory extends Context.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("t3/provider/Services/ProviderSessionDirectory") {}
