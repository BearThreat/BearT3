// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { CodexTurnRunner, type CodexTurnRunnerConfig } from "./CodexTurnRunner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const setup = (source: string, timeoutMs = 2_000) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "salvo-codex-runner-"));
  dirs.push(dir);
  const executable = NodePath.join(dir, "fake-codex.mjs");
  NodeFS.writeFileSync(executable, `#!/usr/bin/env node\n${source}`);
  NodeFS.chmodSync(executable, 0o750);
  const skillsPath = NodePath.join(dir, "skills");
  for (const name of ["zeta", "alpha"]) {
    NodeFS.mkdirSync(NodePath.join(skillsPath, name), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(skillsPath, name, "SKILL.md"), `# ${name}`);
  }
  const config: CodexTurnRunnerConfig = {
    codexPath: executable,
    workspacePath: NodePath.join(dir, "workspace"),
    codexHome: NodePath.join(dir, "codex-home"),
    skillsPath,
    proxyBaseUrl: "https://relay.test/v1",
    turnCredential: "credential-must-stay-in-env",
    model: "gpt-test",
    maxOutputTokens: 321,
    reserveMicros: 654,
    timeoutMs,
  };
  return { dir, config, runner: new CodexTurnRunner(config) };
};

describe("CodexTurnRunner", () => {
  test("runs bounded Codex exec with valid custom-provider and deterministic skills overrides", async () => {
    const context = setup(`
import fs from "node:fs"; import path from "node:path";
const args = process.argv.slice(2); const output = args[args.indexOf("--output-last-message") + 1];
let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;
fs.writeFileSync(path.join(process.cwd(), "created-by-codex.txt"), "durable workspace output");
fs.writeFileSync(path.join(process.cwd(), "invocation.json"), JSON.stringify({ args, prompt, env: {
  credential: process.env.SALVO_TURN_CREDENTIAL, grant: process.env.SALVO_TURN_GRANT, request: process.env.SALVO_PARENT_REQUEST_ID
} }));
fs.writeFileSync(output, "completed response");
`);
    const result = await context.runner.execute({
      grant: "grant-must-stay-in-env",
      request: { requestId: "request-1", prompt: "make the file" },
    });
    expect(result).toEqual({
      gatewayProviderReceiptId: "codex:request-1",
      text: "completed response",
      billedMicros: 0,
    });
    expect(
      NodeFS.readFileSync(
        NodePath.join(context.config.workspacePath, "created-by-codex.txt"),
        "utf8",
      ),
    ).toBe("durable workspace output");
    const invocation = JSON.parse(
      NodeFS.readFileSync(NodePath.join(context.config.workspacePath, "invocation.json"), "utf8"),
    ) as { args: string[]; prompt: string; env: Record<string, string> };
    expect(invocation.env).toEqual({
      credential: context.config.turnCredential,
      grant: "grant-must-stay-in-env",
      request: "request-1",
    });
    expect(invocation.prompt).toBe("make the file");
    expect(invocation.args.at(-1)).toBe("-");
    expect(invocation.args.join(" ")).not.toContain(context.config.turnCredential);
    expect(invocation.args.join(" ")).not.toContain("grant-must-stay-in-env");
    expect(invocation.args).toContain("--ephemeral");
    expect(invocation.args).toContain("--strict-config");
    expect(invocation.args).toContain('model_provider="salvo"');
    expect(invocation.args).toContain('model_providers.salvo.base_url="https://relay.test/v1"');
    expect(invocation.args).toContain('model_providers.salvo.wire_api="responses"');
    const skills = invocation.args.find((value) => value.startsWith("skills.config="));
    expect(skills).toBe(
      `skills.config=[{path=${JSON.stringify(NodePath.join(context.config.skillsPath, "alpha"))},enabled=true},{path=${JSON.stringify(NodePath.join(context.config.skillsPath, "zeta"))},enabled=true}]`,
    );
  });

  test("returns an opaque error on nonzero exit without reflecting stderr secrets", async () => {
    const context = setup(
      `process.stderr.write(process.env.SALVO_TURN_CREDENTIAL ?? ""); process.exit(23);`,
    );
    await expect(
      context.runner.execute({
        grant: "secret-grant",
        request: { requestId: "request-2", prompt: "fail" },
      }),
    ).rejects.toThrow("codex_exit_23");
    try {
      await context.runner.execute({
        grant: "secret-grant",
        request: { requestId: "request-3", prompt: "fail" },
      });
    } catch (error) {
      expect(String(error)).not.toContain(context.config.turnCredential);
      expect(String(error)).not.toContain("secret-grant");
    }
  });

  test("times out and terminates the detached process group", async () => {
    const markerName = "grandchild-terminated";
    const context = setup(
      `
import fs from "node:fs"; import path from "node:path"; import { spawn } from "node:child_process";
const marker = path.join(process.cwd(), ${JSON.stringify(markerName)});
spawn(process.execPath, ["-e", \`const fs=require("fs"); process.on("SIGTERM",()=>{fs.writeFileSync(\${JSON.stringify(marker)},"terminated");process.exit(0)});setInterval(()=>{},10000)\`], { stdio: "ignore" });
process.on("SIGTERM", () => { const check = setInterval(() => { if (fs.existsSync(marker)) { clearInterval(check); process.exit(143); } }, 5); });
setInterval(() => {}, 10_000);
`,
      300,
    );
    const started = Date.now();
    await expect(
      context.runner.execute({
        grant: "grant",
        request: { requestId: "request-timeout", prompt: "hang" },
      }),
    ).rejects.toThrow(/codex_(SIGTERM|SIGKILL|exit_143)/);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(
      NodeFS.readFileSync(NodePath.join(context.config.workspacePath, markerName), "utf8"),
    ).toBe("terminated");
  });
});
