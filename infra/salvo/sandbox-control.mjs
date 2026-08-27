#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const VERSION = "0.1.0";
const COMMANDS = ["capabilities", "status", "plan-start", "plan-stop", "health"];
const USER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INSTANCE_STATES = new Set([
  "absent",
  "pending",
  "running",
  "stopping",
  "stopped",
  "hibernating",
  "hibernated",
  "terminated",
  "unknown",
]);

class CliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.includes(command))
    throw new CliError("INVALID_COMMAND", `Expected one of: ${COMMANDS.join(", ")}`);
  const values = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--"))
      throw new CliError("INVALID_ARGUMENT", `Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "execute")
      throw new CliError("EXECUTION_DISABLED", "This local controller only creates dry-run plans");
    const next = argv[i + 1];
    if (!next || next.startsWith("--"))
      throw new CliError("MISSING_VALUE", `Missing value for --${key}`);
    if (values[key] !== undefined)
      throw new CliError("DUPLICATE_ARGUMENT", `Duplicate argument: --${key}`);
    values[key] = next;
    i += 1;
  }
  return { command, values };
}

function readState(path) {
  if (!path) return emptyState();
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError("STATE_READ_FAILED", "State file is missing or invalid JSON", {
      path,
      reason: error.code ?? "INVALID_JSON",
    });
  }
  return validateState(raw);
}

function emptyState() {
  return {
    schemaVersion: 1,
    userId: null,
    instance: { id: null, state: "absent", hibernationConfigured: false },
    volume: { id: null, attached: false, encrypted: true },
    image: { id: null, release: null, verified: false },
    service: { ready: false, tunnelConnected: false, checkedAt: null },
  };
}

function validateState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new CliError("INVALID_STATE", "State must be an object");
  if (raw.schemaVersion !== 1)
    throw new CliError("UNSUPPORTED_STATE_VERSION", "Only state schemaVersion 1 is supported");
  const state = structuredClone(raw);
  if (state.userId !== null && !USER_ID.test(state.userId ?? ""))
    throw new CliError("INVALID_STATE", "state.userId is invalid");
  if (!state.instance || !INSTANCE_STATES.has(state.instance.state))
    throw new CliError("INVALID_STATE", "instance.state is invalid");
  for (const [path, value] of [
    ["instance.hibernationConfigured", state.instance.hibernationConfigured],
    ["volume.attached", state.volume?.attached],
    ["volume.encrypted", state.volume?.encrypted],
    ["image.verified", state.image?.verified],
    ["service.ready", state.service?.ready],
    ["service.tunnelConnected", state.service?.tunnelConnected],
  ])
    if (typeof value !== "boolean") throw new CliError("INVALID_STATE", `${path} must be boolean`);
  return state;
}

function requireUser(values, state) {
  const userId = values["user-id"] ?? state.userId;
  if (!USER_ID.test(userId ?? ""))
    throw new CliError("INVALID_USER_ID", "--user-id must match [a-z0-9][a-z0-9_-]{0,63}");
  if (state.userId && state.userId !== userId)
    throw new CliError("USER_STATE_MISMATCH", "State belongs to a different user");
  return userId;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function step(id, action, when, parameters = {}) {
  return { id, action, when, parameters };
}

function planStart(userId, state, values) {
  const trigger = values.trigger ?? "app-open";
  if (!["app-open", "login", "notification", "prompt"].includes(trigger))
    throw new CliError(
      "INVALID_TRIGGER",
      "trigger must be app-open, login, notification, or prompt",
    );
  const instanceState = state.instance.state;
  let disposition;
  let steps;
  if (instanceState === "running" && state.service.ready && state.service.tunnelConnected) {
    disposition = "noop";
    steps = [];
  } else if (["pending", "stopping", "hibernating"].includes(instanceState)) {
    disposition = "wait";
    steps = [
      step("observe-transition", "observe-instance", `instance.state == ${instanceState}`, {
        timeoutSeconds: 90,
      }),
    ];
  } else if (instanceState === "hibernated" || instanceState === "stopped") {
    disposition = "resume";
    steps = [
      step("start-instance", "ec2-start", `instance.state == ${instanceState}`, {
        instanceId: state.instance.id,
      }),
      step("verify-ready", "verify-sandbox", "instance.state == running", {
        requireTunnel: true,
        timeoutSeconds: 60,
      }),
    ];
  } else if (["absent", "terminated", "unknown"].includes(instanceState)) {
    if (!state.image.id || !state.image.verified)
      throw new CliError(
        "NO_VERIFIED_IMAGE",
        "A verified cached image is required to provision a sandbox",
      );
    disposition = "provision";
    steps = [
      step("ensure-volume", "ensure-encrypted-ebs", "no attached retained volume", {
        encrypted: true,
        userId,
      }),
      step("launch-instance", "ec2-run-from-image", "no resumable instance", {
        imageId: state.image.id,
        volumeMode: "attach-retained",
        hibernationPreferred: true,
        inboundAccess: "none",
      }),
      step("verify-ready", "verify-sandbox", "instance.state == running", {
        requireEncryptedVolume: true,
        requireTunnel: true,
        timeoutSeconds: 60,
      }),
    ];
  } else {
    throw new CliError("START_NOT_ALLOWED", `Cannot start from state ${instanceState}`);
  }
  const body = {
    operation: "start",
    userId,
    trigger,
    predictive: trigger !== "prompt",
    disposition,
    dryRun: true,
    steps,
  };
  return { ...body, idempotencyKey: digest(body) };
}

function planStop(userId, state, values) {
  const reason = values.reason ?? "idle-timeout";
  if (!["idle-timeout", "operator", "budget-cap", "user-request"].includes(reason))
    throw new CliError(
      "INVALID_REASON",
      "reason must be idle-timeout, operator, budget-cap, or user-request",
    );
  const current = state.instance.state;
  let disposition;
  let mode = null;
  let steps = [];
  if (["absent", "stopped", "hibernated", "terminated"].includes(current)) disposition = "noop";
  else if (["stopping", "hibernating"].includes(current)) {
    disposition = "wait";
    steps = [
      step("observe-transition", "observe-instance", `instance.state == ${current}`, {
        timeoutSeconds: 90,
      }),
    ];
  } else if (current === "running") {
    disposition = "suspend";
    mode = state.instance.hibernationConfigured ? "hibernate" : "stop";
    steps = [
      step("drain-agent", "drain-agent", "service may accept work", { timeoutSeconds: 20 }),
      step(
        "suspend-instance",
        mode === "hibernate" ? "ec2-hibernate" : "ec2-stop",
        "agent drained",
        { instanceId: state.instance.id },
      ),
      step("verify-suspended", "verify-instance", `requested ${mode}`, {
        expectedState: mode === "hibernate" ? "hibernated" : "stopped",
        timeoutSeconds: 90,
      }),
    ];
  } else throw new CliError("STOP_NOT_ALLOWED", `Cannot stop from state ${current}`);
  const body = {
    operation: "stop",
    userId,
    reason,
    disposition,
    mode,
    preserveEncryptedVolume: true,
    dryRun: true,
    steps,
  };
  return { ...body, idempotencyKey: digest(body) };
}

function health(state) {
  const checks = {
    instanceRunning: state.instance.state === "running",
    encryptedVolume: state.volume.encrypted && state.volume.attached,
    verifiedImage: state.image.verified,
    serviceReady: state.service.ready,
    tunnelConnected: state.service.tunnelConnected,
  };
  const ready = Object.values(checks).every(Boolean);
  return {
    ready,
    status: ready ? "healthy" : "not-ready",
    checks,
    checkedAt: state.service.checkedAt,
    source: "provided-state",
  };
}

function output(command, data) {
  process.stdout.write(`${JSON.stringify({ ok: true, command, version: VERSION, data })}\n`);
}

function main() {
  try {
    const { command, values } = parseArgs(process.argv.slice(2));
    if (command === "capabilities")
      return output(command, {
        commands: COMMANDS,
        executionEnabled: false,
        dryRunDefault: true,
        lifecycle: {
          compute: "on-demand-per-user",
          storage: "encrypted-ebs-retained",
          startup: "verified-cached-ami",
          idle: "hibernate-with-stop-fallback",
          access: "outbound-tunnel-only",
          predictiveTriggers: ["app-open", "login", "notification"],
        },
      });
    const state = readState(values.state);
    if (command === "status") return output(command, { state, health: health(state) });
    if (command === "health") return output(command, health(state));
    const userId = requireUser(values, state);
    if (command === "plan-start") return output(command, planStart(userId, state, values));
    if (command === "plan-stop") return output(command, planStop(userId, state, values));
  } catch (error) {
    const known = error instanceof CliError;
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { code: known ? error.code : "INTERNAL_ERROR", message: known ? error.message : "Unexpected failure", details: known ? error.details : {} } })}\n`,
    );
    process.exitCode = known ? 2 : 1;
  }
}

main();
