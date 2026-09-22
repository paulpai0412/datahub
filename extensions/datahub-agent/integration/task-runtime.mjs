import { request as httpRequest } from "node:http";
import {
  createWebSessionToken,
  PI_WEB_SESSION_COOKIE,
} from "../pi-web/lib/web-auth.ts";
import { getToolNamesForPreset } from "../pi-web/lib/tool-presets.ts";
import { TaskRecordError } from "./task-records.mjs";

const sessionPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Fixed native Pi APIs over the actor's existing private runtime transport.
 * No DataHub cookie, caller-selected endpoint, credential discovery or retries.
 */
export function taskRuntime(runtime, assertActive) {
  let target;
  try {
    target = new URL(runtime.origin);
  } catch {
    throw new TaskRecordError("invalid_task_runtime", 503);
  }
  if (
    target.protocol !== "http:" ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash ||
    typeof runtime.password !== "string" ||
    runtime.password.length < 32
  )
    throw new TaskRecordError("invalid_task_runtime", 503);
  async function call(path, method, value) {
    assertActive();
    const signal = AbortSignal.timeout(30000);
    let socket;
    try {
      socket = await runtime.openSocket?.(signal);
      assertActive();
      return await new Promise((resolve, reject) => {
        const request = httpRequest({
          hostname: target.hostname,
          port: target.port || 80,
          path,
          method,
          ...(socket ? { createConnection: () => socket } : {}),
          signal,
          headers: {
            host: target.host,
            origin: target.origin,
            "content-type": "application/json",
            cookie: `${PI_WEB_SESSION_COOKIE}=${createWebSessionToken(runtime.password)}`,
          },
        });
        request.on("error", reject);
        request.on("response", (response) => {
          const chunks = [];
          let bytes = 0;
          response.on("error", reject);
          response.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 1048576)
              response.destroy(new Error("oversized_runtime_response"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              assertActive();
              if (response.statusCode !== 200)
                throw new Error("runtime_request_failed");
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (error) {
              reject(error);
            }
          });
        });
        request.end(value === undefined ? undefined : JSON.stringify(value));
      });
    } catch {
      throw new TaskRecordError("task_runtime_unconfirmed", 502);
    } finally {
      socket?.destroy();
    }
  }
  function path(sessionId) {
    if (!sessionPattern.test(sessionId))
      throw new TaskRecordError("invalid_task_session", 400);
    return `/api/agent/${sessionId}`;
  }
  async function command(sessionId, body) {
    const result = await call(path(sessionId), "POST", body);
    if (result.success !== true)
      throw new TaskRecordError("task_runtime_unconfirmed", 502);
    return result.data;
  }
  return {
    async createSession() {
      const { cwd } = await call("/api/default-cwd", "POST", {});
      if (typeof cwd !== "string")
        throw new TaskRecordError("task_runtime_unconfirmed", 502);
      // Native toolNames selects built-ins; its existing loader adds extensions.
      const result = await call("/api/agent/new", "POST", {
        cwd,
        type: "ensure_session",
        toolNames: getToolNamesForPreset("read-only"),
      });
      if (result.success !== true || !sessionPattern.test(result.sessionId))
        throw new TaskRecordError("task_runtime_unconfirmed", 502);
      return result.sessionId;
    },
    state: (sessionId) => call(path(sessionId), "GET"),
    name: (sessionId, name) =>
      command(sessionId, { type: "set_session_name", name }),
    prompt: (sessionId, message) =>
      command(sessionId, { type: "prompt", message }),
    async stop(sessionId) {
      // GET never reconstructs a session. Do not reload an already-absent idle
      // wrapper merely to stop it (POST would reload or return session 404).
      const before = await call(path(sessionId), "GET");
      if (before.running === false) return { stopObserved: true };
      await command(sessionId, { type: "clear_queue" });
      await command(sessionId, { type: "abort" });
      const result = await call(path(sessionId), "GET");
      const state = result.state;
      return {
        stopObserved:
          result.running === false ||
          (result.running === true &&
            state?.sessionId === sessionId &&
            state.isStreaming === false &&
            state.isPromptRunning === false &&
            state.isBashRunning === false &&
            state.isCompacting === false &&
            state.pendingMessageCount === 0),
      };
    },
  };
}
