// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Isolated Node process boundary.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type CodexTurnRunnerConfig = {
  codexPath: string;
  workspacePath: string;
  codexHome: string;
  skillsPath: string;
  proxyBaseUrl: string;
  turnCredential: string;
  model: string;
  maxOutputTokens: number;
  reserveMicros: number;
  timeoutMs: number;
};
export type CodexSpawn = typeof nodeSpawn;

const toml = (value: string) => JSON.stringify(value);
const tomlSkills = (skills: ReadonlyArray<{ path: string; enabled: boolean }>) =>
  `[${skills.map((skill) => `{path=${toml(skill.path)},enabled=${skill.enabled}}`).join(",")}]`;
const validId = (value: string) =>
  value.length > 0 && value.length <= 191 && /^[a-zA-Z0-9._:-]+$/.test(value);

export class CodexTurnRunner {
  readonly config: CodexTurnRunnerConfig;
  readonly spawn: CodexSpawn;
  constructor(config: CodexTurnRunnerConfig, spawn: CodexSpawn = nodeSpawn) {
    this.config = config;
    this.spawn = spawn;
    if (!config.proxyBaseUrl.startsWith("https://") && process.env.NODE_ENV !== "test")
      throw new Error("codex_proxy_must_use_https");
    if (
      !Number.isSafeInteger(config.maxOutputTokens) ||
      config.maxOutputTokens <= 0 ||
      !Number.isSafeInteger(config.reserveMicros) ||
      config.reserveMicros <= 0 ||
      !Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 1 ||
      config.timeoutMs > 15 * 60_000
    )
      throw new Error("invalid_codex_turn_bounds");
  }
  async execute(input: { grant: string; request: Record<string, unknown> }) {
    const requestId = input.request.requestId,
      prompt = input.request.prompt;
    if (
      typeof requestId !== "string" ||
      !validId(requestId) ||
      typeof prompt !== "string" ||
      prompt.length < 1 ||
      prompt.length > 1_000_000
    )
      throw new Error("invalid_codex_turn");
    NodeFS.mkdirSync(this.config.workspacePath, { recursive: true, mode: 0o750 });
    NodeFS.mkdirSync(this.config.codexHome, { recursive: true, mode: 0o700 });
    const output = NodePath.join(this.config.codexHome, `last-${requestId}.txt`);
    const skills = NodeFS.readdirSync(this.config.skillsPath, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          NodeFS.existsSync(NodePath.join(this.config.skillsPath, entry.name, "SKILL.md")),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => ({ path: NodePath.join(this.config.skillsPath, entry.name), enabled: true }));
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--strict-config",
      "--skip-git-repo-check",
      "--json",
      "--output-last-message",
      output,
      "-C",
      this.config.workspacePath,
      "-m",
      this.config.model,
      "-s",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "-c",
      'model_provider="salvo"',
      "-c",
      'model_providers.salvo.name="Salvo"',
      "-c",
      `model_providers.salvo.base_url=${toml(this.config.proxyBaseUrl)}`,
      "-c",
      'model_providers.salvo.env_key="SALVO_TURN_CREDENTIAL"',
      "-c",
      'model_providers.salvo.wire_api="responses"',
      "-c",
      'model_providers.salvo.env_http_headers={"salvo-inference-grant"="SALVO_TURN_GRANT","salvo-parent-request-id"="SALVO_PARENT_REQUEST_ID"}',
      "-c",
      `skills.config=${tomlSkills(skills)}`,
      "-",
    ];
    const child = this.spawn(this.config.codexPath, args, {
      cwd: this.config.workspacePath,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.NODE_ENV ? { NODE_ENV: process.env.NODE_ENV } : {}),
        CODEX_HOME: this.config.codexHome,
        SALVO_TURN_CREDENTIAL: this.config.turnCredential,
        SALVO_TURN_GRANT: input.grant,
        SALVO_PARENT_REQUEST_ID: requestId,
      },
    });
    child.stdin?.end(prompt);
    await boundedExit(child, this.config.timeoutMs);
    const text = NodeFS.readFileSync(output, "utf8");
    if (!text || text.length > 4_000_000) throw new Error("invalid_codex_output");
    return { gatewayProviderReceiptId: `codex:${requestId}`, text, billedMicros: 0 };
  }
}

const boundedExit = (child: ChildProcess, timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    // Drain stderr without reflecting child-controlled output into a receipt or log.
    // Provider CLIs can echo environment-derived values in diagnostics.
    child.stderr?.resume();
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
        }, 1000).unref();
      }
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("codex_spawn_failed"));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(signal ? `codex_${signal}` : `codex_exit_${code}`));
    });
  });
