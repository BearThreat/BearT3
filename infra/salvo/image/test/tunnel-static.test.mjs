import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const tunnel = readFileSync(resolve(root, "systemd/salvo-tunnel.service"), "utf8");
const readiness = readFileSync(resolve(root, "systemd/salvo-readiness.service"), "utf8");
const probe = readFileSync(resolve(root, "readiness-check.sh"), "utf8");
const release = JSON.parse(readFileSync(resolve(root, "cloudflared-release.json"), "utf8"));

test("outbound tunnel is pinned, loopback-bound, durable, and token-file based", () => {
  assert.equal(release.version, "2026.5.2");
  assert.match(release.sha256, /^[a-f0-9]{64}$/);
  assert.match(tunnel, /--metrics 127\.0\.0\.1:49312/);
  assert.match(tunnel, /--token-file \/etc\/salvo\/tunnel-token/);
  assert.doesNotMatch(tunnel, /TUNNEL_TOKEN=/);
  assert.match(tunnel, /Restart=on-failure/);
  assert.match(tunnel, /Requires=salvo-bootstrap\.service salvo\.service/);
});

test("sandbox readiness requires both receiver and registered tunnel", () => {
  assert.match(readiness, /Requires=salvo\.service salvo-tunnel\.service/);
  assert.match(probe, /127\.0\.0\.1:4318\/ready/);
  assert.match(probe, /127\.0\.0\.1:49312\/ready/);
});
