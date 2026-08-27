import { describe, expect, it } from "vite-plus/test";

import {
  HOST_OPTIMIZER_SCRIPT,
  HOST_OPTIMIZER_TIMEOUT_MS,
  HOST_OPTIMIZER_UV,
  parseHostOptimizationResult,
  probeHostOptimizationCapability,
} from "./hostOptimization.ts";

describe("hostOptimization", () => {
  it("uses only the fixed independent primitive", () => {
    expect(HOST_OPTIMIZER_UV).toBe("/home/blackbear/.local/bin/uv");
    expect(HOST_OPTIMIZER_SCRIPT).toBe(
      "/home/blackbear/T3Projects/computer-performance-improvement/scripts/speedup.py",
    );
    expect(HOST_OPTIMIZER_TIMEOUT_MS).toBe(30_000);
  });

  it("reports available only when both fixed files are executable", async () => {
    const seen: string[] = [];
    await expect(
      probeHostOptimizationCapability(
        async (path) => {
          seen.push(path);
        },
        () => "BlackBear",
      ),
    ).resolves.toEqual({ available: true });
    expect(seen).toEqual([HOST_OPTIMIZER_UV, HOST_OPTIMIZER_SCRIPT]);

    await expect(
      probeHostOptimizationCapability(
        async (path) => {
          if (path === HOST_OPTIMIZER_SCRIPT) throw new Error("missing");
        },
        () => "blackbear",
      ),
    ).resolves.toEqual({ available: false });
  });

  it("stays unavailable on a different host even when the fixed files exist", async () => {
    const seen: string[] = [];
    await expect(
      probeHostOptimizationCapability(
        async (path) => {
          seen.push(path);
        },
        () => "bigbear",
      ),
    ).resolves.toEqual({ available: false });
    expect(seen).toEqual([]);
  });

  it("decodes a bounded structured result", () => {
    expect(
      parseHostOptimizationResult(
        JSON.stringify({
          ok: true,
          changed: true,
          actions: { transcriptionPriorityUpdated: true, bluemanRestarted: false },
          before: { cpuPressureAvg10: 20, ioPressureAvg10: 3, temperatureC: 91 },
          after: { cpuPressureAvg10: 4, ioPressureAvg10: 1, temperatureC: 81 },
        }),
      ),
    ).toMatchObject({ changed: true, after: { cpuPressureAvg10: 4 } });
  });

  it("rejects unstructured output", () => {
    expect(() => parseHostOptimizationResult('{"ok":true}')).toThrow();
  });
});
