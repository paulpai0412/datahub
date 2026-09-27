import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSalesSourceExecutor,
  protectedSalesPassword,
  salesQueryDigest,
} from "../extensions/datahub-agent/integration/sales-sql-runner.mjs";

const intent = {
  metric: "sales_by_category",
  from: "2014-06-01",
  through: "2014-06-30",
};
const result = {
  complete: true,
  observedAt: "2026-09-24T12:00:00Z",
  dataAsOf: null,
  points: [
    { month: "2014-06-01", category: "Bikes", salesAmount: "12.000001" },
  ],
};
const actor = {
  key: "a".repeat(48),
  urn: "urn:li:corpuser:alice",
  tenant: "ekop",
};

function childProcess({
  stdout = JSON.stringify(result) + "\n",
  hang = false,
} = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  if (!hang)
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", 0, null);
    });
  return child;
}

test("trusted read-only runner freezes Python bytes and retains no value/secret in Host tool receipt", async () => {
  let directory;
  const spawnProcess = (binary, args, options) => {
    assert.ok(binary.endsWith("/.venv/bin/python"));
    assert.deepEqual(args.slice(0, 4), ["-I", "-B", "-c", args[3]]);
    assert.deepEqual(args.slice(-4), [
      "--host-controlled",
      intent.from,
      intent.through,
      salesQueryDigest,
    ]);
    assert.equal(options.shell, false);
    assert.equal(options.env.SALESDATAMART_GRAFANA_PASSWORD, "synthetic-only");
    assert.equal(options.env.DATAHUB_MSSQL_PASSWORD, undefined);
    directory = options.cwd;
    assert.equal(
      existsSync(directory + "/sales_datamart/agent_query.py"),
      true,
    );
    return childProcess();
  };
  const query = createSalesSourceExecutor({
    getPassword: async (owner) => {
      assert.equal(owner.key, actor.key);
      return "synthetic-only";
    },
    spawnProcess,
  });
  assert.deepEqual(await query(intent, { actor, assertActive() {} }), result);
  assert.equal(existsSync(directory), false);
});

test("bounded malformed output or interrupted child never yields values or retries", async () => {
  for (const text of [
    JSON.stringify(result) + "\n" + JSON.stringify(result) + "\n",
    "not-json\n",
    "x".repeat(32769),
  ]) {
    let launches = 0;
    const query = createSalesSourceExecutor({
      getPassword: async () => "synthetic-only",
      spawnProcess: () => {
        launches++;
        return childProcess({ stdout: text });
      },
    });
    await assert.rejects(
      query(intent, { actor, assertActive() {} }),
      /sql_execution_unconfirmed/,
    );
    assert.equal(launches, 1);
  }
  const controller = new AbortController();
  let stopped;
  const query = createSalesSourceExecutor({
    getPassword: async () => "synthetic-only",
    spawnProcess: () => {
      const child = childProcess({ hang: true });
      stopped = new Promise((resolve) => child.once("close", resolve));
      queueMicrotask(() => controller.abort());
      return child;
    },
  });
  const pending = query(intent, {
    actor,
    signal: controller.signal,
    assertActive() {
      if (controller.signal.aborted) throw new Error("request_closed");
    },
  });
  await assert.rejects(pending, /sql_execution_unconfirmed/);
  assert.equal(await stopped, null); // close waits for the terminated child, not just kill intent.
});

test("trusted password resolver uses only an owned protected file and exact reporting key", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sql-password-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "reporting.env");
  await writeFile(
    path,
    "OTHER_SECRET=not-used\nSALESDATAMART_GRAFANA_PASSWORD='reporting-only'\n",
    { mode: 0o600 },
  );
  const resolvePassword = protectedSalesPassword(path);
  assert.equal(await resolvePassword(), "reporting-only");
  await chmod(path, 0o644);
  await assert.rejects(resolvePassword(), /sql_execution_unconfirmed/);
  await chmod(path, 0o600);
  const link = join(dir, "symlink.env");
  await symlink(path, link);
  await assert.rejects(
    protectedSalesPassword(link)(),
    /sql_execution_unconfirmed/,
  );
  await writeFile(path, "OTHER_SECRET=not-used\n", { mode: 0o600 });
  await assert.rejects(resolvePassword(), /sql_execution_unconfirmed/);
  assert.throws(
    () => protectedSalesPassword("relative.env"),
    /sql_not_configured/,
  );
});

test("lost Host grant stops before reading the secret or spawning", async () => {
  let called = false;
  const query = createSalesSourceExecutor({
    getPassword: async () => {
      called = true;
      return "synthetic";
    },
    spawnProcess: () => {
      called = true;
      return childProcess();
    },
  });
  await assert.rejects(
    query(intent, {
      actor,
      assertActive() {
        throw new Error("grant_revoked");
      },
    }),
    /grant_revoked/,
  );
  assert.equal(called, false);
});
