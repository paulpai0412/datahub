import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  rm,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual, promisify } from "node:util";
import { canonicalPublicationJson as canonical } from "./publication-review.mjs";
import {
  makeFixedEtlReview,
  validateFixedEtlReview,
  validateFixedEtlReceipt,
  FIXED_ETL_RUNTIME,
} from "./fixed-etl-review.mjs";

const python = fileURLToPath(
  new URL("../../../.venv/bin/python", import.meta.url),
);
const packageRoot = new URL(
  "../../sales-datamart/src/sales_datamart/",
  import.meta.url,
);
const names = ["__init__.py", "cli.py", "config.py", "etl.py"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const probe = promisify(execFile);
const runtimeProbe =
  "import sys,json,importlib.metadata as m;print(json.dumps({'python':'.'.join(map(str,sys.version_info[:3])),**{n:m.version(n) for n in ['SQLAlchemy','python-tds','sqlalchemy-pytds']}}))";
// Fixed bootstrap, not a command string accepted from a caller. -I ignores
// PYTHONPATH/user-site/startup environment; only our frozen package is inserted.
const bootstrap =
  "import runpy,sys; sys.path.insert(0,sys.argv.pop(1)); runpy.run_module('sales_datamart.cli',run_name='__main__')";

export async function fixedEtlCode() {
  const files = await Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(new URL(name, packageRoot));
      if (bytes.length > 262144) throw new Error("fixed_etl_code_too_large");
      return { name, bytes, sha256: hash(bytes) };
    }),
  );
  const { stdout } = await probe(python, ["-I", "-B", "-c", runtimeProbe], {
    timeout: 10000,
    killSignal: "SIGKILL",
    maxBuffer: 4096,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/dev/null" },
  });
  const runtime = JSON.parse(stdout);
  if (!isDeepStrictEqual(runtime, FIXED_ETL_RUNTIME))
    throw new Error("fixed_etl_runtime_changed");
  return {
    files,
    runtime,
    codeSha256: hash(
      canonical({
        runtime,
        files: files.map(({ name, sha256 }) => ({ name, sha256 })),
      }),
    ),
  };
}

const caseDatasets = [
  "adventureworks2019.production.product",
  "adventureworks2019.production.productcategory",
  "adventureworks2019.production.productsubcategory",
  "adventureworks2019.sales.customer",
  "adventureworks2019.sales.salesorderdetail",
  "adventureworks2019.sales.salesorderheader",
  "adventureworks2019.sales.salesterritory",
  "salesdatamart.dm.dim_customer",
  "salesdatamart.dm.dim_date",
  "salesdatamart.dm.dim_product",
  "salesdatamart.dm.dim_territory",
  "salesdatamart.dm.fact_sales_order_line",
  "salesdatamart.reporting.v_sales_order_line",
]
  .map((name) => `urn:li:dataset:(urn:li:dataPlatform:mssql,${name},PROD)`)
  .sort();

/** An operator may grant this one case to one actor/Run until an explicit expiry.
 * Missing configuration grants nothing. Existing Catalog scopes alone are never
 * promoted to SQL rights. Contains no credentials and enables no SQL endpoint.
 */
export function fixedEtlPolicies(input = {}, sourcePolicies) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid_fixed_etl_policy");
  const result = new Map();
  for (const [key, raw] of Object.entries(input)) {
    const value = structuredClone(raw);
    const source = sourcePolicies
      .get(key)
      ?.find((entry) => entry.urn === value?.source);
    if (
      !/^[a-f0-9]{48}$/.test(key) ||
      !value ||
      Array.isArray(value) ||
      Object.keys(value).sort().join() !==
        "codeSha256,expiresAt,runUrn,source" ||
      typeof value.codeSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.codeSha256) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= 0 ||
      typeof value.runUrn !== "string" ||
      !new RegExp(
        `^urn:li:dataProcessInstance:ekop-agent-${key}-[a-f0-9-]{36}$`,
      ).test(value.runUrn) ||
      !source ||
      !isDeepStrictEqual([...(source.taskDatasets ?? [])].sort(), caseDatasets)
    )
      throw new Error("invalid_fixed_etl_policy");
    const binding = { source: value.source, datasets: [...caseDatasets] };
    result.set(key, {
      recompileFixedEtl: fixedEtlReviewCompiler(binding),
      authorizeFixedEtl: async ({ actor, run, review }) =>
        actor.key === key &&
        run.urn === value.runUrn &&
        review.source === value.source &&
        review.codeSha256 === value.codeSha256 &&
        review.expiresAt <= value.expiresAt &&
        Date.now() < value.expiresAt,
    });
  }
  return result;
}

/** Binding and SQL authorization come from trusted Host configuration, never
 * model text or Catalog visibility. This compiler checks the registered code;
 * taskRecords separately requires its execution-specific authorization callback.
 */
export function fixedEtlReviewCompiler(binding) {
  const owned = structuredClone(binding);
  return async (input) => {
    const review = validateFixedEtlReview(input);
    if (
      review.source !== owned.source ||
      !isDeepStrictEqual(
        [...review.datasets].sort(),
        [...owned.datasets].sort(),
      )
    )
      throw new Error("fixed_etl_binding_mismatch");
    const { planDigest, ...proposal } = review;
    const code = await fixedEtlCode();
    return makeFixedEtlReview({ ...proposal, codeSha256: code.codeSha256 });
  };
}

/** Private fixed Host execution seam. No endpoint, SQL, argv, path, environment,
 * scope override or credentials are accepted from a model/browser operation.
 * getSecrets is a trusted credential resolver; its values only enter child env.
 * A failed/ambiguous admission or execution is never automatically resubmitted.
 */
export async function executeFixedEtl({
  records,
  runUrn,
  runVersion,
  sessionId,
  decisionId,
  review,
  getSecrets,
  signal,
}) {
  const code = await fixedEtlCode();
  if (code.codeSha256 !== validateFixedEtlReview(review).codeSha256)
    throw new Error("fixed_etl_source_changed");
  const admission = await records.claimExecutionConsent(
    runUrn,
    runVersion,
    sessionId,
    decisionId,
    review,
  );
  let directory, child, timer, forceTimer, abortHandler, exitPromise;
  let ready,
    finished,
    processError,
    admittedCommit = false,
    stopped = false,
    exited = false;
  let recordVersion = admission.runVersion,
    outcome;
  const stop = () => {
    stopped = true;
    if (child && !exited) {
      child.stdin.destroy();
      child.kill("SIGTERM");
      forceTimer ??= setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 5000);
    }
  };
  try {
    if (signal?.aborted || Date.now() >= admission.deadlineAt)
      throw new Error("fixed_etl_not_active");
    directory = await mkdtemp(join(tmpdir(), "datahub-fixed-etl-"));
    const frozen = join(directory, "sales_datamart");
    await mkdir(frozen, { mode: 0o700 });
    for (const file of code.files)
      await writeFile(join(frozen, file.name), file.bytes, {
        flag: "wx",
        mode: 0o400,
      });
    await chmod(frozen, 0o500);
    // Only the previously approved immutable bytes enter the child import path.
    const secrets = await getSecrets();
    if (
      typeof secrets.sourcePassword !== "string" ||
      !secrets.sourcePassword ||
      typeof secrets.targetPassword !== "string" ||
      !secrets.targetPassword
    )
      throw new Error("fixed_etl_secret_unavailable");
    child = spawn(
      python,
      ["-I", "-B", "-c", bootstrap, directory, "--host-controlled"],
      {
        cwd: directory,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          HOME: directory,
          DATAHUB_MSSQL_PASSWORD: secrets.sourcePassword,
          SALESDATAMART_LOADER_PASSWORD: secrets.targetPassword,
          SALESDATAMART_DEADLINE_MS: String(admission.deadlineAt),
        },
      },
    );
    let buffer = "",
      bytes = 0,
      frames = 0,
      chain = Promise.resolve();
    const handle = async (line) => {
      if (stopped) throw new Error("fixed_etl_process_not_active");
      const value = JSON.parse(line);
      if (++frames > 2) throw new Error("fixed_etl_output_invalid");
      if (
        value.phase === "READY_TO_COMMIT" &&
        !ready &&
        Object.keys(value).sort().join() === "phase,receipt,receipt_sha256"
      ) {
        if (exited) throw new Error("fixed_etl_process_not_active");
        ready = validateFixedEtlReceipt(value.receipt, true);
        if (value.receipt_sha256 !== hash(canonical(ready)))
          throw new Error("fixed_etl_output_invalid");
        const commit = await records.authorizeExecutionCommit(
          runUrn,
          recordVersion,
          sessionId,
          decisionId,
          admission.attemptId,
          review,
        );
        admittedCommit = true;
        recordVersion = commit.runVersion;
        if (
          stopped ||
          exited ||
          signal?.aborted ||
          Date.now() >= admission.deadlineAt
        )
          throw new Error("fixed_etl_not_active");
        child.stdin.end(`COMMIT ${value.receipt_sha256}\n`);
      } else if (
        value.phase === "FINISHED" &&
        ready &&
        admittedCommit &&
        !finished &&
        Object.keys(value).sort().join() === "phase,receipt"
      ) {
        const { receipt_sha256, ...receipt } = value.receipt;
        finished = validateFixedEtlReceipt(receipt);
        if (receipt_sha256 !== hash(canonical(finished)))
          throw new Error("fixed_etl_output_invalid");
        const {
          status,
          elapsed_ms,
          committed_at,
          readback_at,
          ...finalValues
        } = finished;
        const {
          status: ignoredStatus,
          elapsed_ms: ignoredElapsed,
          ...approvedValues
        } = ready;
        if (!isDeepStrictEqual(finalValues, approvedValues))
          throw new Error("fixed_etl_readback_changed");
      } else if (value.phase === "FAILED") {
        // Deliberately do not copy exception text or arbitrary error properties.
        processError = new Error("fixed_etl_process_failed");
      } else throw new Error("fixed_etl_output_invalid");
    };
    exitPromise = new Promise((resolve) => {
      child.on("error", () => {
        processError = new Error("fixed_etl_process_unconfirmed");
      });
      child.stdin.on("error", () => {
        processError = new Error("fixed_etl_permission_delivery_unconfirmed");
        stop();
      });
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 16384) {
          processError = new Error("fixed_etl_output_limit");
          stop();
          return;
        }
        buffer += chunk.toString("utf8");
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          chain = chain
            .then(() => handle(line))
            .catch((error) => {
              processError = error;
              stop();
            });
        }
      });
      child.stderr.on("data", (chunk) => {
        bytes += chunk.length; // Count but never retain/forward possible SQL parameters.
        if (bytes > 16384) {
          processError = new Error("fixed_etl_output_limit");
          stop();
        }
      });
      child.once("close", (status, killedBy) => {
        exited = true;
        resolve({ status, killedBy });
      });
    });
    abortHandler = stop;
    signal?.addEventListener("abort", abortHandler, { once: true });
    timer = setTimeout(stop, Math.max(0, admission.deadlineAt - Date.now()));
    if (signal?.aborted) stop();
    const closed = await exitPromise;
    await chain;
    if (
      buffer.trim() ||
      processError ||
      stopped ||
      closed.status !== 0 ||
      closed.killedBy ||
      !finished
    )
      throw new Error("fixed_etl_execution_unconfirmed");
    outcome = { state: "COMMITTED", receipt: finished };
  } catch {
    if (child && !exited) {
      stop();
      await exitPromise;
    }
    // Read the exact durable attempt: an ACK may be lost AFTER commit permission
    // was stored. Never downgrade such an attempt to a safe-to-retry failure.
    const current = await records.getRun(runUrn);
    const attempt = current.value.decisions.find(
      (entry) => entry.id === decisionId,
    )?.executionAttempt;
    if (attempt?.attemptId !== admission.attemptId)
      throw new Error("fixed_etl_attempt_reconciliation_required");
    recordVersion = current.version;
    outcome = {
      state:
        attempt.state === "ADMITTED" && (!child || exited)
          ? "FAILED"
          : "UNKNOWN",
      code:
        admittedCommit || attempt.state === "COMMIT_AUTHORIZED"
          ? "commit_or_readback_unconfirmed"
          : "process_unconfirmed",
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    signal?.removeEventListener("abort", abortHandler);
    // Retain a frozen bundle if a process outcome is unknown; do not delete files
    // under a possibly live process or pretend a stop request proved its exit.
    if (directory && (!child || exited)) {
      await chmod(join(directory, "sales_datamart"), 0o700);
      await rm(directory, { recursive: true });
    }
  }
  const current = await records.getRun(runUrn);
  const stored = await records.recordExecutionOutcome(
    runUrn,
    current.version,
    sessionId,
    decisionId,
    admission.attemptId,
    outcome,
  );
  return {
    runUrn,
    runVersion: stored.version,
    decisionId,
    attemptId: admission.attemptId,
    state: outcome.state,
    retryAllowed: false,
  };
}
