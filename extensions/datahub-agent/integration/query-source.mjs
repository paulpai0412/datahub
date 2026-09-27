import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryError, rejectQuery, exactKeys } from "./query-metadata.mjs";
const python = fileURLToPath(
  new URL("../../../.venv/bin/python", import.meta.url),
);
const script = fileURLToPath(new URL("./query_runner.py", import.meta.url));

/** Secret/connection transport, not a store: only an explicitly configured
 * protected Host file, never a path/URL supplied by metadata or a tool. */
export async function readQuerySecret(path, json = true) {
  if (typeof path !== "string" || !isAbsolute(path))
    rejectQuery("query_connection_unavailable", 503);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      info.mode & 0o077 ||
      info.size < 1 ||
      info.size > 16384
    )
      throw new Error();
    const value = await file.readFile("utf8");
    return json ? JSON.parse(value) : value.trim();
  } catch {
    rejectQuery("query_connection_unavailable", 503);
  } finally {
    await file?.close();
  }
}

export function queryBindings(value = []) {
  if (!Array.isArray(value) || value.length > 128)
    throw new Error("query_configuration_invalid");
  const ids = new Set();
  return value.map((b) => {
    if (
      !exactKeys(b, [
        "id",
        "tenant",
        "platform",
        "platformInstanceUrn",
        "environment",
        "database",
        "datasetPrefix",
        "connectionPath",
      ]) ||
      ["id", "tenant", "environment", "database"].some(
        (k) => typeof b[k] !== "string" || !b[k] || b[k].length > 256,
      ) ||
      ids.has(b.id) ||
      !["mssql", "oracle", "postgres", "mysql"].includes(b.platform) ||
      !(
        b.platformInstanceUrn === null ||
        (typeof b.platformInstanceUrn === "string" &&
          /^urn:li:dataPlatformInstance:[^\x00-\x1f]{1,1000}$/.test(
            b.platformInstanceUrn,
          ))
      ) ||
      typeof b.datasetPrefix !== "string" ||
      b.datasetPrefix.length > 256 ||
      (b.datasetPrefix !== "" && !b.datasetPrefix.endsWith(".")) ||
      typeof b.connectionPath !== "string" ||
      !isAbsolute(b.connectionPath)
    )
      throw new Error("query_configuration_invalid");
    ids.add(b.id);
    return Object.freeze({ ...b });
  });
}

export function resolveQueryBinding(snapshots, bindings, actor) {
  const selected = snapshots.map((s) => {
    const matches = bindings.filter(
      (b) =>
        b.tenant === actor.tenant &&
        b.platform === s.platform &&
        b.platformInstanceUrn === s.platformInstanceUrn &&
        b.environment === s.environment &&
        typeof s.qualifiedName === "string" &&
        s.qualifiedName.startsWith(b.datasetPrefix) &&
        (s.platform === "oracle" ||
          s.qualifiedName.slice(b.datasetPrefix.length).split(".")[0] ===
            b.database),
    );
    if (matches.length !== 1)
      rejectQuery(
        matches.length
          ? "query_connection_ambiguous"
          : "query_connection_unavailable",
        422,
      );
    return matches[0];
  });
  if (!selected.length || selected.some((b) => b !== selected[0]))
    rejectQuery("query_cross_source_unsupported", 422);
  return selected[0];
}

/** One bounded child; cancellation drains it before admission is released.
 * No shell, retry, driver text in logs, inherited credentials or user HOME. */
export function runQueryChild(payload, { signal, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new QueryError("query_cancelled", 409));
    const child = spawnProcess(python, ["-I", "-B", script], {
      cwd: "/",
      shell: false,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/dev/null" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0,
      errorCode,
      force;
    function stop(code) {
      errorCode ??= code;
      child.kill("SIGTERM");
      force ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    }
    const cancelled = () => stop("query_cancelled");
    signal?.addEventListener("abort", cancelled, { once: true });
    const timer = setTimeout(
      () => stop("query_execution_unconfirmed"),
      payload.operation === "compile" ? 15000 : 40000,
    );
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1048576) stop("query_result_too_large");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1048576) stop("query_execution_unconfirmed");
    });
    child.stdin.on("error", () => {
      errorCode ??= "query_execution_unconfirmed";
    });
    child.once("error", () => {
      errorCode = "query_driver_unavailable";
    });
    child.once("close", (code, killed) => {
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener("abort", cancelled);
      if (errorCode || killed)
        return reject(
          new QueryError(errorCode ?? "query_execution_unconfirmed", 502),
        );
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (result.error && /^query_[a-z_]{1,60}$/.test(result.error))
          return reject(
            new QueryError(
              result.error,
              result.error === "query_source_denied" ? 403 : 422,
            ),
          );
        if (code !== 0) throw new Error();
        resolve(result);
      } catch {
        reject(new QueryError("query_execution_unconfirmed", 502));
      }
    });
    if (signal?.aborted) cancelled();
    child.stdin.end(JSON.stringify(payload));
  });
}

export function createQuerySource({
  getConnection = (b) => readQuerySecret(b.connectionPath),
  run = runQueryChild,
} = {}) {
  const publicBinding = (b) =>
    Object.fromEntries(
      Object.entries(b).filter(([k]) => k !== "connectionPath"),
    );
  return {
    compile: (plan, metadata, binding, context) =>
      run(
        {
          operation: "compile",
          plan,
          metadata,
          binding: publicBinding(binding),
        },
        context,
      ),
    async execute(plan, metadata, binding, context) {
      context.assertActive();
      const connection = await getConnection(binding);
      context.assertActive();
      return run(
        {
          operation: "execute",
          plan,
          metadata,
          binding: publicBinding(binding),
          connection,
        },
        context,
      );
    },
  };
}
