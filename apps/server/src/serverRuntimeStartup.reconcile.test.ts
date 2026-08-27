import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectoryPersistenceError } from "./provider/Errors.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const updatedAt = "2026-08-20T12:00:00.000Z";

const makeThread = (
  id: string,
  status: "starting" | "running" | "ready" | "stopped" | "error",
  activeTurnId: TurnId | null = null,
  archivedAt: string | null = null,
) => ({
  id: ThreadId.make(id),
  archivedAt,
  deletedAt: null,
  session: {
    threadId: ThreadId.make(id),
    status,
    providerName: "codex" as const,
    providerInstanceId,
    runtimeMode: "full-access" as const,
    activeTurnId,
    lastError: null,
    updatedAt,
  },
});

const makeProviderService = (liveThreadIds: ReadonlyArray<ThreadId> = []) =>
  ({
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    interruptTurn: () => Effect.die("unused"),
    respondToRequest: () => Effect.die("unused"),
    respondToUserInput: () => Effect.die("unused"),
    stopSession: () => Effect.die("unused"),
    listSessions: () => Effect.succeed(liveThreadIds.map((threadId) => ({ threadId }) as never)),
    getCapabilities: () => Effect.die("unused"),
    getInstanceInfo: () => Effect.die("unused"),
    rollbackConversation: () => Effect.die("unused"),
    streamEvents: Stream.empty,
  }) satisfies ProviderService.ProviderService["Service"];

const queryWithThreads = (threads: ReadonlyArray<ReturnType<typeof makeThread>>) =>
  ({
    getCommandReadModel: () => Effect.succeed({ threads } as never),
    getShellSnapshot: () => Effect.succeed({ threads: [] } as never),
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const runReconciliation = (input: {
  readonly threads: ReadonlyArray<ReturnType<typeof makeThread>>;
  readonly liveThreadIds?: ReadonlyArray<ThreadId>;
  readonly directory: Partial<ProviderSessionDirectory.ProviderSessionDirectory["Service"]>;
  readonly dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"];
}) =>
  Effect.scoped(ServerRuntimeStartup.reconcileProviderSessions()).pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      queryWithThreads(input.threads),
    ),
    Effect.provideService(
      ProviderService.ProviderService,
      makeProviderService(input.liveThreadIds),
    ),
    Effect.provideService(
      ProviderSessionDirectory.ProviderSessionDirectory,
      input.directory as ProviderSessionDirectory.ProviderSessionDirectory["Service"],
    ),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: input.dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(NodeServices.layer),
  );

it.effect("reconciles multiple active and archived orphans but skips live sessions", () => {
  const starting = makeThread("thread-starting", "starting");
  const running = makeThread("thread-running", "running", TurnId.make("turn-running"));
  const staleActiveTurn = makeThread(
    "thread-stale-active-turn",
    "ready",
    TurnId.make("turn-stale-active"),
  );
  const archived = makeThread(
    "thread-archived",
    "running",
    TurnId.make("turn-archived"),
    updatedAt,
  );
  const live = makeThread("thread-live", "running", TurnId.make("turn-live"));
  const settled = makeThread("thread-ready", "ready");
  const dispatched: OrchestrationCommand[] = [];
  const bindingReads: ThreadId[] = [];
  const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];

  return runReconciliation({
    threads: [starting, running, staleActiveTurn, archived, live, settled],
    liveThreadIds: [live.id],
    directory: {
      getBinding: (candidate) =>
        Effect.sync(() => bindingReads.push(candidate)).pipe(
          Effect.as(
            Option.some({
              threadId: candidate,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId,
              status: "running" as const,
              resumeCursor: { cursor: candidate },
              runtimePayload: { activeTurnId: "stale", unrelated: candidate },
            }),
          ),
        ),
      upsert: (binding) => Effect.sync(() => upserts.push(binding)),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.die("unused"),
    },
    dispatch: (command) =>
      Effect.sync(() => dispatched.push(command)).pipe(Effect.as({ sequence: dispatched.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const orphanIds = [starting.id, running.id, staleActiveTurn.id, archived.id];
        assert.deepStrictEqual(bindingReads, orphanIds);
        assert.deepStrictEqual(
          dispatched.map((command) => command.type === "thread.session.set" && command.threadId),
          orphanIds,
        );
        assert.deepStrictEqual(
          dispatched.map((command) =>
            command.type === "thread.session.set"
              ? {
                  status: command.session.status,
                  activeTurnId: command.session.activeTurnId,
                }
              : null,
          ),
          orphanIds.map(() => ({ status: "error" as const, activeTurnId: null })),
        );
        assert.equal(upserts.length, orphanIds.length);
        for (const binding of upserts) {
          assert.equal(binding.status, "stopped");
          assert.deepStrictEqual(binding.runtimePayload, { activeTurnId: null });
          assert.deepStrictEqual(binding.resumeCursor, { cursor: binding.threadId });
        }
      }),
    ),
  );
});

it.effect(
  "settles projections when directory bindings are absent, corrupt, or fail to upsert",
  () => {
    const absent = makeThread("thread-binding-absent", "starting");
    const corrupt = makeThread("thread-binding-corrupt", "running");
    const upsertFailure = makeThread("thread-binding-upsert-failure", "running");
    const dispatched: OrchestrationCommand[] = [];
    const corruptFailure = new ProviderSessionDirectoryPersistenceError({
      operation: "ProviderSessionDirectory.getBinding",
      detail: "corrupt persisted binding",
    });
    const writeFailure = new ProviderSessionDirectoryPersistenceError({
      operation: "ProviderSessionDirectory.upsert",
      detail: "failed binding write",
    });

    return runReconciliation({
      threads: [absent, corrupt, upsertFailure],
      directory: {
        getBinding: (candidate) =>
          candidate === absent.id
            ? Effect.succeed(Option.none())
            : candidate === corrupt.id
              ? Effect.fail(corruptFailure)
              : Effect.succeed(
                  Option.some({
                    threadId: candidate,
                    provider: ProviderDriverKind.make("codex"),
                    providerInstanceId,
                  }),
                ),
        upsert: () => Effect.fail(writeFailure),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.die("unused"),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepStrictEqual(
            dispatched.map((command) => command.type === "thread.session.set" && command.threadId),
            [absent.id, corrupt.id, upsertFailure.id],
          );
        }),
      ),
    );
  },
);

it.effect("retries failed projections and continues after a persistent failure", () => {
  const transient = makeThread("thread-dispatch-transient-failure", "running");
  const persistent = makeThread("thread-dispatch-persistent-failure", "running");
  const later = makeThread("thread-dispatch-success", "running");
  const attempted: ThreadId[] = [];
  let transientAttempts = 0;
  const failure = new OrchestrationCommandInvariantError({
    commandType: "thread.session.set",
    detail: "simulated startup reconciliation failure",
  });

  return runReconciliation({
    threads: [transient, persistent, later],
    directory: {
      getBinding: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.die("unused"),
    },
    dispatch: (command) => {
      if (command.type !== "thread.session.set") {
        return Effect.die("unexpected command");
      }
      attempted.push(command.threadId);
      if (command.threadId === transient.id && transientAttempts++ === 0) {
        return Effect.fail(failure);
      }
      return command.threadId === persistent.id
        ? Effect.fail(failure)
        : Effect.succeed({ sequence: attempted.length });
    },
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        assert.deepStrictEqual(attempted, [
          transient.id,
          transient.id,
          persistent.id,
          persistent.id,
          later.id,
        ]),
      ),
    ),
  );
});

it.effect("does not fail startup when the live provider session inventory cannot be read", () => {
  let queried = false;
  return Effect.scoped(ServerRuntimeStartup.reconcileProviderSessions()).pipe(
    Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
      getShellSnapshot: () =>
        Effect.sync(() => {
          queried = true;
          return { threads: [] } as never;
        }),
      getCommandReadModel: () =>
        Effect.sync(() => {
          queried = true;
          return { threads: [] } as never;
        }),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
    Effect.provideService(ProviderService.ProviderService, {
      ...makeProviderService(),
      listSessions: () => Effect.die("provider inventory unavailable"),
    }),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
      getBinding: () => Effect.die("unused"),
      upsert: () => Effect.die("unused"),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.die("unused"),
    } as unknown as ProviderSessionDirectory.ProviderSessionDirectory["Service"]),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: () => Effect.die("unused"),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(NodeServices.layer),
    Effect.tap(() => Effect.sync(() => assert.equal(queried, false))),
  );
});

const makeRecoveryShell = (input?: {
  readonly latestUserMessageAt?: string;
  readonly sessionStatus?: "running" | "error";
  readonly lastError?: string | null;
}) => ({
  id: ThreadId.make("thread-recovery"),
  projectId: "project-1",
  title: "Recovery",
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "work",
  worktreePath: "/tmp/work",
  latestTurn: {
    turnId: TurnId.make("turn-interrupted"),
    state: "running",
    requestedAt: updatedAt,
    startedAt: updatedAt,
    completedAt: null,
    assistantMessageId: null,
  },
  createdAt: updatedAt,
  updatedAt,
  archivedAt: null,
  deletedAt: null,
  latestUserMessageAt: input?.latestUserMessageAt ?? updatedAt,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  recovery: null,
  session: {
    threadId: ThreadId.make("thread-recovery"),
    status: input?.sessionStatus ?? "running",
    providerName: "codex",
    providerInstanceId,
    runtimeMode: "full-access",
    activeTurnId:
      (input?.sessionStatus ?? "running") === "running" ? TurnId.make("turn-interrupted") : null,
    lastError: input?.lastError ?? null,
    updatedAt,
  },
});

function recoveryHarness(input?: { readonly changeDuringGrace?: () => void }) {
  let shell = makeRecoveryShell();
  let commandThread = makeThread("thread-recovery", "running", TurnId.make("turn-interrupted"));
  const order: string[] = [];
  const accepted = new Map<string, OrchestrationCommand>();
  const query = {
    getShellSnapshot: () => Effect.succeed({ threads: [shell] } as never),
    getCommandReadModel: () => Effect.succeed({ threads: [commandThread] } as never),
    getThreadShellById: () => Effect.succeed(Option.some(shell) as never),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
    command,
  ) =>
    Effect.sync(() => {
      if (command.type === "thread.session.set") {
        order.push("cleanup");
        commandThread = { ...commandThread, session: command.session } as never;
        shell = makeRecoveryShell({
          sessionStatus: "error",
          lastError: ServerRuntimeStartup.ORPHANED_PROVIDER_SESSION_ERROR,
        });
      } else if (command.type === "thread.turn.start") {
        order.push("recovery");
        if (!accepted.has(command.commandId)) accepted.set(command.commandId, command);
      }
      return { sequence: accepted.size + 1 };
    });

  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* ServerRuntimeStartup.reconcileProviderSessions({
        graceMs: 30_000,
        readRecoveryPolicy: () => null,
      });
      assert.deepStrictEqual(order, ["cleanup"]);

      // This models a process restart during grace. The second startup sees
      // the persisted, known orphan error and rearms the same stable command.
      yield* ServerRuntimeStartup.reconcileProviderSessions({
        graceMs: 30_000,
        readRecoveryPolicy: () => null,
      });
      yield* Effect.yieldNow;
      input?.changeDuringGrace?.();
      if (input?.changeDuringGrace) {
        shell = makeRecoveryShell({
          latestUserMessageAt: "2026-08-20T12:00:01.000Z",
          sessionStatus: "error",
          lastError: ServerRuntimeStartup.ORPHANED_PROVIDER_SESSION_ERROR,
        });
      }
      yield* TestClock.adjust("29999 millis");
      assert.equal(accepted.size, 0);
      yield* TestClock.adjust("1 millis");
      yield* Effect.yieldNow;
      return { accepted, order };
    }),
  ).pipe(
    Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, query),
    Effect.provideService(ProviderService.ProviderService, makeProviderService()),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
      getBinding: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.die("unused"),
    } as unknown as ProviderSessionDirectory.ProviderSessionDirectory["Service"]),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(NodeServices.layer),
  );
  return program;
}

it.effect("captures before cleanup, rearms after restart, and accepts one stable recovery", () =>
  recoveryHarness().pipe(
    Effect.tap(({ accepted, order }) =>
      Effect.sync(() => {
        assert.equal(accepted.size, 1);
        const command = [...accepted.values()][0];
        assert.equal(command?.type, "thread.turn.start");
        if (command?.type === "thread.turn.start") {
          assert.equal(command.commandId, "thread-recovery:thread-recovery:turn-interrupted");
          assert.equal(
            command.message.messageId,
            "server:thread-recovery:thread-recovery:turn-interrupted",
          );
        }
        assert.equal(order[0], "cleanup");
      }),
    ),
  ),
);

it.effect("a new user message during grace cancels recovery", () =>
  recoveryHarness({ changeDuringGrace: () => undefined }).pipe(
    Effect.tap(({ accepted }) => Effect.sync(() => assert.equal(accepted.size, 0))),
  ),
);
