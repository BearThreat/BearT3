import { describe, expect, it } from "vite-plus/test";

import { hostOptimizationDescription } from "./useHostOptimization";

describe("hostOptimizationDescription", () => {
  it("reports the action and bounded measurements", () => {
    expect(
      hostOptimizationDescription({
        changed: true,
        actions: { transcriptionPriorityUpdated: false, bluemanRestarted: true },
        after: { cpuPressureAvg10: 4.39, temperatureC: 81 },
      }),
    ).toBe("Restarted a runaway Bluetooth applet. 4.4% CPU pressure · 81.0°C");
  });

  it("reports an idempotent run without pretending it changed the host", () => {
    expect(
      hostOptimizationDescription({
        changed: false,
        actions: { transcriptionPriorityUpdated: false, bluemanRestarted: false },
        after: { cpuPressureAvg10: null, temperatureC: null },
      }),
    ).toBe("Performance settings were already active.");
  });
});
