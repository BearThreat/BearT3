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
6. Include historical attachment metadata only. A provider-neutral artifact retrieval tool does not exist yet.
7. Record recovery start and recovery-context submission as thread activities. A successful `sendTurn` call is not proof that the provider completed the turn.

## Gauntlet waves

### Wave 1: bounded protocol input

Gate: an oversized line fails before text or JSON decoding. Exact-boundary input succeeds.

### Wave 2: shared recovery contract

Gate: a provider can explicitly start fresh, and persisted resume state cannot override that request.

### Wave 3: continuity

Gate: a recoverable resume failure causes one fresh start in the same BearT3 thread. The recovery prompt contains the original objective and recent context. It contains the current user message exactly once and remains within the provider input limit.

### Wave 4: adversarial review

The first critic returned LOSS because the integration test observed the send call before the forked submission activity was projected. The repaired test waits for the projected submission activity. It also checks one observed delivery and the maximum input size. It does not claim crash-safe exactly-once delivery.

## Verification

Run:

```bash
./node_modules/.bin/vp test run \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts \
  apps/server/src/orchestration/ProviderRecoveryContext.test.ts \
  packages/contracts/src/provider.test.ts \
  apps/server/src/provider/Layers/ProviderService.test.ts \
  apps/server/src/provider/Layers/CodexAdapter.test.ts \
  apps/server/src/provider/Layers/CodexSessionRuntime.test.ts \
  packages/effect-codex-app-server/src/protocol.test.ts
```

Observed result in the isolated release candidate: seven files and 153 tests pass.

Package checks:

```bash
./node_modules/.bin/vp run --filter effect-codex-app-server typecheck
./node_modules/.bin/vp run --filter @t3tools/contracts typecheck
./node_modules/.bin/vp run --filter t3 typecheck
```

All three checks exit successfully. The server check reports pre-existing Effect style suggestions only.

## Release-candidate boundary

This worktree is Wave 1 evidence. It is not a deployable full thread-recovery system. The replacement provider agent receives a bounded inline transcript plus the current request. It does not receive omitted messages, historical attachment contents, or a durable retrieval handle. The orchestration process can read BearT3's projected messages, but its recovery marker is only process memory.

## Known gaps

- Recovery context is inline text. Universal artifact references need a provider-neutral authenticated retrieval interface. The current MCP capability only exposes preview tools, and external OpenCode sessions do not receive that MCP server.
- Recovery state is process-local until the start or send completes. A server crash during this small interval can lose the recovery marker.
- One observed send is not crash-safe exactly-once delivery. The design still needs a durable outbox and an idempotency key that survives process restart.
- Provider cursor replacement is not transactional. Full transactional replacement needs a staged provider-session generation and an atomic commit after the first successful turn.
- The shared contract is provider-neutral, but this change classifies native stale and oversized resume errors only for Codex. Other adapters need native classifiers before they can enter this path automatically.
- `resumePolicy: "fresh"` now strips both an explicit request cursor and a matching persisted cursor before the adapter call. Tests cover explicit-over-persisted precedence and fresh-over-both precedence.

## Full shipping gates

1. Persist recovery phases and retry ownership in the event model.
2. Use a transactional outbox and stable delivery key for the pending user turn.
3. Stage the replacement session as a new generation. Promote its cursor with compare-and-swap only after a provider completion receipt.
4. Add authenticated, bounded message and artifact retrieval references. Keep large historical data out of the initial prompt.
5. Add native failure classifiers and conformance tests for Claude, Cursor, Grok, and OpenCode.
6. Add crash-boundary tests after each state transition and a live authenticated-client canary.

## Rollback

Revert the files named in the ticket and this runbook. The change adds one optional contract field, so older callers remain valid. Do not remove or rewrite existing thread events during rollback.

## Reproduction sources

- Reported BearT3 thread: `ece586c8-0982-456e-b1cd-c485d65233b5/f4df63e3-0f6e-4372-88f3-d90f7727cbcc`
- Ticket: `TKT-0002`
- Primary implementation and tests are the files named by the verification command.
