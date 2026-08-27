# Restart recovery builder evidence

## Result

PASS for the automated build and test stage. No live server drill ran in this stage.

## Objective and constraints

The change adds one guarded continuation turn after a server restart interrupts a true provider orphan. Upstream orphan reconciliation remains the only session reconciler. The integrated provider recovery flow remains the only fallback for an incompatible provider resume.

Work stayed in `/home/blackbear/T3Projects/bear3t-integration-rc` on `codex/release-orchestrator-20260826`. It did not touch the canonical checkout, runtime database, services, remotes, or deployment state.

## Decisions

- Capture eligible active turns before upstream cleanup changes session state.
- Arm scoped grace fibers only after cleanup completes.
- Re-arm after a restart during grace only from the exact persisted orphan error. This preserves provenance without a new migration.
- Re-read the thread shell and recovery policy after grace.
- Require the same running turn and unchanged latest user message time.
- Suppress recovery for archive/delete, approval, input, provider-recovery candidate, paused policy, finished policy, changed or completed turn, changed session state, and live provider session cases.
- Dispatch an ordinary `thread.turn.start`. The stable command key is `thread-recovery:<thread>:<interrupted-turn>`. The stable message ID is `server:thread-recovery:<thread>:<interrupted-turn>`.
- Mark a projected latest turn as `recovery: true` only when its persisted pending message ID has the recovery prefix. No database migration is required.
- Do not call provider session creation from the supervisor. The normal turn-start reactor owns session creation and the existing provider recovery flow owns resume fallback.

## Changed files

- `apps/server/src/orchestration/ThreadRecoverySupervisor.ts`
- `apps/server/src/orchestration/ThreadRecoverySupervisor.test.ts`
- `apps/server/src/serverRuntimeStartup.ts`
- `apps/server/src/serverRuntimeStartup.reconcile.test.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- `packages/contracts/src/orchestration.ts`

## Verification

PASS:

```text
vp test run ThreadRecoverySupervisor + serverRuntimeStartup.reconcile + ProjectionSnapshotQuery
3 files, 48 tests passed

vp test run orphanedProviderSessionStartup.integration + serverRuntimeStartup
2 files, 9 tests passed

vp test run ProviderCommandReactor
1 file, 53 tests passed

vp run --filter @t3tools/contracts typecheck
PASS

vp run --filter t3 typecheck
PASS with existing Effect diagnostic suggestions only

git diff --check
PASS
```

The critic listed `apps/server/src/provider/OrphanedProviderSessionStartup.integration.test.ts`. That path does not exist in this tree. The test is at `apps/server/integration/orphanedProviderSessionStartup.integration.test.ts`, and it passed.

The targeted lint command reported existing `no-manual-effect-runtime-in-tests` errors in untouched sections of `ProviderCommandReactor.test.ts` and two existing set-use warnings in `ProjectionSnapshotQuery.test.ts`. The changed production files typecheck. The focused tests pass. Formatting checks pass after formatting the four new or materially rewritten files.

## Covered failure modes

- Capture occurs before cleanup and arming occurs after cleanup.
- Two startup passes around the same interrupted turn accept one durable command and one message identity.
- A restart during grace re-arms from the persisted orphan marker.
- A new user message during grace cancels recovery.
- Approval, user input, archive, deletion, provider recovery, completed/replaced turn, changed session state, paused policy, and finished policy suppress recovery.
- A live provider session does not become an orphan candidate.
- A synthetic restart turn can enter the existing provider resume fallback once.
- Existing candidate preparation and `dispatch-committed` restart tests still pass and do not resend provider input.
- Projection marks synthetic recovery turns and does not mark ordinary turns.

## Residual limits

- This stage did not run a live restart drill or deploy a release.
- Durable command receipts give at-most-once orchestration acceptance. They do not make arbitrary shell commands or external API effects exactly once.
- Recovery policy lookup uses the existing local policy file. Missing or invalid policy data defaults to normal recovery. A valid paused or finished policy suppresses recovery.
- The supervisor scope belongs to the server runtime. A process exit during grace relies on the next startup to re-arm from the exact persisted orphan error.

## Reproduction

Run the commands in the verification section from `/home/blackbear/T3Projects/bear3t-integration-rc` at the committed builder SHA. The source design is `/home/blackbear/T3Projects/bear3t-release-orchestrator/artifacts/gauntlet/recovery-design-critic.md`.
