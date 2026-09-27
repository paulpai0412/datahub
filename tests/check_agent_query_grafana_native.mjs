// Real pinned Grafana APIs in an owned, network-isolated, ephemeral fixture.
// No existing Grafana org, credential, source DB, volume or Agent is accessed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  createQueryGrafana,
  queryGrafanaConfig,
} from "../extensions/datahub-agent/integration/query-grafana.mjs";

const exec = promisify(execFile);
const image =
  "sha256:d177053ab62253815f130d81504f77063baf5fd4ca93299d6048453bd31e047a";
const run = randomUUID(),
  name = `ekop-datahub-query-test-${run.slice(0, 8)}`;
const writerRole = process.env.QUERY_WRITER_ROLE ?? "Admin";
assert.ok(["Admin", "Editor"].includes(writerRole));
const output = resolve(
  process.env.QUERY_EVIDENCE_DIR ??
    ".local/evidence/metadata-query-native-20260926",
);
const receipt = join(output, `grafana-native-${run}.json`);
const proof = {
  run,
  scope: "ISOLATED_REAL_GRAFANA_API_WITH_SYNTHETIC_USERS_AND_DATA",
  image,
  writerRole,
  passed: false,
  phase: "initial",
  nativeRequests: [],
  projections: [],
  sourceQueries: 0,
  liveGrafanaWrites: 0,
  cleanup: { container: false, network: false },
};
let container, origin, wget;
const adminPassword = randomBytes(24).toString("base64url");
const viewerPassword = randomBytes(24).toString("base64url");
const basic = (login, password) =>
  "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
async function save() {
  await writeFile(receipt, JSON.stringify(proof, null, 2) + "\n", {
    mode: 0o600,
  });
}
async function docker(args) {
  const result = await exec("docker", args, {
    timeout: 60000,
    maxBuffer: 1048576,
  });
  return result.stdout.trim();
}
async function wire(path, options = {}) {
  // Network-none fixture: native HTTP is issued inside its own namespace.
  // This does not enable host networking or expose a public test port.
  const argv = ["exec", container, wget, "-S", "-O", "-", "-T", "10"];
  for (const [key, value] of Object.entries(options.headers ?? {}))
    argv.push("--header", `${key}: ${value}`);
  if (options.method === "POST") argv.push("--post-data", options.body ?? "");
  argv.push(new URL(path, origin).href);
  let native;
  try {
    native = await exec("docker", argv, { timeout: 15000, maxBuffer: 1048576 });
  } catch (error) {
    native = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    if (!/HTTP\/\d/.test(native.stderr))
      throw new Error("fixture_http_transport_failed");
  }
  const statuses = [...native.stderr.matchAll(/HTTP\/[\d.]+\s+(\d{3})/g)];
  const status = Number(statuses.at(-1)?.[1]);
  assert.ok(status >= 100 && status <= 599, "fixture_http_status_missing");
  const response = new Response(native.stdout, {
    status,
    headers: { "content-type": "application/json" },
  });
  proof.nativeRequests.push({
    method: options.method ?? "GET",
    path,
    status: response.status,
  });
  if (
    ["/api/org", "/api/user", "/api/org/users/lookup"].includes(path) ||
    path.endsWith("/permissions") ||
    path.startsWith("/api/serviceaccounts/search?")
  ) {
    const value = await response
      .clone()
      .json()
      .catch(() => null);
    // These are generated fixture identities/ACLs, never keys, cookies or tokens.
    proof.projections.push({ path, value });
  }
  return response;
}
async function api(
  path,
  {
    method = "GET",
    body,
    login = "fixture-admin",
    password = adminPassword,
    orgId = 1,
  } = {},
) {
  const response = await wire(path, {
    method,
    headers: {
      authorization: basic(login, password),
      "content-type": "application/json",
      "X-Grafana-Org-Id": String(orgId),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = new Error("native_http_failure");
    error.status = response.status;
    error.path = path;
    throw error;
  }
  return response.json();
}
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(receipt, JSON.stringify(proof) + "\n", {
  flag: "wx",
  mode: 0o600,
});
try {
  assert.equal(
    await docker(["image", "inspect", image, "--format", "{{.Id}}"]),
    image,
  );
  proof.phase = "create_owned_fixture";
  await save();
  container = await docker([
    "run",
    "--detach",
    "--pull=never",
    "--name",
    name,
    "--label",
    `datahub.query-native-test=${run}`,
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
    "--env",
    "GF_SECURITY_ADMIN_USER=fixture-admin",
    "--env",
    `GF_SECURITY_ADMIN_PASSWORD=${adminPassword}`,
    "--env",
    "GF_USERS_ALLOW_SIGN_UP=false",
    "--env",
    "GF_ANALYTICS_REPORTING_ENABLED=false",
    "--env",
    "GF_ANALYTICS_CHECK_FOR_UPDATES=false",
    "--env",
    "GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false",
    "--env",
    "GF_PLUGINS_PREINSTALL_DISABLED=true",
    "--env",
    "GF_LOG_LEVEL=warn",
    image,
  ]);
  assert.equal(
    await docker([
      "inspect",
      container,
      "--format",
      "{{.HostConfig.NetworkMode}}",
    ]),
    "none",
  );
  wget = await docker(["exec", container, "/bin/sh", "-c", "command -v wget"]);
  assert.ok(
    ["/usr/bin/wget", "/bin/wget"].includes(wget),
    "fixture_wget_unavailable",
  );
  origin = "http://127.0.0.1:3000";
  proof.containerId = container;
  proof.transport = "native HTTP inside network-none container";
  proof.cleanup.network = true;
  proof.phase = "readiness";
  await save();
  // Bounded read-only service readiness, never replay a POST.
  let ready = false;
  for (let n = 0; n < 40; n++) {
    try {
      const r = await wire("/api/health");
      if (r.ok) {
        const health = await r.json();
        assert.equal(health.version, "13.1.2");
        proof.version = health.version;
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(ready, "isolated_grafana_not_ready");
  proof.phase = "fixture_identities";
  await save();
  const org = await api("/api/orgs", {
    method: "POST",
    body: { name: "Isolated query fixture" },
  });
  const orgId = org.orgId;
  assert.ok(Number.isSafeInteger(orgId) && orgId > 1);
  for (const login of ["alice", "bob"]) {
    await api("/api/admin/users", {
      method: "POST",
      body: {
        login,
        name: login,
        email: `${login}@example.invalid`,
        password: viewerPassword,
      },
    });
    await api(`/api/orgs/${orgId}/users`, {
      method: "POST",
      body: { loginOrEmail: login, role: "Viewer" },
    });
  }
  const service = await api("/api/serviceaccounts", {
    orgId,
    method: "POST",
    body: { name: "query-fixture-writer", role: writerRole },
  });
  const token = await api(`/api/serviceaccounts/${service.id}/tokens`, {
    orgId,
    method: "POST",
    body: { name: "ephemeral-query-test", secondsToLive: 3600 },
  });
  const config = queryGrafanaConfig(
    {
      origin,
      orgId,
      folderNamespace: "isolated-native",
      datasourceUid: "unconfigured-fixture",
      dataUrl: "http://127.0.0.1:9/agent/grafana-data",
      writerTokenPath: "/not-used",
    },
    "http://127.0.0.1:9002",
  );
  const publish = createQueryGrafana({
    config,
    getToken: async () => token.key,
    fetchImpl: (url, options) => {
      const u = new URL(url);
      return wire(u.pathname + u.search, options);
    },
  });
  const columns = [
      { name: "region", type: "string" },
      { name: "total", type: "number" },
    ],
    rows = [{ region: "SYNTHETIC", total: "1.2500" }];
  const context = { assertActive() {} };
  proof.phase = "native_publication";
  await save();
  const uids = [];
  for (const type of ["table", "bar"]) {
    const displayRef = randomUUID(),
      uid = "dq-" + displayRef.replaceAll("-", "");
    const chart =
      type === "table"
        ? { type, title: "Isolated native table" }
        : { type, title: "Isolated native bar", x: "region", y: ["total"] };
    await publish(
      {
        uid,
        displayRef,
        viewerLogin: "alice",
        chart,
        columns,
        rows,
        observedAt: "2026-09-26T00:00:00Z",
      },
      context,
    );
    const view = await api(`/api/dashboards/uid/${uid}`, {
      orgId,
      login: "alice",
      password: viewerPassword,
    });
    assert.equal(view.dashboard.uid, uid);
    const denied = await wire(`/api/dashboards/uid/${uid}`, {
      headers: {
        authorization: basic("bob", viewerPassword),
        "X-Grafana-Org-Id": String(orgId),
      },
    });
    assert.ok([403, 404].includes(denied.status));
    uids.push(uid);
  }
  assert.notEqual(uids[0], uids[1]);
  proof.passed = true;
  proof.phase = "verified";
  proof.checks = [
    "native-service-account-identity",
    "private-folder-readback",
    "two-dynamic-dashboard-writes-and-readbacks",
    "owner-viewer-read",
    "other-viewer-denied",
    "existing-folder-reuse",
  ];
} catch (error) {
  proof.failure = {
    code:
      error.message?.startsWith("query_") ||
      error.message === "native_http_failure"
        ? error.message
        : "isolated_native_check_failed",
    status: error.status,
    path: error.path,
    stage: proof.phase,
    detail: String(error.stderr ?? error.message)
      .replaceAll(adminPassword, "[fixture-secret]")
      .replaceAll(viewerPassword, "[fixture-secret]")
      .slice(0, 2048),
  };
  process.exitCode = 1;
} finally {
  // Remove only this exact owned fixture. Never stop or alter another project.
  try {
    if (container) {
      assert.equal(
        await docker([
          "inspect",
          container,
          "--format",
          '{{index .Config.Labels "datahub.query-native-test"}}',
        ]),
        run,
      );
      await docker(["rm", "--force", container]);
      proof.cleanup.container = true;
    }
  } catch {
    proof.cleanup.unconfirmed = true;
    process.exitCode = 1;
  }
  await save();
  console.log(
    JSON.stringify({
      receipt,
      passed: proof.passed,
      failure: proof.failure,
      cleanup: proof.cleanup,
      sourceQueries: 0,
      liveGrafanaWrites: 0,
    }),
  );
}
