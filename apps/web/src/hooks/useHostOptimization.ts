import { useCallback, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../components/ui/toast";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

function metric(value: number | null, suffix: string): string | null {
  return value === null ? null : `${value.toFixed(1)}${suffix}`;
}

export function hostOptimizationDescription(result: {
  readonly changed: boolean;
  readonly actions: {
    readonly transcriptionPriorityUpdated: boolean;
    readonly bluemanRestarted: boolean;
  };
  readonly after: {
    readonly cpuPressureAvg10: number | null;
    readonly temperatureC: number | null;
  };
}): string {
  const measurements = [
    metric(result.after.cpuPressureAvg10, "% CPU pressure"),
    metric(result.after.temperatureC, "°C"),
  ].filter((value): value is string => value !== null);
  const action = result.actions.bluemanRestarted
    ? "Restarted a runaway Bluetooth applet."
    : result.actions.transcriptionPriorityUpdated
      ? "Background transcription priority applied."
      : result.changed
        ? "Performance settings updated."
        : "Performance settings were already active.";
  return measurements.length > 0 ? `${action} ${measurements.join(" · ")}` : action;
}

export function useHostOptimization() {
  const environmentId = usePrimaryEnvironmentId();
  const capability = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.hostOptimizationCapability({ environmentId, input: {} }),
  );
  const optimizeHost = useAtomCommand(serverEnvironment.optimizeHost, { reportFailure: false });
  const [isRunning, setIsRunning] = useState(false);

  const run = useCallback(async () => {
    if (environmentId === null || capability.data?.available !== true || isRunning) return;
    setIsRunning(true);
    try {
      const result = await optimizeHost({ environmentId, input: {} });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Couldn’t speed up Blackbear",
          description: failure instanceof Error ? failure.message : "The optimizer failed.",
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: "Blackbear optimized",
        description: hostOptimizationDescription(result.value),
      });
    } finally {
      setIsRunning(false);
    }
  }, [capability.data?.available, environmentId, isRunning, optimizeHost]);

  return {
    available: capability.data?.available === true,
    isRunning,
    run,
  };
}
