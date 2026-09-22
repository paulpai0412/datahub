// Container entrypoint only. Preserve the official pi-web CLI and its Next/PTY
// lifecycle; transport adapters expose no control-plane credentials or APIs.
import { spawn } from "node:child_process";
import { startRuntimeRelay, startLocalEgressRelay } from "./runtime-relay.mjs";

const closeEgress = await startLocalEgressRelay(
  "/run/datahub-agent/egress.sock",
);
const closeRuntime = startRuntimeRelay({
  socketPath: "/run/datahub-agent/runtime.sock",
});
const child = spawn(
  process.execPath,
  [
    "/app/bin/pi-web.js",
    "--no-open",
    "--hostname",
    "127.0.0.1",
    "--port",
    "30141",
  ],
  {
    cwd: "/app",
    stdio: "inherit",
  },
);
let closing;
function closeTransports() {
  if (!closing) {
    closeRuntime();
    closing = closeEgress();
  }
  return closing;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void closeTransports();
    child.kill(signal); // The official CLI forwards this to Next, with a 5s grace.
  });
}
child.once("error", async () => {
  await closeTransports();
  console.error("runtime_start_failed");
  process.exitCode = 1;
});
child.once("exit", async (code, signal) => {
  await closeTransports();
  process.exitCode = code ?? (signal === "SIGTERM" ? 0 : 1);
});
