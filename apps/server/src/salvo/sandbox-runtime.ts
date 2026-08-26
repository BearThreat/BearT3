import {
  loadSandboxPromptRuntimeConfig,
  serveSandboxPromptRuntime,
} from "./SandboxPromptRuntime.js";

const service = serveSandboxPromptRuntime(loadSandboxPromptRuntimeConfig(process.env));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void service.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
