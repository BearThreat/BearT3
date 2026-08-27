# Salvo sandbox lifecycle controller

This local controller converts observed sandbox state into deterministic AWS lifecycle plans. It never calls AWS and rejects `--execute`; every plan is a dry run.

```bash
node infra/salvo/sandbox-control.mjs capabilities
node infra/salvo/sandbox-control.mjs status --state infra/salvo/test/fixtures/running.json
node infra/salvo/sandbox-control.mjs plan-start --state infra/salvo/test/fixtures/hibernated.json --user-id family_1 --trigger app-open
node infra/salvo/sandbox-control.mjs plan-stop --state infra/salvo/test/fixtures/running.json --user-id family_1 --reason idle-timeout
node infra/salvo/sandbox-control.mjs health --state infra/salvo/test/fixtures/running.json
```

The observed-state contract is `state.schema.json`. Output is one JSON object on stdout. Errors are one JSON object on stderr and exit with code 2. Plan idempotency keys are stable for the same state and request.

Start policy: resume a stopped or hibernated sandbox; otherwise provision from a verified cached AMI and attach retained encrypted EBS. Starting on app open, login, or notification is marked predictive. Stop policy: drain the agent and hibernate when configured, with ordinary EC2 stop as the fallback. All access is modeled as outbound tunnel only.

## Infrastructure registry

Mutable provider summaries live in `state/infra-state.sqlite`; `state/infra-state.json` and `public/provider-registry.html` are generated views. The AWS adapters are read-only, time-bounded, and emit allowlisted summaries without account IDs, network addresses, tags, or credentials.

```bash
uv run infra/salvo/scripts/infra_state.py init
uv run infra/salvo/scripts/infra_state.py refresh
uv run infra/salvo/scripts/infra_state.py export
uv run infra/salvo/scripts/infra_state.py list
uv run infra/salvo/scripts/infra_state.py render
```

`refresh` records adapter failures and preserves the last successful summary. AWS status covers only instances tagged `Application=Salvo`; cost covers the same tag for the current trailing seven-day window.
