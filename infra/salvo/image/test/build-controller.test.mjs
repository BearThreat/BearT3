import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const controller = join(root, "build-controller.mjs");
function fixture() {
  const dir = join(tmpdir(), `salvo-image-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const server = join(dir, "sandbox-runtime.mjs");
  const node = join(dir, "node");
  const codex = join(dir, "codex");
  const skills = join(dir, "skills");
  const output = join(dir, "output");
  const cloudflared = join(dir, "cloudflared");
  const cloudflaredRelease = join(dir, "cloudflared-release.json");
  mkdirSync(join(codex, "bin"), { recursive: true });
  mkdirSync(join(codex, "node_modules/@openai/codex-linux-x64/vendor/test/bin"), {
    recursive: true,
  });
  mkdirSync(join(skills, "example"), { recursive: true });
  writeFileSync(server, "export const ready = true;\n");
  writeFileSync(node, "#!/bin/sh\nexit 0\n");
  chmodSync(node, 0o755);
  writeFileSync(cloudflared, "#!/bin/sh\nexit 0\n");
  chmodSync(cloudflared, 0o755);
  writeFileSync(
    cloudflaredRelease,
    JSON.stringify({
      schemaVersion: 1,
      version: "test",
      platform: "linux-x64",
      sha256: createHash("sha256").update(readFileSync(cloudflared)).digest("hex"),
    }),
  );
  writeFileSync(
    join(codex, "package.json"),
    JSON.stringify({ name: "@openai/codex", version: "test" }),
  );
  writeFileSync(join(codex, "bin/codex.js"), "#!/usr/bin/env node\n");
  writeFileSync(
    join(codex, "node_modules/@openai/codex-linux-x64/vendor/test/bin/codex"),
    "#!/bin/sh\n",
  );
  chmodSync(join(codex, "node_modules/@openai/codex-linux-x64/vendor/test/bin/codex"), 0o755);
  writeFileSync(join(skills, "example/SKILL.md"), "# Example\n");
  const args = [
    controller,
    "stage",
    "--server-bundle",
    server,
    "--node",
    node,
    "--codex",
    join(codex, "bin/codex.js"),
    "--cloudflared",
    cloudflared,
    "--cloudflared-release",
    cloudflaredRelease,
    "--skills-dir",
    skills,
    "--output",
    output,
  ];
  return { dir, server, node, codex, cloudflared, cloudflaredRelease, skills, output, args };
}
function run(args, ok = true) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (ok) assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0);
  return result;
}
function mutateAndReject(relativePath, mutation) {
  const f = fixture();
  try {
    run(f.args);
    mutation(join(f.output, "rootfs", relativePath));
    const result = run([controller, "validate", ...f.args.slice(2)], false);
    assert.match(result.stderr, /artifact|executable|missing|mismatch/i);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}

test("capabilities promises no AWS mutation or apply", () => {
  const value = JSON.parse(
    execFileSync(process.execPath, [controller, "capabilities"], { encoding: "utf8" }),
  );
  assert.equal(value.awsMutation, false);
  assert.equal(value.applySupported, false);
  assert.deepEqual(value.commands, ["capabilities", "plan", "stage", "validate", "status"]);
});

test("stages and independently validates the complete payload", () => {
  const f = fixture();
  try {
    const value = JSON.parse(run(f.args).stdout);
    assert.equal(value.valid, true);
    assert.ok(value.fileCount > 10);
    const firstHash = value.manifestSha256;
    assert.equal(JSON.parse(run(f.args).stdout).manifestSha256, firstHash);
    assert.equal(JSON.parse(run([controller, "status", ...f.args.slice(2)]).stdout).valid, true);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("missing bundle fails closed", () => {
  const f = fixture();
  try {
    rmSync(f.server);
    assert.match(run(f.args, false).stderr, /missing server bundle/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("missing Node and Codex fail closed", () => {
  const f = fixture();
  try {
    chmodSync(f.node, 0o644);
    assert.match(run(f.args, false).stderr, /node runtime/);
    chmodSync(f.node, 0o755);
    rmSync(join(f.codex, "bin/codex.js"));
    assert.match(run(f.args, false).stderr, /Codex package/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("missing or tampered cloudflared fails closed", () => {
  const f = fixture();
  try {
    chmodSync(f.cloudflared, 0o644);
    assert.match(run(f.args, false).stderr, /cloudflared binary/);
    chmodSync(f.cloudflared, 0o755);
    writeFileSync(f.cloudflared, "tampered");
    assert.match(run(f.args, false).stderr, /cloudflared binary/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("validation catches removed units, changed hashes, config and executable bits", () => {
  mutateAndReject("etc/systemd/system/salvo.service", (path) => rmSync(path));
  mutateAndReject("opt/salvo/server/dist/sandbox-runtime.mjs", (path) =>
    writeFileSync(path, "tampered"),
  );
  mutateAndReject("opt/salvo/image/image-manifest.json", (path) => writeFileSync(path, "{}"));
  mutateAndReject("opt/salvo/runtime/node/bin/node", (path) => chmodSync(path, 0o644));
});

test("validation catches a missing skill bundle", () => {
  mutateAndReject("opt/salvo/skills/library/example/SKILL.md", (path) => rmSync(path));
});
