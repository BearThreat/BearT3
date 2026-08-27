import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const template = readFileSync(resolve(root, "template.yaml"), "utf8");
const controllerPath = resolve(root, "salvo-aws.mjs");
const controller = readFileSync(controllerPath, "utf8");

test("template enforces sandbox security invariants", () => {
  for (const required of [
    "SecurityGroupIngress: []",
    "AssociatePublicIpAddress: false",
    "HttpTokens: required",
    "HibernationOptions: { Configured: true }",
    "Encrypted: true",
    "VolumeType: gp3",
    "DeleteOnTermination: false",
    "AmazonSSMManagedInstanceCore",
    "aws:ResourceTag/salvo:managed",
    "ec2:LaunchTemplate",
    "AWS::Budgets::Budget",
    "AWS::CloudWatch::Alarm",
    "salvo:role, Value: control-plane",
  ])
    assert.match(template, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("launch policy and outputs expose the exact launch-template boundary", () => {
  assert.match(template, /ArnEquals:\s*\n\s*ec2:LaunchTemplate:/);
  assert.match(template, /LaunchTemplateId: \{ Value: !Ref SandboxLaunchTemplate \}/);
  assert.match(
    template,
    /LaunchTemplateVersion: \{ Value: !GetAtt SandboxLaunchTemplate.LatestVersionNumber \}/,
  );
});

test("template contains no account IDs, AMI IDs, secrets, or inbound CIDRs", () => {
  assert.doesNotMatch(template, /\b\d{12}\b|ami-[0-9a-f]{8,}|(password|secret|token):\s*[^!{\s]/i);
  assert.doesNotMatch(template, /SecurityGroupIngress:\s*\n\s*-\s/);
});

test("controller defaults to plan and guards writes", () => {
  assert.match(controller, /process\.argv\[2\] \?\? "plan"/);
  assert.match(controller, /apply is guarded/);
  assert.match(controller, /destroy requires --confirm/);
  assert.match(controller, /--no-execute-changeset/);
});

test("capabilities is discoverable before local configuration exists", () => {
  const result = spawnSync(process.execPath, [controllerPath, "capabilities"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.ok(JSON.parse(result.stdout).commands.includes("plan"));
});

test("apply and destroy fail closed without parameters", () => {
  for (const command of ["apply", "destroy"]) {
    const result = spawnSync(process.execPath, [resolve(root, "salvo-aws.mjs"), command], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /parameters\.json is required/);
  }
});
