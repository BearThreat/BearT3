import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("rebootstrap atomically replaces runtime credentials while retaining workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "salvo-rebootstrap-"));
  const etc = join(root, "etc-salvo"),
    run = join(root, "run-salvo"),
    state = join(root, "var-salvo"),
    bin = join(root, "bin");
  for (const directory of [etc, run, state, bin]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(state, "workspace-sentinel"), "retain-me");
  for (const [name, value] of Object.entries({
    "control-secret": "old-control",
    "tunnel-token": "old-tunnel",
    "tunnel-endpoint": "https://old.invalid",
    "sandbox.env": "OLD=true\n",
  }))
    writeFileSync(join(etc, name), value);
  for (const [name, value] of Object.entries({
    "bootstrap-token": "new-token",
    "bootstrap-url": "https://relay.invalid/redeem",
    "sandbox-id": "sandbox-a",
    "user-id": "user-a",
    "client-token": "salvo-sandbox-a",
  }))
    writeFileSync(join(run, name), value);
  const curl = join(bin, "curl");
  writeFileSync(
    curl,
    `#!/bin/sh\nprintf '%s' '{"controlSecret":"${"c".repeat(32)}","tunnelToken":"${"t".repeat(32)}","tunnelEndpoint":"https://new.invalid","environment":"NEW=true\\n"}'\n`,
  );
  chmodSync(curl, 0o755);
  const source = readFileSync(resolve(import.meta.dirname, "../salvo-bootstrap.sh"), "utf8")
    .replaceAll("/etc/salvo", etc)
    .replaceAll("/run/salvo", run)
    .replaceAll("/var/lib/salvo", state)
    .replace("install -d -m 0750 -o salvo -g salvo", "install -d -m 0750")
    .replace('chown root:salvo "$staging"/*', ": test-owner");
  const script = join(root, "bootstrap.sh");
  writeFileSync(script, source);
  chmodSync(script, 0o755);
  execFileSync(script, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(readFileSync(join(etc, "control-secret"), "utf8").trim(), "c".repeat(32));
  assert.equal(readFileSync(join(etc, "tunnel-token"), "utf8").trim(), "t".repeat(32));
  assert.equal(readFileSync(join(etc, "sandbox.env"), "utf8").trim(), "NEW=true");
  assert.equal(readFileSync(join(state, "workspace-sentinel"), "utf8"), "retain-me");
  assert.throws(() =>
    execFileSync(script, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: "ignore",
    }),
  );
});
