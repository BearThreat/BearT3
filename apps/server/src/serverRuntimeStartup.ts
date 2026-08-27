import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationReactor from "./orchestration/Services/OrchestrationReactor.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import { forkParked } from "./serverActivation.ts";
import {
  automaticRecoveryDelayMs,
  descriptorFromReconciledOrphan,
  interruptedTurnForAutomaticRecovery,
  isEligibleAfterOrphanReconciliation,
  recoveryCommandKey,
  recoveryMessageId,
  THREAD_RECOVERY_PROMPT,
  type ThreadRecoveryDescriptor,
  type ThreadRecoveryPolicy,
} from "./orchestration/ThreadRecoverySupervisor.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import {
  formatHeadlessServeOutput,
  formatHostForUrl,
  isWildcardHost,
  issueHeadlessServeAccessInfo,
} from "./startupAccess.ts";

export class ServerRuntimeStartupError extends Schema.TaggedErrorClass<ServerRuntimeStartupError>()(
  "ServerRuntimeStartupError",
  {
    mode: ServerConfig.RuntimeMode,
    host: Schema.NullOr(Schema.String),
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Server runtime startup failed before command readiness.";
  }
}

export class ServerRuntimeStartup extends Context.Service<
  ServerRuntimeStartup,
  {
    readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
    readonly markHttpListening: Effect.Effect<void>;
    readonly enqueueCommand: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
  }
>()("t3/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandQueue = yield* Queue.unbounded<QueuedCommand>();
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const commandWorker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap((command) => command.run)),
  );
  yield* Effect.forkScoped(commandWorker);

  return {
    awaitCommandReady: Deferred.await(commandReady),
    signalCommandReady: Effect.gen(function* () {
      yield* Ref.set(commandReadinessState, "ready");
      yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
    }),
    failCommandReady: (error) =>
      Effect.gen(function* () {
        yield* Ref.set(commandReadinessState, error);
        yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
      }),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const readinessState = yield* Ref.get(commandReadinessState);
        if (readinessState === "ready") {
          return yield* effect;
        }
        if (readinessState !== "pending") {
          return yield* readinessState;
        }

        const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
        yield* Queue.offer(commandQueue, {
          run: Deferred.await(commandReady).pipe(
            Effect.flatMap(() => effect),
            Effect.exit,
            Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
          ),
        });
        return yield* Deferred.await(result);
      }),
  } satisfies CommandGate;
});

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getCounts().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup projection counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

export const launchStartupHeartbeat = recordStartupHeartbeat.pipe(
  Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
  Effect.withSpan("server.startup.heartbeat.record"),
  Effect.ignoreCause({ log: true }),
  Effect.forkScoped,
  Effect.asVoid,
);

export const getAutoBootstrapDefaultModelSelection = (): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
});

export const resolveWelcomeBase = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const segments = serverConfig.cwd.split(/[/\\]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? "project";

  return {
    cwd: serverConfig.cwd,
    projectName,
  } as const;
});

export const resolveAutoBootstrapWelcomeTargets = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        serverConfig.cwd,
      );
      let nextProjectId: ProjectId;
      let nextProjectDefaultModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        nextProjectId = ProjectId.make(yield* randomUUID);
        const bootstrapProjectTitle = path.basename(serverConfig.cwd) || "project";
        nextProjectDefaultModelSelection = getAutoBootstrapDefaultModelSelection();
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* randomUUID),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          defaultModelSelection: nextProjectDefaultModelSelection,
          createdAt,
        });
      } else {
        nextProjectId = existingProject.value.id;
        nextProjectDefaultModelSelection =
          existingProject.value.defaultModelSelection ?? getAutoBootstrapDefaultModelSelection();
      }

      const existingThreadId =
        yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);
      if (Option.isNone(existingThreadId)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const createdThreadId = ThreadId.make(yield* randomUUID);
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(yield* randomUUID),
          threadId: createdThreadId,
          projectId: nextProjectId,
          title: "New thread",
          modelSelection: nextProjectDefaultModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = createdThreadId;
      } else {
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = existingThreadId.value;
      }
    });
  }

  return {
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } as const;
});

const resolveStartupBrowserTarget = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const baseTarget = serverConfig.devUrl?.toString() ?? bindUrl;
  return yield* Effect.succeed(serverConfig.mode === "desktop" ? baseTarget : undefined).pipe(
    Effect.flatMap((target) =>
      target ? Effect.succeed(target) : serverAuth.issueStartupPairingUrl(baseTarget),
    ),
  );
});

const maybeOpenBrowser = (target: string) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    if (serverConfig.noBrowser) {
      return;
    }
    const externalLauncher = yield* ExternalLauncher.ExternalLauncher;

    yield* externalLauncher.launchBrowser(target).pipe(
      Effect.catch(() =>
        Effect.logInfo("browser auto-open unavailable", {
          hint: `Open ${target} in your browser.`,
        }),
      ),
    );
  });

const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.annotateSpans({ "startup.phase": phase }),
    Effect.withSpan(`server.startup.${phase}`),
  );

export const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";

const ThreadRecoveryPolicies = Schema.Struct({
  threads: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([
        Schema.Struct({
          mode: Schema.Literal("paused"),
          fallbackAt: Schema.optional(Schema.String),
          event: Schema.optional(Schema.String),
        }),
        Schema.Struct({
          mode: Schema.Literal("finished"),
          reason: Schema.optional(Schema.String),
        }),
      ]),
    ),
  ),
});
const decodeThreadRecoveryPolicies = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ThreadRecoveryPolicies),
);

export class ThreadRecoveryPolicyReadError extends Schema.TaggedErrorClass<ThreadRecoveryPolicyReadError>()(
  "ThreadRecoveryPolicyReadError",
  {
    errorClass: Schema.Union([Schema.Literal("unreadable"), Schema.Literal("malformed")]),
  },
) {}

export const readThreadRecoveryPolicy = Effect.fn("readThreadRecoveryPolicy")(function* (
  threadId: string,
  configuredHome?: string,
) {
  const t3Home = configuredHome ?? process.env.T3CODE_HOME;
  if (!t3Home) return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const policyPath = path.join(t3Home, "userdata/thread-recovery-policies.json");
  const encoded = yield* fileSystem
    .readFileString(policyPath)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(new ThreadRecoveryPolicyReadError({ errorClass: "unreadable" })),
      ),
    );
  if (encoded === null) return null;
  return yield* decodeThreadRecoveryPolicies(encoded).pipe(
    Effect.map((parsed) => parsed.threads?.[threadId] ?? null),
    Effect.mapError(() => new ThreadRecoveryPolicyReadError({ errorClass: "malformed" })),
  );
});

interface ProviderSessionReconciliationOptions {
  readonly graceMs?: number;
  readonly readRecoveryPolicy?: (threadId: string) => ThreadRecoveryPolicy | null;
}

const reconcileProviderSessionsEffect = Effect.fn("reconcileProviderSessions")(
  function* (options: ProviderSessionReconciliationOptions) {
    const crypto = yield* Crypto.Crypto;
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
    const providerService = yield* ProviderService.ProviderService;
    const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const readRecoveryPolicy = (threadId: string) =>
      options.readRecoveryPolicy
        ? Effect.sync(() => options.readRecoveryPolicy?.(threadId) ?? null)
        : readThreadRecoveryPolicy(threadId);

    const readTrustedRecoveryPolicy = (threadId: string) =>
      readRecoveryPolicy(threadId).pipe(
        Effect.map(Option.some),
        Effect.catchTag("ThreadRecoveryPolicyReadError", (error) =>
          Effect.logError("automatic thread recovery policy unavailable", {
            threadId,
            errorClass: error.errorClass,
          }).pipe(Effect.as(Option.none())),
        ),
      );

    const liveThreadIds = new Set(
      (yield* providerService.listSessions()).map((session) => session.threadId),
    );
    const recoveryThreads = (yield* query.getShellSnapshot()).threads;
    const { threads } = yield* query.getCommandReadModel();
    const orphanedThreads = threads.filter(
      (thread) =>
        thread.session !== null &&
        (thread.session.status === "starting" ||
          thread.session.status === "running" ||
          thread.session.activeTurnId !== null) &&
        !liveThreadIds.has(thread.id),
    );
    const orphanedThreadIds = new Set(orphanedThreads.map((thread) => thread.id));
    const recoveryDescriptors: ThreadRecoveryDescriptor[] = [];
    for (const thread of recoveryThreads) {
      const policy = yield* readTrustedRecoveryPolicy(thread.id);
      if (Option.isNone(policy)) continue;
      if (automaticRecoveryDelayMs(policy.value, options.graceMs) === null) {
        continue;
      }
      if (orphanedThreadIds.has(thread.id)) {
        const interruptedTurnId = interruptedTurnForAutomaticRecovery(thread as never);
        if (interruptedTurnId !== null) {
          recoveryDescriptors.push({
            threadId: thread.id,
            interruptedTurnId,
            latestUserMessageAt: thread.latestUserMessageAt,
          });
        }
        continue;
      }
      const descriptor = descriptorFromReconciledOrphan(
        thread.id,
        thread as never,
        ORPHANED_PROVIDER_SESSION_ERROR,
      );
      if (descriptor !== null) recoveryDescriptors.push(descriptor);
    }

    for (const thread of orphanedThreads) {
      const session = thread.session;
      if (session === null) {
        continue;
      }
      yield* Effect.gen(function* () {
        const binding = yield* directory.getBinding(thread.id);
        if (Option.isSome(binding)) {
          yield* directory.upsert({
            ...binding.value,
            status: "stopped",
            runtimePayload: { activeTurnId: null },
          });
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("failed to reconcile orphaned provider session directory binding", {
                threadId: thread.id,
                cause,
              }),
        ),
      );

      yield* Effect.gen(function* () {
        const reconciledAt = DateTime.formatIso(yield* DateTime.now);
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          threadId: thread.id,
          session: {
            ...session,
            status: "error",
            activeTurnId: null,
            lastError: ORPHANED_PROVIDER_SESSION_ERROR,
            updatedAt: reconciledAt,
          },
          createdAt: reconciledAt,
        });
      }).pipe(
        Effect.retry({ times: 1 }),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("failed to settle orphaned provider session projection", {
                threadId: thread.id,
                cause,
              }),
        ),
      );
    }

    for (const descriptor of recoveryDescriptors) {
      const initialPolicy = yield* readTrustedRecoveryPolicy(descriptor.threadId);
      if (Option.isNone(initialPolicy)) continue;
      const delayMs = automaticRecoveryDelayMs(initialPolicy.value, options.graceMs);
      if (delayMs === null) continue;
      yield* Effect.forkScoped(
        Effect.sleep(Duration.millis(delayMs)).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const currentPolicy = yield* readTrustedRecoveryPolicy(descriptor.threadId);
              if (Option.isNone(currentPolicy)) return;
              if (automaticRecoveryDelayMs(currentPolicy.value, 0) === null) return;
              const providerBecameLive = (yield* providerService.listSessions()).some(
                (session) => session.threadId === descriptor.threadId,
              );
              if (providerBecameLive) return;
              const thread = yield* query
                .getThreadShellById(ThreadId.make(descriptor.threadId))
                .pipe(Effect.map(Option.getOrUndefined));
              if (
                thread === undefined ||
                !isEligibleAfterOrphanReconciliation(
                  thread as never,
                  descriptor,
                  ORPHANED_PROVIDER_SESSION_ERROR,
                )
              ) {
                return;
              }
              const createdAt = DateTime.formatIso(yield* DateTime.now);
              const key = recoveryCommandKey(descriptor.threadId, descriptor.interruptedTurnId);
              yield* orchestrationEngine.dispatch({
                type: "thread.turn.start",
                commandId: CommandId.make(key),
                threadId: ThreadId.make(descriptor.threadId),
                message: {
                  messageId: MessageId.make(
                    recoveryMessageId(descriptor.threadId, descriptor.interruptedTurnId),
                  ),
                  role: "user",
                  text: THREAD_RECOVERY_PROMPT,
                  attachments: [],
                },
                modelSelection: thread.modelSelection,
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
                createdAt,
              });
            }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread recovery failed", {
                  threadId: descriptor.threadId,
                  interruptedTurnId: descriptor.interruptedTurnId,
                  cause,
                }),
          ),
        ),
      );
    }
    // Prove each scoped supervisor reached its grace boundary before startup
    // leaves reconciliation. This keeps arming ordered after cleanup.
    if (recoveryDescriptors.length > 0) yield* Effect.yieldNow;
  },
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning("provider session startup reconciliation failed", { cause }),
  ),
);

export const reconcileProviderSessions = (options: ProviderSessionReconciliationOptions = {}) =>
  reconcileProviderSessionsEffect(options);

interface StartupOptions {
  readonly activate?: Effect.Effect<void>;
  readonly awaitAuxiliaryParked?: Effect.Effect<void>;
  readonly abort?: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
}

export const make = (options?: StartupOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const keybindings = yield* Keybindings.Keybindings;
    const orchestrationReactor = yield* OrchestrationReactor.OrchestrationReactor;
    const providerSessionReaper = yield* ProviderSessionReaper.ProviderSessionReaper;
    const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const crypto = yield* Crypto.Crypto;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;

    const commandGate = yield* makeCommandGate;
    const httpListening = yield* Deferred.make<void>();
    const reactorScope = yield* Scope.make("sequential");

    yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));

    const startup = Effect.gen(function* () {
      yield* Effect.logDebug("startup phase: starting keybindings runtime");
      yield* runStartupPhase(
        "keybindings.start",
        keybindings.start.pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to start keybindings runtime", {
              path: error.configPath,
              detail: error.detail,
              cause: error.cause,
            }),
          ),
        ),
      );

      yield* Effect.logDebug("startup phase: starting server settings runtime");
      yield* runStartupPhase(
        "settings.start",
        serverSettings.start.pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to start server settings runtime", {
              path: error.settingsPath,
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }),
          ),
        ),
      );

      yield* Effect.logDebug("startup phase: parking orchestration roots at activation");
      yield* runStartupPhase(
        "reactors.start",
        Effect.gen(function* () {
          yield* orchestrationReactor.start().pipe(Scope.provide(reactorScope));
          yield* providerSessionReaper.start().pipe(Scope.provide(reactorScope));
        }),
      );

      yield* runStartupPhase("provider-sessions.reconcile", reconcileProviderSessions());

      const welcomeBase = yield* resolveWelcomeBase;
      const environment = yield* serverEnvironment.getDescriptor;
      yield* Effect.logDebug("startup phase: preparing welcome payload");

      if (serverConfig.autoBootstrapProjectFromCwd) {
        yield* forkParked(
          runStartupPhase(
            "welcome.autobootstrap",
            Effect.gen(function* () {
              const bootstrapTargets = yield* resolveAutoBootstrapWelcomeTargets.pipe(
                Effect.provideService(Crypto.Crypto, crypto),
              );
              if (!bootstrapTargets.bootstrapProjectId && !bootstrapTargets.bootstrapThreadId) {
                return;
              }

              yield* Effect.logDebug("startup phase: publishing bootstrapped welcome event", {
                environmentId: environment.environmentId,
                cwd: welcomeBase.cwd,
                projectName: welcomeBase.projectName,
                bootstrapProjectId: bootstrapTargets.bootstrapProjectId,
                bootstrapThreadId: bootstrapTargets.bootstrapThreadId,
              });
              yield* lifecycleEvents.publish({
                version: 1,
                type: "welcome",
                payload: {
                  environment,
                  ...welcomeBase,
                  ...bootstrapTargets,
                },
              });
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("startup auto-bootstrap welcome failed", {
                  cause,
                }),
              ),
            ),
          ),
        );
      }

      yield* forkParked(
        Effect.gen(function* () {
          yield* Effect.logDebug("startup phase: recording startup heartbeat");
          yield* recordStartupHeartbeat.pipe(
            Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
            Effect.withSpan("server.startup.heartbeat.record"),
            Effect.ignoreCause({ log: true }),
          );
          if (serverConfig.startupPresentation === "headless") {
            const accessInfo = yield* issueHeadlessServeAccessInfo();
            yield* runStartupPhase(
              "headless.output",
              Console.log(formatHeadlessServeOutput(accessInfo)),
            );
          } else {
            const startupBrowserTarget = yield* resolveStartupBrowserTarget;
            if (serverConfig.mode !== "desktop") {
              yield* Effect.logInfo(
                "Authentication required. Open T3 Code using the pairing URL.",
              ).pipe(Effect.annotateLogs({ pairingUrl: startupBrowserTarget }));
            }
            yield* runStartupPhase("browser.open", maybeOpenBrowser(startupBrowserTarget));
          }
        }),
      );

      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* runStartupPhase("http.wait", Deferred.await(httpListening));
      yield* runStartupPhase(
        "auxiliary-roots.parked",
        options?.awaitAuxiliaryParked ?? Effect.void,
      );

      // This is the prepared boundary. Every dependency has been acquired and
      // every runtime root has confirmed that it is parked before this request.
      const updateOutcome = yield* launcher.prepareTrial;
      yield* runStartupPhase(
        "welcome.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "welcome",
          payload: { environment, ...welcomeBase },
        }),
      );
      yield* options?.activate ?? Effect.void;

      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* runStartupPhase(
        "ready.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "ready",
          payload: {
            at: DateTime.formatIso(yield* DateTime.now),
            environment,
            ...(updateOutcome === undefined ? {} : { updateOutcome }),
          },
        }),
      );
      yield* Effect.logDebug("startup phase: complete");
    }).pipe(
      Effect.annotateSpans({
        "server.mode": serverConfig.mode,
        "server.port": serverConfig.port,
        "server.host": serverConfig.host ?? "default",
      }),
      Effect.withSpan("server.startup", { kind: "server", root: true }),
    );

    yield* Effect.forkScoped(
      Effect.exit(startup).pipe(
        Effect.flatMap((startupExit) => {
          if (Exit.isSuccess(startupExit)) return Effect.void;
          const error = new ServerRuntimeStartupError({
            mode: serverConfig.mode,
            host: serverConfig.host ?? null,
            port: serverConfig.port,
            cause: startupExit.cause,
          });
          return Effect.logError("server runtime startup failed", {
            cause: startupExit.cause,
          }).pipe(
            Effect.andThen(commandGate.failCommandReady(error)),
            Effect.andThen(options?.abort?.(error) ?? Effect.void),
          );
        }),
      ),
    );

    return {
      awaitCommandReady: commandGate.awaitCommandReady,
      markHttpListening: Deferred.succeed(httpListening, undefined),
      enqueueCommand: commandGate.enqueueCommand,
    } satisfies ServerRuntimeStartup["Service"];
  });

export const layerWithOptions = (options?: StartupOptions) =>
  Layer.effect(ServerRuntimeStartup, make(options));

export const layer = layerWithOptions();
