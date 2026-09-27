// Approved sequential native parser check. Captured synthetic SQL results only;
// no SQL, model, existing credentials/orgs, network or deployed service mutation.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { buildQueryDashboard } from "../extensions/datahub-agent/integration/query-grafana.mjs";
const args = process.argv.slice(2);
assert.equal(args[0], "--approved-isolated");
assert.equal(args[1], "--output-dir");
assert.equal(args[3], "--sql-evidence");
assert.equal(args[5], "--plugin-container");
const out = resolve(args[2]),
  sqlDir = resolve(args[4]),
  pluginContainer = args[6];
assert.match(pluginContainer, /^[a-f0-9]{12,64}$/);
assert.ok(out.startsWith(resolve(".local/evidence") + "/"));
process.umask(0o077);
await mkdir(out, { mode: 0o700 });
await mkdir(join(out, "docker-home"), { mode: 0o700 });
const exec = promisify(execFile),
  image =
    "sha256:d177053ab62253815f130d81504f77063baf5fd4ca93299d6048453bd31e047a";
const owner = randomUUID(),
  name = `datahub-query-infinity-${owner.slice(0, 8)}`;
const password = randomBytes(24).toString("base64url"),
  auth = "Basic " + Buffer.from(`fixture-admin:${password}`).toString("base64");
const docker = async (argv) =>
  (
    await exec("docker", argv, {
      timeout: 60000,
      maxBuffer: 4194304,
      env: {
        PATH: process.env.PATH,
        HOME: join(out, "docker-home"),
        LANG: "C.UTF-8",
        DOCKER_HOST: "unix:///var/run/docker.sock",
      },
    })
  ).stdout.trim();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const proof = {
  complete: false,
  phase: "initial",
  scope: "NATIVE_INFINITY_INLINE_PARSER_WITH_CAPTURED_SYNTHETIC_SQL_ROWS",
  owner,
  name,
  image,
  sourceQueries: 0,
  modelPrompts: 0,
  existingGrafanaWrites: 0,
  requests: [],
  cases: [],
  ownedContainerRemoved: false,
};
let container;
const save = () =>
  writeFile(join(out, "receipt.json"), JSON.stringify(proof, null, 2) + "\n", {
    mode: 0o600,
  });
async function api(path, body) {
  const argv = [
    "exec",
    container,
    "wget",
    "-S",
    "-O",
    "-",
    "-T",
    "15",
    "--header",
    `Authorization: ${auth}`,
    "--header",
    "Content-Type: application/json",
  ];
  if (body !== undefined) argv.push("--post-data", JSON.stringify(body));
  argv.push(`http://127.0.0.1:3000${path}`);
  let native;
  try {
    native = await exec("docker", argv, { timeout: 20000, maxBuffer: 4194304 });
  } catch (e) {
    native = { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
  const status = Number(
    [...native.stderr.matchAll(/HTTP\/[\d.]+\s+(\d{3})/g)].at(-1)?.[1],
  );
  proof.requests.push({
    path,
    method: body === undefined ? "GET" : "POST",
    status,
  });
  assert.equal(status, 200, `native_http_${status}_${path}`);
  return JSON.parse(native.stdout);
}
function frameRows(reply, target, expectedEmpty = false) {
  const result = reply.results.A;
  assert.ok(!result.error, "native_parser_error");
  assert.equal(result.status, 200);
  if (expectedEmpty) {
    assert.ok(
      (result.frames ?? []).every((f) =>
        f.data.values.every((v) => v.length === 0),
      ),
      "empty_result_must_not_be_zero_row",
    );
    return [];
  }
  const frame = result.frames[0];
  assert.ok(frame, "native_frame_missing");
  // Native backend may sort fields; values must be matched by field name.
  assert.deepEqual(
    frame.schema.fields.map((f) => f.name).sort(),
    target.columns.map((c) => c.text).sort(),
  );
  return frame.data.values[0].map((_, i) =>
    Object.fromEntries(
      frame.schema.fields.map((f, j) => [f.name, frame.data.values[j][i]]),
    ),
  );
}
try {
  const sqlBytes = await readFile(join(sqlDir, "host-results-private.json")),
    sql = JSON.parse(sqlBytes);
  const receipt = JSON.parse(await readFile(join(sqlDir, "receipt.json")));
  assert.ok(sql.complete && receipt.complete && receipt.ownedContainerRemoved);
  assert.equal(
    await docker(["ps", "-aq", "--filter", "label=datahub.query.boundaries"]),
    "",
  );
  proof.sqlEvidenceSha256 = hash(sqlBytes);
  proof.sourceSha256 = hash(await readFile(import.meta.filename));
  proof.builderSha256 = hash(
    await readFile("extensions/datahub-agent/integration/query-grafana.mjs"),
  );
  assert.equal(
    await docker(["inspect", pluginContainer, "--format", "{{.Image}}"]),
    image,
  );
  await docker([
    "cp",
    `${pluginContainer}:/var/lib/grafana/plugins/yesoreyeram-infinity-datasource`,
    join(out, "infinity"),
  ]);
  const plugin = JSON.parse(await readFile(join(out, "infinity/plugin.json")));
  assert.equal(plugin.id, "yesoreyeram-infinity-datasource");
  assert.equal(plugin.info.version, "3.11.2");
  proof.plugin = {
    id: plugin.id,
    version: plugin.info.version,
    manifestSha256: hash(await readFile(join(out, "infinity/MANIFEST.txt"))),
    backendSha256: hash(
      await readFile(join(out, "infinity/gpx_infinity_linux_amd64")),
    ),
  };
  // Public plugin files only; no Grafana database, config or credential copied.
  await chmod(join(out, "infinity"), 0o755);
  const envPath = join(out, "grafana-env-private");
  await writeFile(
    envPath,
    `GF_SECURITY_ADMIN_USER=fixture-admin\nGF_SECURITY_ADMIN_PASSWORD=${password}\nGF_PATHS_PLUGINS=/opt/plugins\nGF_PLUGINS_PREINSTALL_DISABLED=true\nGF_ANALYTICS_REPORTING_ENABLED=false\nGF_ANALYTICS_CHECK_FOR_UPDATES=false\nGF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false\nGF_LOG_LEVEL=warn\n`,
    { mode: 0o600 },
  );
  proof.phase = "create_intent";
  await save();
  container = await docker([
    "run",
    "-d",
    "--pull=never",
    "--name",
    name,
    "--label",
    `datahub.query.infinity-boundary=${owner}`,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "512m",
    "--memory-swap",
    "512m",
    "--cpus",
    "1",
    "--pids-limit",
    "256",
    "--tmpfs",
    "/var/lib/grafana:rw,size=128m,uid=472,gid=0",
    "--tmpfs",
    "/var/log/grafana:rw,size=8m,uid=472,gid=0",
    "--tmpfs",
    "/tmp:rw,size=32m",
    "--mount",
    `type=bind,source=${join(out, "infinity")},target=/opt/plugins/yesoreyeram-infinity-datasource,readonly`,
    "--env-file",
    envPath,
    image,
  ]);
  proof.containerId = container;
  const hc = JSON.parse(
    await docker(["inspect", container, "--format", "{{json .HostConfig}}"]),
  );
  assert.equal(hc.NetworkMode, "none");
  assert.equal(hc.Memory, 536870912);
  assert.equal(hc.MemorySwap, hc.Memory);
  assert.equal(hc.NanoCpus, 1000000000);
  proof.phase = "readiness";
  await save();
  let ready = false;
  for (let n = 0; n < 40; n++) {
    // Readiness only; never retry a POST or parser failure.
    const r = await exec(
      "docker",
      [
        "exec",
        container,
        "wget",
        "-q",
        "-O",
        "-",
        "http://127.0.0.1:3000/api/health",
      ],
      { timeout: 5000 },
    ).catch(() => null);
    if (r?.stdout) {
      assert.equal(JSON.parse(r.stdout).version, "13.1.2");
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(ready, "fixture_start_timeout");
  const plugins = await api("/api/plugins");
  assert.ok(
    plugins.some((p) => p.id === plugin.id),
    "infinity_plugin_not_loaded",
  );
  await api("/api/datasources", {
    name: "boundary-inline",
    uid: "boundary-inline",
    type: plugin.id,
    access: "proxy",
    jsonData: {},
  });
  proof.phase = "native_parser";
  const config = {
    datasourceUid: "boundary-inline",
    dataUrl: "http://127.0.0.1:9/agent/grafana-data",
  };
  for (const c of sql.cases.filter((c) => c.result)) {
    const { columns, rows, observedAt, truncated } = c.result;
    const ref = randomUUID();
    const dashboard = buildQueryDashboard({
      uid: `dq-${ref.replaceAll("-", "")}`,
      displayRef: ref,
      chart: { type: "table", title: c.name },
      columns,
      rows,
      observedAt,
      truncated,
      config,
    });
    const target = dashboard.panels[0].targets[0];
    // Network-none: exercise native backend parsing via its official inline source.
    // This is NOT a claim about authenticated URL transport or browser rendering.
    const query = {
      ...target,
      source: "inline",
      data: JSON.stringify(rows),
      intervalMs: 1000,
      maxDataPoints: 2000,
    };
    delete query.url;
    const reply = await api("/api/ds/query", {
      from: "0",
      to: "1790467200000",
      queries: [query],
    });
    await writeFile(
      join(out, `${c.name}-frame-private.json`),
      JSON.stringify(reply),
      { mode: 0o600 },
    );
    const actual = frameRows(reply, target, rows.length === 0);
    const expected = rows.map((row) =>
      Object.fromEntries(
        columns.map((col) => [
          col.name,
          row[col.name] === null ? null : String(row[col.name]),
        ]),
      ),
    );
    assert.deepEqual(actual, expected, `native_table_values_${c.name}`);
    const created = await api("/api/dashboards/db", {
      dashboard,
      overwrite: false,
    });
    assert.equal(created.uid, dashboard.uid);
    const readback = await api(`/api/dashboards/uid/${dashboard.uid}`);
    assert.deepEqual(
      readback.dashboard.panels.map((p) => p.title),
      dashboard.panels.map((p) => p.title),
    );
    if (truncated)
      assert.ok(
        readback.dashboard.panels.every((p) => p.title.includes("截斷")),
      );
    proof.cases.push({
      name: c.name,
      exactTable: true,
      rows: actual.length,
      truncated,
      nativeTitleReadback: true,
    });
    // Only the precision/null case also needs a numeric-chart projection.
    if (c.name === "exact_limit_precision_nulls") {
      const numeric = {
        ...query,
        columns: target.columns
          .filter((col) => ["big", "amount"].includes(col.selector))
          .map((col) => ({ ...col, type: "number" })),
      };
      const chartReply = await api("/api/ds/query", {
        from: "0",
        to: "1790467200000",
        queries: [numeric],
      });
      await writeFile(
        join(out, "numeric-frame-private.json"),
        JSON.stringify(chartReply),
        { mode: 0o600 },
      );
      assert.deepEqual(
        frameRows(chartReply, numeric),
        rows.map((r) => ({
          big: r.big === null ? null : Number(r.big),
          amount: r.amount === null ? null : Number(r.amount),
        })),
      );
      proof.numericProjection =
        "native numbers are approximate; null remains null; exact table unchanged";
    }
    await save();
  }
  proof.complete = true;
  proof.phase = "verified";
} catch (error) {
  proof.failure = {
    name: error.name,
    message: String(error.message)
      .replaceAll(password, "[fixture-secret]")
      .slice(0, 1500),
  };
  process.exitCode = 1;
} finally {
  const ids = (
    await docker([
      "ps",
      "-aq",
      "--filter",
      `label=datahub.query.infinity-boundary=${owner}`,
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  assert.ok(ids.length <= 1);
  if (ids.length) {
    const id = ids[0];
    assert.equal(
      await docker(["inspect", id, "--format", "{{.Name}}"]),
      "/" + name,
    );
    await writeFile(
      join(out, "grafana-log-private.txt"),
      await docker(["logs", id]),
      { mode: 0o600 },
    );
    await docker(["stop", "--time", "10", id]);
    await docker(["rm", id]);
  }
  proof.ownedContainerRemoved = !(await docker([
    "ps",
    "-aq",
    "--filter",
    `label=datahub.query.infinity-boundary=${owner}`,
  ]));
  await save();
  console.log(
    JSON.stringify({
      complete: proof.complete,
      phase: proof.phase,
      cases: proof.cases,
      failure: proof.failure,
      ownedContainerRemoved: proof.ownedContainerRemoved,
      sourceQueries: 0,
    }),
  );
}
