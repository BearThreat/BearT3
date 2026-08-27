import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "salvo-bootstrap.sh");
const service = readFileSync(resolve(root, "systemd/salvo-bootstrap.service"), "utf8");

test("bootstrap script and service keep credentials private", () => {
  assert.equal(statSync(script).mode & 0o777, 0o755);
  const source = readFileSync(script, "utf8");
  assert.match(source, /umask 077/);
  assert.match(source, /\.tunnelToken/);
  assert.match(source, /chmod 0640 "\$staging"\/\*/);
  assert.match(source, /mv -f "\$staging\/\$name" "\/etc\/salvo\/\$name"/);
  assert.match(source, /shred -u/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ReadWritePaths=\/etc\/salvo \/run\/salvo \/var\/lib\/salvo/);
  assert.doesNotMatch(service, /ConditionPathExists/);
});
