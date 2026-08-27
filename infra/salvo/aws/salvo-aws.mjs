#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const template = resolve(root, "template.yaml");
const configPath = resolve(root, "parameters.json");
const command = process.argv[2] ?? "plan";
const args = new Set(process.argv.slice(3));

const fail = (message, code = 2) => {
  process.stderr.write(`${JSON.stringify({ ok: false, command, error: message })}\n`);
  process.exit(code);
};

const loadConfig = () => {
  if (!existsSync(configPath)) fail("parameters.json is required; copy parameters.example.json");
  const value = JSON.parse(readFileSync(configPath, "utf8"));
  for (const key of ["stackName", "region", "parameters"]) {
    if (!value[key]) fail(`parameters.json missing ${key}`);
  }
  if (!/^[a-z0-9-]{3,64}$/.test(value.stackName))
    fail("stackName must be lowercase letters, digits, and hyphens");
  if (!Array.isArray(value.parameters)) fail("parameters must be an array");
  return value;
};

const run = (argv, capture = false) => {
  const result = spawnSync("aws", argv, { encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error) fail(`aws CLI unavailable: ${result.error.message}`);
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout?.trim() ?? "";
};

if (command === "capabilities") {
  process.stdout.write(
    `${JSON.stringify({ ok: true, commands: ["capabilities", "status", "validate", "plan", "apply", "destroy"], default: "plan", writesRequire: "--confirm" }, null, 2)}\n`,
  );
  process.exit(0);
}

const config = loadConfig();
const parameterArgs = config.parameters.map(
  ({ key, value }) => `ParameterKey=${key},ParameterValue=${value}`,
);
const base = ["--region", config.region, "--stack-name", config.stackName];

if (command === "validate") {
  run([
    "cloudformation",
    "validate-template",
    "--template-body",
    `file://${template}`,
    "--region",
    config.region,
  ]);
} else if (command === "status") {
  const output = run(
    [
      "cloudformation",
      "describe-stacks",
      ...base,
      "--query",
      "Stacks[0].{Status:StackStatus,Updated:LastUpdatedTime,Outputs:Outputs}",
      "--output",
      "json",
    ],
    true,
  );
  process.stdout.write(`${output}\n`);
} else if (command === "plan") {
  run([
    "cloudformation",
    "deploy",
    ...base,
    "--template-file",
    template,
    "--parameter-overrides",
    ...parameterArgs,
    "--capabilities",
    "CAPABILITY_NAMED_IAM",
    "--no-execute-changeset",
    "--no-fail-on-empty-changeset",
  ]);
} else if (command === "apply") {
  if (!args.has("--confirm")) fail("apply is guarded; rerun with --confirm");
  run([
    "cloudformation",
    "deploy",
    ...base,
    "--template-file",
    template,
    "--parameter-overrides",
    ...parameterArgs,
    "--capabilities",
    "CAPABILITY_NAMED_IAM",
    "--no-fail-on-empty-changeset",
  ]);
} else if (command === "destroy") {
  const confirmation = process.argv
    .find((arg) => arg.startsWith("--confirm-stack="))
    ?.split("=")[1];
  if (!args.has("--confirm") || confirmation !== config.stackName)
    fail("destroy requires --confirm and --confirm-stack=<exact stackName>");
  run(["cloudformation", "delete-stack", ...base]);
  process.stdout.write(
    `${JSON.stringify({ ok: true, command, stackName: config.stackName, deletionStarted: true })}\n`,
  );
} else {
  fail(`unknown command: ${command}`);
}
