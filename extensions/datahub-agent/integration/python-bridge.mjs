import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const python = fileURLToPath(new URL("../../../.venv/bin/python", import.meta.url));
const scripts = Object.freeze({
  discovery: fileURLToPath(new URL("../../dataflow-discovery/src/dataflow_discovery/bridge.py", import.meta.url)),
  semanticCheckpoint: fileURLToPath(new URL("./semantic_checkpoint.py", import.meta.url)),
});

/** Existing Host subprocess transport, shared by fixed adapters only.
 * No shell, credentials, operator HOME, dynamic script path or captured source execution.
 * Callers own their bounded input/output schemas and domain-specific error projection.
 */
export function invokePythonBridge(kind, payload, maxBuffer) {
  if (!Object.hasOwn(scripts, kind)) throw new Error("invalid_python_bridge");
  return new Promise((resolve) => {
    const child = execFile(python, ["-I", "-B", scripts[kind]], {
      timeout: 30000,
      killSignal: "SIGKILL",
      maxBuffer,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/dev/null", DATAHUB_TELEMETRY_ENABLED: "false" },
    }, (error, stdout) => resolve({ failed: Boolean(error), stdout }));
    child.stdin.on("error", () => { /* execFile completion reports failure. */ });
    child.stdin.end(JSON.stringify(payload));
  });
}
