// Explicitly approved isolated SQL Server lifecycle check. No real credentials,
// DataHub writes, model prompts, deployed gateway changes or existing DB access.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once, EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { createMetadataQueryHost } from "../extensions/datahub-agent/integration/metadata-query.mjs";
import { createAgentGateway } from "../extensions/datahub-agent/integration/gateway.mjs";
import {
  createQuerySource,
  runQueryChild,
} from "../extensions/datahub-agent/integration/query-source.mjs";
import { actor, grafana } from "./fixtures/query-fixture.mjs";
import { exchangeFixtureTicket } from "./fixtures/query-lifecycle-http.mjs";

const args = process.argv.slice(2);
assert.equal(
  args[0],
  "--approved-isolated",
  "Obtain owner approval before starting this native fixture.",
);
assert.equal(args[1], "--output-dir");
const root = resolve(import.meta.dirname, ".."),
  out = resolve(args[2]);
assert.ok(out.startsWith(join(root, ".local/evidence/")));
process.umask(0o077);
await mkdir(out, { mode: 0o700 }); // Must be a fresh round, never overwrite evidence.
await mkdir(join(out, "docker-home"), { mode: 0o700 });
const image =
  "mcr.microsoft.com/mssql/server@sha256:46f719fd3457d4e7e8e5845fe00c35c20e7bae7ff1e8b9fe595f2a81029f5ba8";
const owner = randomUUID(),
  name = `datahub-query-lifecycle-${owner.slice(0, 8)}`;
const exec = promisify(execFile),
  dockerEnv = {
    PATH: process.env.PATH,
    HOME: join(out, "docker-home"),
    DOCKER_HOST: "unix:///var/run/docker.sock",
    LANG: "C.UTF-8",
  };
const docker = async (argv, timeout = 20000) =>
  (
    await exec("docker", argv, {
      env: dockerEnv,
      timeout,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const proof = {
  scope: "OWNED_SYNTHETIC_MSSQL_LIFECYCLE",
  phase: "initial",
  complete: false,
  owner,
  name,
  image,
  modelPrompts: 0,
  existingSourceQueries: 0,
  deployedServicesChanged: false,
  sourceDispatches: [],
  cases: {},
};
let saving = Promise.resolve();
const save = () =>
  (saving = saving.then(() =>
    writeFile(
      join(out, "receipt.json"),
      JSON.stringify(proof, null, 2) + "\n",
      { mode: 0o600 },
    ),
  ));
let id,
  controller,
  controllerClosed,
  server,
  control,
  heartbeat,
  heartbeatPending,
  locker = false,
  stage = "startup";
const children = [],
  dispatch = new EventEmitter();
async function observeUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  let snapshot;
  do {
    snapshot = await control("observe");
    if (predicate(snapshot.sessions)) return snapshot.sessions;
    await delay(100);
  } while (Date.now() - start < timeoutMs);
  proof.lastObservedSessions = snapshot?.sessions;
  throw Error(label);
}
try {
  proof.sourceHashes = {};
  for (const p of [
    "extensions/datahub-agent/integration/query_runner.py",
    "extensions/datahub-agent/integration/query-source.mjs",
    "extensions/datahub-agent/integration/metadata-query.mjs",
    "extensions/datahub-agent/integration/gateway.mjs",
    "tests/check_agent_query_lifecycle_native.mjs",
    "tests/fixtures/query_lifecycle_control.py",
    "tests/fixtures/query-lifecycle-http.mjs",
  ])
    proof.sourceHashes[p] = hash(await readFile(join(root, p)));
  proof.phase = "container_create_intent";
  await save();
  await docker(["image", "inspect", image, "--format", "{{.Id}}"]);
  const password = "T!" + randomBytes(20).toString("hex"),
    readerPassword = "R!" + randomBytes(20).toString("hex");
  const envPath = join(out, "container-env-private");
  await writeFile(
    envPath,
    `ACCEPT_EULA=Y\nMSSQL_PID=Developer\nMSSQL_SA_PASSWORD=${password}\nMSSQL_MEMORY_LIMIT_MB=1536\n`,
    { flag: "wx", mode: 0o600 },
  );
  id = await docker(
    [
      "run",
      "-d",
      "--pull",
      "never",
      "--name",
      name,
      "--label",
      `datahub.query.lifecycle=${owner}`,
      "--memory",
      "3g",
      "--memory-swap",
      "3g",
      "--cpus",
      "1",
      "--security-opt",
      "no-new-privileges",
      "--env-file",
      envPath,
      "--tmpfs",
      "/var/opt/mssql:rw,nosuid,nodev,size=1g,uid=10001,gid=0,mode=770",
      "--publish",
      "127.0.0.1::1433",
      image,
    ],
    30000,
  );
  proof.containerId = id;
  await save();
  const info = JSON.parse(
    await docker(["inspect", id, "--format", "{{json .HostConfig}}"]),
  );
  assert.equal(info.Memory, 3221225472);
  assert.equal(info.MemorySwap, 3221225472);
  assert.equal(info.NanoCpus, 1000000000);
  assert.equal(info.Binds?.length ?? 0, 0);
  const mounts = JSON.parse(
    await docker(["inspect", id, "--format", "{{json .Mounts}}"]),
  );
  assert.ok(mounts.every((m) => m.Type === "tmpfs"));
  const portBindings = JSON.parse(
    await docker([
      "inspect",
      id,
      "--format",
      "{{json .NetworkSettings.Ports}}",
    ]),
  );
  assert.equal(portBindings["1433/tcp"].length, 1);
  assert.equal(portBindings["1433/tcp"][0].HostIp, "127.0.0.1");
  const port = Number(portBindings["1433/tcp"][0].HostPort);
  let ready = false;
  for (let n = 0; n < 90; n++) {
    const status = await docker([
      "inspect",
      id,
      "--format",
      "{{.State.Running}} {{.State.OOMKilled}}",
    ]);
    assert.equal(status, "true false", "fixture_runtime_failed");
    if (
      (await docker(["logs", id])).includes(
        "SQL Server is now ready for client connections",
      )
    ) {
      ready = true;
      break;
    }
    await delay(1000);
  }
  assert.ok(ready, "fixture_start_timeout");
  proof.phase = "fixture_ready";
  proof.limits = {
    cpus: 1,
    memory: info.Memory,
    memorySwap: info.MemorySwap,
    loopbackOnly: true,
    existingVolumes: 0,
  };
  await save();
  controller = spawn(
    join(root, ".venv/bin/python"),
    ["-I", "-B", join(root, "tests/fixtures/query_lifecycle_control.py")],
    {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/dev/null" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  controllerClosed = new Promise((resolve) =>
    controller.once("close", (code, signal) => resolve({ code, signal })),
  );
  const waiting = new Map();
  let seq = 0;
  controller.stderr.on("data", (b) => {
    proof.controllerStderrBytes = (proof.controllerStderrBytes ?? 0) + b.length;
  });
  createInterface({ input: controller.stdout }).on("line", (line) => {
    const reply = JSON.parse(line),
      pending = waiting.get(reply.id);
    if (!pending) return;
    waiting.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.error) {
      proof.controllerFailure = reply;
      pending.reject(Error(reply.error));
    } else pending.resolve(reply.result);
  });
  control = (action, extra = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++seq,
        timer = setTimeout(() => {
          waiting.delete(requestId);
          reject(Error("fixture_control_unconfirmed"));
        }, 12000);
      waiting.set(requestId, { resolve, reject, timer });
      controller.stdin.write(
        JSON.stringify({ id: requestId, action, ...extra }) + "\n",
      );
    });
  const connectionPath = join(out, "reader-connection-private.json");
  proof.setup = await control("init", {
    connection: { host: "127.0.0.1", port, password },
    readerPassword,
    connectionPath,
  });
  const binding = {
    id: "isolated-lifecycle",
    tenant: actor.tenant,
    platform: "mssql",
    platformInstanceUrn: null,
    environment: "TEST",
    database: "query_lifecycle",
    datasetPrefix: "",
    connectionPath,
  };
  const urn =
    "urn:li:dataset:(urn:li:dataPlatform:mssql,query_lifecycle.dbo.lock_probe,TEST)";
  const metadata = [
    {
      urn,
      qualifiedName: "query_lifecycle.dbo.lock_probe",
      platform: "mssql",
      platformInstanceUrn: null,
      environment: "TEST",
      schemaVersion: 1,
      fields: [
        { path: "id", nativeType: "int" },
        { path: "value", nativeType: "int" },
      ],
    },
  ];
  const plan = {
    datasets: [{ urn, alias: "x" }],
    joins: [],
    select: [{ field: { dataset: "x", field: "value" }, as: "value" }],
    filters: [{ field: { dataset: "x", field: "id" }, op: "eq", value: 1 }],
    groupBy: [],
    orderBy: [],
    limit: 20,
  };
  let publicationCalls = 0;
  const source = createQuerySource({
    run: (payload, context) =>
      runQueryChild(payload, {
        ...context,
        spawnProcess: (...args) => {
          if (payload.operation === "execute")
            assert.ok(
              proof.sourceDispatches.length < 5,
              "approved_source_query_budget_exceeded",
            );
          const child = spawn(...args);
          children.push(child);
          if (payload.operation === "execute") {
            const record = {
              phase: stage,
              pid: child.pid,
              startedAt: Date.now(),
              closed: false,
            };
            proof.sourceDispatches.push(record);
            queueMicrotask(() => dispatch.emit("source", record));
            child.once("close", (code, signal) => {
              Object.assign(record, {
                closed: true,
                code,
                signal,
                closedAt: Date.now(),
              });
            });
          }
          return child;
        },
      }),
  });
  const host = createMetadataQueryHost({
    bindings: [binding],
    readMetadata: async () => ({
      snapshots: metadata,
      visible: async () => true,
    }),
    source,
    grafana,
    verifyIdentity: async () => actor,
    publishDashboard: async () => {
      publicationCalls++;
      throw Error("unexpected_publication");
    },
  });
  server = await createAgentGateway({
    gatewayOrigin: "http://localhost:0",
    datahubOrigin: "http://localhost:9002",
    mfeDirectory: join(root, "extensions/datahub-agent/mfe/dist"),
    verifyIdentity: async () => actor,
    runtimeForActor: async () => ({
      origin: "http://127.0.0.1:9",
      password: "fixture",
    }),
    sqlRequest: (text, context) => host.execute(text, context),
    sqlResultRequest: (text, context) => host.readResult(text, context),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://localhost:${server.address().port}`;
  const post = async (path, body, signal) => {
    if (path === "/agent/sql" && proof.browserGrant?.heartbeatFailure)
      throw Error("fixture_heartbeat_failed");
    const r = await fetch(base + path, {
      method: "POST",
      signal,
      headers: {
        origin: "http://localhost:9002",
        cookie: "PLAY_SESSION=fixture",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const result = { status: r.status, body: await r.json() };
    if (path === "/agent/sql")
      (proof.httpResponses ??= []).push({
        requestId: JSON.parse(body.request).requestId,
        status: r.status,
        error: result.body.error,
        state: result.body.state,
      });
    return result;
  };
  const bootstrap = await post("/agent/bootstrap", {});
  assert.equal(bootstrap.status, 200);
  const grant = bootstrap.body;
  // Normal MFE consumes the 30s bootstrap ticket before starting work. Heartbeat
  // cannot preserve an unexchanged ticket; do not enlarge the product TTL in tests.
  const exchange = await exchangeFixtureTicket(base, grant.launchUrl);
  assert.equal(exchange.status, 200);
  assert.equal(exchange.body.ok, true);
  proof.browserGrant = { exchanged: true, heartbeats: 0 };
  heartbeat = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = post("/agent/heartbeat", {
      grantId: grant.grantId,
      revokeToken: grant.revokeToken,
    })
      .then((r) => {
        if (r.status !== 200) proof.browserGrant.heartbeatFailure = r.status;
        else proof.browserGrant.heartbeats++;
      })
      .catch(() => {
        proof.browserGrant.heartbeatFailure = "unconfirmed";
      })
      .finally(() => {
        heartbeatPending = undefined;
      });
  }, 20000);
  const envelope = (requestId = randomUUID()) => ({
    grantId: grant.grantId,
    revokeToken: grant.revokeToken,
    request: JSON.stringify({
      action: "execute_query",
      requestId,
      plan,
      chart: { type: "table", title: "Synthetic lifecycle" },
    }),
  });
  const blocked = (s, pid) =>
    s.some(
      (r) => r.pid === pid && r.waitType?.startsWith("LCK_") && r.blockedBy > 0,
    );

  stage = "driver_timeout";
  proof.phase = stage;
  await control("lock");
  locker = true;
  const timeoutInput = envelope(),
    timeoutSpawn = once(dispatch, "source", {
      signal: AbortSignal.timeout(10000),
    }),
    timeoutResponse = post("/agent/sql", timeoutInput);
  void timeoutResponse.catch(() => {});
  const [timeoutChild] = await timeoutSpawn;
  proof.cases.timeout = {
    blocked: await observeUntil(
      (s) => blocked(s, timeoutChild.pid),
      10000,
      "timeout_not_blocked",
    ),
  };
  await save();
  const timeoutResult = await timeoutResponse;
  Object.assign(proof.cases.timeout, {
    status: timeoutResult.status,
    error: timeoutResult.body.error,
    elapsedMs: Date.now() - timeoutChild.startedAt,
    child: timeoutChild,
  });
  await save();
  assert.equal(timeoutResult.body.error, "query_execution_unconfirmed");
  assert.notEqual(timeoutResult.status, 200);
  assert.ok(
    proof.cases.timeout.elapsedMs >= 29000 &&
      proof.cases.timeout.elapsedMs < 45000,
  );
  await observeUntil((s) => s.length === 0, 5000, "timeout_left_db_work");
  proof.cases.timeout.databaseSessionsGone = true;
  const timeoutRepeat = await post("/agent/sql", timeoutInput);
  assert.equal(timeoutRepeat.body.error, "query_execution_unconfirmed");
  assert.equal(proof.sourceDispatches.length, 1);
  await control("unlock");
  locker = false;
  stage = "after_timeout_recovery";
  const recovery = await post("/agent/sql", envelope());
  assert.equal(recovery.status, 200);
  assert.equal(recovery.body.state, "AVAILABLE");
  const readRecovered = async (receipt) => {
    const result = await post("/agent/sql-result", {
      grantId: grant.grantId,
      revokeToken: grant.revokeToken,
      request: JSON.stringify({
        action: "read_result",
        resultRef: receipt.resultRef,
      }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.rows, [{ value: "7" }]);
  };
  await readRecovered(recovery.body);
  proof.cases.timeout.recoveryAvailable = true;
  await save();

  stage = "http_cancel";
  proof.phase = stage;
  await control("lock");
  locker = true;
  const cancelledInput = envelope(),
    abort = new AbortController();
  const cancelledSpawn = once(dispatch, "source", {
      signal: AbortSignal.timeout(10000),
    }),
    cancelledResponse = post("/agent/sql", cancelledInput, abort.signal).then(
      () => ({ unexpectedSuccess: true }),
      (error) => ({ aborted: error.name === "AbortError" }),
    );
  const [cancelledChild] = await cancelledSpawn;
  const otherSpawn = once(dispatch, "source", {
      signal: AbortSignal.timeout(10000),
    }),
    otherResponse = post("/agent/sql", envelope());
  void otherResponse.catch(() => {});
  const [otherChild] = await otherSpawn;
  proof.cases.cancel = {
    blocked: await observeUntil(
      (s) => blocked(s, cancelledChild.pid) && blocked(s, otherChild.pid),
      10000,
      "cancel_pair_not_blocked",
    ),
  };
  const full = await post("/agent/sql", envelope());
  assert.equal(full.status, 429);
  assert.equal(proof.sourceDispatches.length, 4);
  const startedCancel = Date.now();
  abort.abort();
  assert.equal((await cancelledResponse).aborted, true);
  // Waiting on the retained request proves the Host observed child close; no new dispatch.
  const cancelRepeat = await post("/agent/sql", cancelledInput);
  Object.assign(proof.cases.cancel, {
    status: cancelRepeat.status,
    error: cancelRepeat.body.error,
    child: cancelledChild,
    elapsedMs: Date.now() - startedCancel,
  });
  await save();
  assert.equal(cancelRepeat.body.error, "query_cancelled");
  assert.equal(proof.sourceDispatches.length, 4);
  assert.equal(cancelledChild.closed, true);
  const after = await observeUntil(
    (s) => !s.some((r) => r.pid === cancelledChild.pid),
    5000,
    "cancel_left_db_work",
  );
  assert.ok(
    blocked(after, otherChild.pid),
    "cancellation_disturbed_other_query",
  );
  proof.cases.cancel.databaseSessionGone = true;
  proof.cases.cancel.otherQueryUnaffected = true;
  stage = "after_cancel_replacement";
  const replacementSpawn = once(dispatch, "source", {
      signal: AbortSignal.timeout(10000),
    }),
    replacementResponse = post("/agent/sql", envelope());
  void replacementResponse.catch(() => {});
  const [replacementChild] = await replacementSpawn;
  await observeUntil(
    (s) => blocked(s, otherChild.pid) && blocked(s, replacementChild.pid),
    5000,
    "replacement_not_admitted",
  );
  await control("unlock");
  locker = false;
  for (const response of [await otherResponse, await replacementResponse]) {
    assert.equal(response.status, 200);
    assert.equal(response.body.state, "AVAILABLE");
    await readRecovered(response.body);
  }
  await observeUntil((s) => s.length === 0, 5000, "success_left_db_sessions");
  proof.cases.cancel.recoveryAvailable = true;
  proof.publicationCalls = publicationCalls;
  assert.equal(publicationCalls, 0);
  assert.equal(proof.sourceDispatches.length, 5);
  assert.ok(!proof.browserGrant.heartbeatFailure);
  assert.ok(proof.browserGrant.heartbeats >= 1);
  proof.complete = true;
  proof.phase = "native_lifecycle_verified";
  await save();
} catch (error) {
  proof.failure = {
    phase: proof.phase,
    code: error.code ?? error.name,
    message:
      error instanceof assert.AssertionError
        ? String(error.message).slice(0, 180)
        : [
              "timeout_not_blocked",
              "timeout_left_db_work",
              "cancel_pair_not_blocked",
              "cancel_left_db_work",
              "replacement_not_admitted",
              "success_left_db_sessions",
              "fixture_control_failed",
              "fixture_control_unconfirmed",
            ].includes(error.message)
          ? error.message
          : "native_lifecycle_failed",
  };
  proof.complete = false;
  process.exitCode = 1;
} finally {
  // Cleanup is confined to this exact owned instance; never prune or touch existing DBs.
  try {
    clearInterval(heartbeat);
    await heartbeatPending;
    if (proof.browserGrant?.heartbeatFailure) {
      proof.complete = false;
      process.exitCode = 1;
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (control && controller.exitCode === null) {
      if (locker) {
        await control("unlock");
        locker = false;
      }
      await control("stop");
      controller.stdin.end();
      const exit = await Promise.race([
        controllerClosed,
        delay(6000).then(() => null),
      ]);
      if (!exit || exit.code !== 0) throw Error("controller_exit_unconfirmed");
      proof.controllerExit = exit;
    }
    if (id) {
      assert.equal(
        await docker([
          "inspect",
          id,
          "--format",
          '{{index .Config.Labels "datahub.query.lifecycle"}}',
        ]),
        owner,
      );
      await writeFile(
        join(out, "sqlserver-log-private.txt"),
        await docker(["logs", id]),
        { flag: "wx", mode: 0o600 },
      );
      await docker(["stop", "--time", "15", id], 25000);
      await docker(["rm", id]);
      assert.equal(
        await docker([
          "ps",
          "-aq",
          "--filter",
          `label=datahub.query.lifecycle=${owner}`,
        ]),
        "",
      );
      proof.ownedContainerRemoved = true;
    }
  } catch (error) {
    proof.cleanupFailure = error.name;
    proof.complete = false;
    process.exitCode = 1;
  }
  await save();
  await saving;
  console.log(
    JSON.stringify({
      complete: proof.complete,
      phase: proof.phase,
      failure: proof.failure,
      cleanupFailure: proof.cleanupFailure,
      sourceDispatches: proof.sourceDispatches.length,
      ownedContainerRemoved: proof.ownedContainerRemoved,
      receipt: join(out, "receipt.json"),
    }),
  );
}
