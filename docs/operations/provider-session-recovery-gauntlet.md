# Provider session recovery gauntlet

## Objective

Keep one visible BearT3 thread usable when a provider session cannot resume. Bound memory use before decoding provider messages. Start one fresh provider session when the old cursor is oversized, missing, or stale. Supply bounded prior context and send the pending user message once.

## Constraints

- Preserve the BearT3 thread and its event history.
- Do not depend on Codex-only controls in orchestration.
- Do not store or resend historical image bytes in the recovery prompt.
- Do not retry a failed resume more than once.
- Keep provider input within the existing maximum input size.
- Preserve unrelated work in the dirty worktree.

## Failure fixture

The reported Codex resume produced one newline-delimited JSON message of 84,370,864 bytes. The protocol decoder retained a partial line until it found a newline. This allowed one provider response to create an unbounded allocation before the JSON decoder could reject it.

The deterministic regression fixture uses small in-memory chunks and a configurable byte limit. It proves the boundary without committing an 80 MiB file:

- reject a no-newline message at the first byte over the configured limit;
- accept a message exactly at the limit;
- do not include payload content in the typed error.

## Decision log

1. Enforce the byte limit on raw chunks before UTF-8 text decoding.
2. Convert resume-specific failures to `ProviderAdapterResumeError` at the provider boundary.
3. Add provider-neutral `resumePolicy: "fresh"` to session start input.
4. Let orchestration retry once. Do not let the Codex adapter silently start an empty thread.
5. Build a bounded recovery prompt from durable BearT3 messages. Exclude the pending message from history, then append it once.
6. Write a bounded, private recovery bundle under the active workspace's ignored `.t3/recovery-context/` directory. Copy only regular allowlisted attachment files contained by BearT3's attachment store.
7. Record recovery start and recovery-context submission as thread activities. A successful `sendTurn` call is not proof that the provider completed the turn.
8. Persist the recovery state in the event log. Materialize active candidate bindings in bounded `provider_session_runtime` columns for startup reconciliation.
9. Keep the canonical provider cursor unchanged while a candidate runs. Promote the candidate cursor and runtime payload with one guarded SQL update only after the matching successful `turn.completed` event.
10. Write `dispatch-committed` before calling the provider. After a restart, never resend that automatic dispatch because the provider outcome is unknown.

## Gauntlet waves

### Wave 1: bounded protocol input

Gate: an oversized line fails before text or JSON decoding. Exact-boundary input succeeds.

### Wave 2: shared recovery contract

Gate: a provider can explicitly start fresh, and persisted resume state cannot override that request.

### Wave 3: continuity

Gate: a recoverable resume failure causes one fresh start in the same BearT3 thread. The recovery prompt contains the original objective and recent context. It contains the current user message exactly once and remains within the provider input limit.

### Wave 4: adversarial review

The first critic returned LOSS because the integration test observed the send call before the forked submission activity was projected. The repaired test waits for the projected submission activity. It also checks one observed delivery and the maximum input size. It does not claim crash-safe exactly-once delivery.

### Wave 5: durable recovery handoff

Gate: each recovery uses deterministic recovery, start, and dispatch keys. The event model rejects non-monotonic transitions. Candidate provider state is separate from the canonical binding. Startup reconciliation scans only active candidate rows. A prepared or candidate-started recovery receives at most one automatic dispatch. A dispatch-committed or turn-started recovery receives no automatic resend. Promotion requires the matching provider instance, turn ID, and successful completion state.

### Wave 6: provider-neutral references

Gate: every coding provider receives one workspace-relative manifest path. The manifest and message files are deterministic, bounded, mode `0600`, and contained below a non-symlinked workspace directory. Old bundles expire after 24 hours, and each thread retains at most eight bundles.

Agent input boundary:

- Sees now: the replacement agent sees the bounded transcript, current request, and manifest path.
- Can fetch: the agent can read the manifest and its listed message text files with its normal workspace file tools. File contents enter model context only after the agent reads them.
- Cannot see: unlisted messages and attachment bytes that were missing, unsafe, unsupported, or over a bundle limit. A sandbox policy that blocks `.t3` also blocks this retrieval path.

## Verification

Run:

```bash
./node_modules/.bin/vp test run \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts \
  apps/server/src/orchestration/ProviderRecoveryContext.test.ts \
  apps/server/src/orchestration/ProviderRecoveryBundle.test.ts \
  packages/contracts/src/provider.test.ts \
  apps/server/src/provider/Layers/ProviderService.test.ts \
  apps/server/src/provider/Layers/CodexAdapter.test.ts \
  apps/server/src/provider/Layers/CodexSessionRuntime.test.ts \
  packages/effect-codex-app-server/src/protocol.test.ts
```

Observed Wave 2 result in the isolated release candidate: twelve files and 268 tests pass. The reactor crash-boundary suite contains four restart probes: prepared, candidate-started, dispatch-committed, and turn-started. The reference-bundle lane adds focused containment, bounds, determinism, file-mode, attachment-copy, prompt-leakage, cleanup, and symlink tests.

Package checks:

```bash
./node_modules/.bin/vp run --filter effect-codex-app-server typecheck
./node_modules/.bin/vp run --filter @t3tools/contracts typecheck
./node_modules/.bin/vp run --filter t3 typecheck
```

All three checks exit successfully. The server check reports pre-existing Effect style suggestions only.

## Release-candidate boundary

This worktree is a durable provider recovery release candidate. It is not deployed. The replacement provider agent sees a bounded inline transcript, the current request, and a workspace-relative recovery-manifest path. It can use its normal workspace tools to read bounded historical message and attachment copies. It cannot see unlisted history, rejected files, or anything blocked by its provider sandbox.

The BearT3 controller sees the durable thread event history and the bounded active-candidate projection. It does not know whether a provider accepted a request if the process crashes after `dispatch-committed` but before a provider receipt. In that state it records uncertainty and suppresses automatic resend.

The portable guarantee is exactly-once recording of accepted BearT3 recovery transitions plus at-most-once automatic provider dispatch. It is not true exactly-once provider delivery.

## Known gaps

- Provider delivery remains uncertain after a crash between the provider accepting a request and BearT3 receiving its result. BearT3 suppresses resend in this state.
- Historical attachment copying is limited to four allowlisted regular files, 5 MiB per file, and 10 MiB in total. Other attachment entries remain metadata only.
- Workspace reference retrieval depends on the provider's normal file tools and sandbox allowing `.t3`. It works without MCP for ordinary Codex, Claude, Cursor, Grok, and OpenCode coding sessions, but it is not guaranteed for providers or modes without file access.
- Provider classifiers are conservative. Ambiguous transport, timeout, decode, and asynchronous resume failures remain generic when the native protocol does not prove that starting fresh is safe.
- `resumePolicy: "fresh"` now strips both an explicit request cursor and a matching persisted cursor before the adapter call. Tests cover explicit-over-persisted precedence and fresh-over-both precedence.

## Full shipping gates

1. Run the integrated deterministic suite and fresh critic after merging the durable, provider-matrix, and retrieval lanes.
2. Add provider-native idempotency keys where a provider supports them. Do not advertise exactly-once delivery for providers that do not.
3. Decide whether non-file-capable provider modes need an authenticated retrieval tool. Keep large binary data out of the initial prompt.
4. Run a staged build and authenticated live-client canary before promotion.

## Rollback

Revert the release-candidate commit before deployment. Migration 042 is additive. Do not remove its columns or rewrite existing thread events. A recovery rollback stops the candidate and clears only candidate columns; it retains the canonical cursor so BearT3 can restart the prior remote session.

## Reproduction sources

- Reported BearT3 thread: `ece586c8-0982-456e-b1cd-c485d65233b5/f4df63e3-0f6e-4372-88f3-d90f7727cbcc`
- Ticket: `TKT-0002`
- Primary implementation and tests are the files named by the verification command.
