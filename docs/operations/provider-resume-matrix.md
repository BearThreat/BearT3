# Provider resume matrix

## Objective

Detect native provider-history resume failures before BearT3 sends a pending user message. Return `ProviderAdapterResumeError` so the orchestration recovery path can create a fresh provider session with bounded BearT3 context.

This matrix documents the provider signals that feed BearT3's durable recovery flow. That flow stages a fresh candidate before start, commits dispatch before send, promotes its cursor only after a matching successful turn, and sends the pending request once.

## Agent input boundary

The provider agent's output is a function of the input that its provider runtime gives it. A BearT3 thread and a provider session are not the same information store.

| Provider | Resume input                              | What the resumed agent sees                                          | What it can fetch                                                       | What it cannot see                                                                                                             |
| -------- | ----------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Codex    | Codex thread ID through `thread/resume`   | Provider-retained Codex history if resume succeeds                   | Registered MCP tools and files allowed by the runtime                   | BearT3 messages omitted from provider history; artifacts without a tool or supplied path                                       |
| Claude   | Claude session UUID in SDK query options  | Provider-retained Claude session history if the SDK accepts the UUID | Its configured tools, allowed directories, and thread-scoped BearT3 MCP | BearT3 history that was never sent; historical artifacts that have no supplied path or retrieval tool                          |
| Cursor   | ACP session ID through `session/load`     | ACP replay/history returned for that session                         | ACP-configured MCP servers and allowed workspace files                  | BearT3-only history and artifacts not exposed through ACP or the filesystem                                                    |
| Grok     | ACP session ID through `session/load`     | ACP replay/history returned for that session                         | ACP-configured MCP servers and allowed workspace files                  | BearT3-only history and artifacts not exposed through ACP or the filesystem                                                    |
| OpenCode | OpenCode session ID through `session.get` | OpenCode history stored under that session ID                        | Registered MCP for a BearT3-owned server and allowed workspace files    | BearT3-only history; thread MCP when BearT3 connects to an external OpenCode server; artifacts without a supplied path or tool |

When resume fails, no replacement provider agent exists yet. The orchestration layer receives the typed error. It decides whether to create a fresh provider session. That fresh agent sees only the bounded recovery prompt, current user message, current attachments, system instructions, and tools that orchestration supplies. It does not inherit the failed provider session by implication.

## Classification matrix

| Provider | Native boundary                                           | Classified now                                                         | Still unsupported                                                                         |
| -------- | --------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Codex    | `thread/resume` and newline protocol input                | Missing session and oversized input                                    | Other provider-specific stale or decode variants not emitted as the known typed errors    |
| Claude   | SDK query construction and asynchronous query consumption | Explicit missing-session and stale-session messages at either boundary | Oversized and decode failures without stable SDK error types                              |
| Cursor   | ACP `session/load`                                        | Explicit missing, stale, and JSON-RPC method-not-found errors          | Ambiguous internal, transport, timeout, decode, and oversized failures                    |
| Grok     | ACP `session/load`                                        | Explicit missing, stale, and JSON-RPC method-not-found errors          | Ambiguous internal, transport, timeout, decode, and oversized failures                    |
| OpenCode | SDK `session.get`                                         | Structured HTTP 404 or exact OpenCode `NotFoundError`                  | Stale, decode, oversized, and unsupported-resume signals not exposed by this SDK boundary |

The classifiers are conservative. An unknown error stays a request or process error. This avoids replacing a valid provider session because of an authentication, network, or server outage.

## Decision log

- ACP classification is shared because Cursor and Grok use the same `effect-acp` session-load contract.
- ACP classification runs only when BearT3 supplied a valid resume session ID.
- OpenCode no longer converts a confirmed missing session into an empty session inside the adapter. Orchestration must own that recovery decision and context handoff.
- Claude classifies missing-session and stale-session failures during query construction and asynchronous query consumption. An asynchronous typed failure carries its reason through the runtime event contract. Ingestion resolves the failed turn's user message and writes one durable `prepared` recovery generation. The command reactor then starts one fresh candidate and sends that message once with bounded BearT3 context. Other asynchronous failures remain process errors and do not start recovery.
- No adapter classifies an error as oversized or decode-related without a stable structured protocol signal.

## Reproduction

Reviewed base commit: `38c16d058`.

```bash
./node_modules/.bin/vp test run \
  apps/server/src/provider/acp/AcpAdapterSupport.test.ts \
  apps/server/src/provider/Layers/ClaudeAdapter.test.ts \
  apps/server/src/provider/Layers/CursorAdapter.test.ts \
  apps/server/src/provider/Layers/GrokAdapter.test.ts \
  apps/server/src/provider/Layers/OpenCodeAdapter.test.ts
```

The server typecheck is also required for integration. Record pre-existing failures separately from errors introduced by this branch.

## Sources inspected

- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/CursorAdapter.ts`
- `apps/server/src/provider/Layers/GrokAdapter.ts`
- `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- `apps/server/src/provider/acp/AcpSessionRuntime.ts`
- `packages/effect-acp/src/errors.ts`
