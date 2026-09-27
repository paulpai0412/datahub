import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  rm,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqlError } from "./native-sql.mjs";

const python = fileURLToPath(
  new URL("../../../.venv/bin/python", import.meta.url),
);
const packageRoot = new URL(
  "../../sales-datamart/src/sales_datamart/",
  import.meta.url,
);
const bundleNames = ["__init__.py", "agent_query.py", "sql_cli.py"];
const approvedQuerySha256 =
  "5cb70f081f4210c9f947c6e7034f412316a65510ddc643aca6a09928932c22cc";
const bootstrap =
  "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('sales_datamart.sql_cli',run_name='__main__')";
const fail = () => {
  throw new SqlError("sql_execution_unconfirmed", 502);
};

/** Resolve only the reporting login secret at the trusted Host boundary. */
export function protectedSalesPassword(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new SqlError("sql_not_configured", 503);
  return async () => {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0 ||
        info.size < 1 ||
        info.size > 16384
      )
        fail();
      const content = await file.readFile("utf8");
      const matching = content
        .split(/\r?\n/)
        .filter((line) => line.startsWith("SALESDATAMART_GRAFANA_PASSWORD="));
      if (matching.length !== 1) fail();
      let value = matching[0]
        .slice("SALESDATAMART_GRAFANA_PASSWORD=".length)
        .trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      if (!value || value.length > 1024) fail();
      return value;
    } catch {
      fail();
    } finally {
      await file?.close();
    }
  };
}

/** Trusted Host source executor. The operator supplies ONLY the reporting login's
 * protected secret resolver; browser/model cannot select SQL, login or endpoint.
 * Output and stderr are bounded and never echoed to a Pi session or ordinary log. */
export function createSalesSourceExecutor({
  getPassword,
  spawnProcess = spawn,
} = {}) {
  if (typeof getPassword !== "function" || typeof spawnProcess !== "function")
    throw new SqlError("sql_not_configured", 503);
  return async function executeSource(intent, context) {
    context.assertActive();
    let directory,
      child,
      closed = false,
      timer,
      forceTimer,
      abortHandler;
    let exitPromise;
    const stop = () => {
      if (!child || closed) return;
      child.kill("SIGTERM");
      forceTimer ??= setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 5000);
    };
    try {
      directory = await mkdtemp(join(tmpdir(), "datahub-sales-sql-"));
      const frozen = join(directory, "sales_datamart");
      await mkdir(frozen, { mode: 0o700 });
      for (const name of bundleNames) {
        const bytes = await readFile(new URL(name, packageRoot));
        if (bytes.length > 65536) fail();
        await writeFile(join(frozen, name), bytes, { flag: "wx", mode: 0o400 });
      }
      await chmod(frozen, 0o500);
      context.assertActive();
      const password = await getPassword(context.actor);
      if (typeof password !== "string" || !password || password.length > 1024)
        fail();
      context.assertActive();
      child = spawnProcess(
        python,
        [
          "-I",
          "-B",
          "-c",
          bootstrap,
          directory,
          "--host-controlled",
          intent.from,
          intent.through,
          approvedQuerySha256,
        ],
        {
          cwd: directory,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: "/usr/bin:/bin",
            LANG: "C.UTF-8",
            HOME: directory,
            SALESDATAMART_GRAFANA_PASSWORD: password,
          },
        },
      );
      let bytes = 0,
        output = "",
        stopped = false,
        processError = false;
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 32768) {
          processError = true;
          stopped = true;
          stop();
        } else output += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        bytes += chunk.length; // Count but never retain possible driver/SQL/credential text.
        if (bytes > 32768) {
          processError = true;
          stopped = true;
          stop();
        }
      });
      exitPromise = new Promise((resolve) => {
        child.once("error", () => {
          processError = true;
          stopped = true;
          stop();
        });
        child.once("close", (code, signal) => {
          closed = true;
          resolve({ code, signal });
        });
      });
      abortHandler = () => {
        stopped = true;
        stop();
      };
      context.signal?.addEventListener("abort", abortHandler, { once: true });
      timer = setTimeout(abortHandler, 45000);
      if (context.signal?.aborted) abortHandler();
      const exit = await exitPromise;
      context.assertActive();
      if (
        stopped ||
        processError ||
        exit.code !== 0 ||
        exit.signal ||
        output.length > 32768 ||
        !output.endsWith("\n") ||
        output.trim().split("\n").length !== 1
      )
        fail();
      try {
        return JSON.parse(output);
      } catch {
        fail();
      }
    } catch (error) {
      if (child && !closed) {
        stop();
        await exitPromise;
      }
      if (error instanceof SqlError) throw error;
      fail(); // No driver exception, SQL text or secret may escape to the caller.
    } finally {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      context.signal?.removeEventListener("abort", abortHandler);
      // No cleanup of files under a process whose exit is not proven.
      if (directory && (!child || closed)) {
        await chmod(join(directory, "sales_datamart"), 0o700).catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
}

export const salesQueryDigest = approvedQuerySha256;
