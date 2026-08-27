// @effect-diagnostics nodeBuiltinImport:off -- Fixed process boundary to an independent host primitive.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodeUtil from "node:util";

import { HostOptimizationError, HostOptimizationResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeHostOptimizationResult = Schema.decodeUnknownSync(HostOptimizationResult);

// BearT3 only bridges to this independent, project-owned deterministic primitive.
// No client input or environment variable can select an executable or script path.
export const HOST_OPTIMIZER_UV = "/home/blackbear/.local/bin/uv";
export const HOST_OPTIMIZER_SCRIPT =
  "/home/blackbear/T3Projects/computer-performance-improvement/scripts/speedup.py";
export const HOST_OPTIMIZER_TIMEOUT_MS = 30_000;

export async function probeHostOptimizationCapability(
  access: (path: string, mode: number) => Promise<void> = (path, mode) => NodeFs.access(path, mode),
  hostname: () => string = NodeOs.hostname,
): Promise<{ readonly available: boolean }> {
  if (hostname().toLocaleLowerCase() !== "blackbear") return { available: false };
  try {
    await Promise.all([
      access(HOST_OPTIMIZER_UV, NodeFs.constants.X_OK),
      access(HOST_OPTIMIZER_SCRIPT, NodeFs.constants.R_OK),
    ]);
    return { available: true };
  } catch {
    return { available: false };
  }
}

export function parseHostOptimizationResult(stdout: string): HostOptimizationResult {
  return decodeHostOptimizationResult(JSON.parse(stdout));
}

export const optimizeHost = Effect.fn("hostOptimization.optimizeHost")(function* () {
  const capability = yield* Effect.promise(() => probeHostOptimizationCapability());
  if (!capability.available) {
    return yield* new HostOptimizationError({ reason: "the Blackbear optimizer is unavailable" });
  }

  const stdout = yield* Effect.tryPromise({
    try: async () => {
      const result = await execFile(HOST_OPTIMIZER_UV, ["run", HOST_OPTIMIZER_SCRIPT, "run"], {
        timeout: HOST_OPTIMIZER_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      });
      return result.stdout;
    },
    catch: () => new HostOptimizationError({ reason: "the Blackbear optimizer did not run" }),
  });

  return yield* Effect.try({
    try: () => parseHostOptimizationResult(stdout),
    catch: () => new HostOptimizationError({ reason: "the optimizer returned an invalid result" }),
  });
});
