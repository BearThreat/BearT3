import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "sandbox-control.mjs");
const fixture = (name) => join(here, "fixtures", `${name}.json`);
const run = (...args) =>
  JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }));

test("capabilities declares local dry-run lifecycle", () => {
  const result = run("capabilities");
  assert.equal(result.data.executionEnabled, false);
  assert.equal(result.data.lifecycle.compute, "on-demand-per-user");
  assert.equal(result.data.lifecycle.idle, "hibernate-with-stop-fallback");
});

test("running healthy sandbox makes start idempotently noop", () => {
  const a = run(
    "plan-start",
    "--state",
    fixture("running"),
    "--user-id",
    "family_1",
    "--trigger",
    "app-open",
  );
  const b = run(
    "plan-start",
    "--state",
    fixture("running"),
    "--user-id",
    "family_1",
    "--trigger",
    "app-open",
  );
  assert.equal(a.data.disposition, "noop");
  assert.equal(a.data.predictive, true);
  assert.equal(a.data.idempotencyKey, b.data.idempotencyKey);
});

test("hibernated sandbox resumes instead of provisioning", () => {
  const result = run("plan-start", "--state", fixture("hibernated"), "--user-id", "family_1");
  assert.equal(result.data.disposition, "resume");
  assert.deepEqual(
    result.data.steps.map((x) => x.action),
    ["ec2-start", "verify-sandbox"],
  );
});

test("absent sandbox provisions from verified image with encrypted retained storage", () => {
  const result = run("plan-start", "--state", fixture("absent"), "--user-id", "family_2");
  assert.equal(result.data.disposition, "provision");
  assert.equal(result.data.steps[0].parameters.encrypted, true);
  assert.equal(result.data.steps[1].parameters.imageId, "ami-example");
  assert.equal(result.data.steps[1].parameters.inboundAccess, "none");
});

test("stop chooses hibernation and preserves encrypted volume", () => {
  const result = run("plan-stop", "--state", fixture("running"), "--user-id", "family_1");
  assert.equal(result.data.mode, "hibernate");
  assert.equal(result.data.preserveEncryptedVolume, true);
});

test("health requires compute, storage, image, service, and tunnel", () => {
  assert.equal(run("health", "--state", fixture("running")).data.ready, true);
  assert.equal(run("health", "--state", fixture("hibernated")).data.ready, false);
});

test("execution and cross-user state are rejected without leaking input", () => {
  const execute = spawnSync(process.execPath, [cli, "plan-start", "--execute", "yes"], {
    encoding: "utf8",
  });
  assert.equal(execute.status, 2);
  assert.equal(JSON.parse(execute.stderr).error.code, "EXECUTION_DISABLED");
  const mismatch = spawnSync(
    process.execPath,
    [cli, "plan-start", "--state", fixture("running"), "--user-id", "someone_else"],
    { encoding: "utf8" },
  );
  assert.equal(mismatch.status, 2);
  assert.equal(JSON.parse(mismatch.stderr).error.code, "USER_STATE_MISMATCH");
});
