import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createMetadataQueryHost } from "../extensions/datahub-agent/integration/metadata-query.mjs";
import {
  queryMetadataReader,
  QueryError,
  authorizeQueryMetadata,
} from "../extensions/datahub-agent/integration/query-metadata.mjs";
import {
  queryBindings,
  createQuerySource,
  resolveQueryBinding,
  runQueryChild,
} from "../extensions/datahub-agent/integration/query-source.mjs";
import {
  buildQueryDashboard,
  createQueryGrafana,
  queryGrafanaConfig,
} from "../extensions/datahub-agent/integration/query-grafana.mjs";
import { CATALOG_QUERIES } from "../extensions/datahub-agent/integration/native-catalog.mjs";
import {
  actor,
  other,
  binding,
  metadata,
  plan,
  chart,
  context,
  grafana,
} from "./fixtures/query-fixture.mjs";

function harness(options = {}) {
  let visible = true,
    sourceCalls = 0,
    writes = 0,
    time = Date.now();
  const source = createQuerySource();
  const readMetadata = async () => {
    if (!visible) throw new QueryError("query_metadata_denied", 403);
    return { snapshots: structuredClone(metadata), visible: async () => true };
  };
  const host = createMetadataQueryHost({
    bindings: queryBindings([binding]),
    readMetadata,
    source: {
      ...source,
      execute: async (p, m, b, ctx) => {
        sourceCalls++;
        if (options.execute) return options.execute(p, m, b, ctx);
        const compiled = await source.compile(p, m, b, ctx);
        return {
          columns: compiled.columns,
          sql: compiled.sql,
          rows: options.empty
            ? []
            : [
                { region: "NORTH_FIXTURE", revenue: "15.000000" },
                { region: "SOUTH_FIXTURE", revenue: "40.000000" },
              ],
          truncated: false,
          observedAt: "2026-09-26T00:00:00Z",
        };
      },
    },
    grafana: queryGrafanaConfig(
      { ...grafana, ...options.grafana },
      "http://localhost:9002",
    ),
    publishDashboard: async (args) => {
      writes++;
      if (options.publish) return options.publish(args);
      const d = buildQueryDashboard({ ...args, config: grafana });
      assert.equal(d.panels[0].type, "barchart");
      assert.ok(
        d.panels.every((p) => !JSON.stringify(p).includes("NORTH_FIXTURE")),
      );
      return { dashboardUid: args.uid };
    },
    verifyIdentity: async () => actor,
    now: () => time,
  });
  return {
    host,
    counts: () => ({ sourceCalls, writes }),
    revoke: () => {
      visible = false;
    },
    expire: () => {
      time += 900001;
    },
  };
}
const request = (patch = {}) =>
  JSON.stringify({
    action: "execute_query",
    requestId: randomUUID(),
    plan,
    chart,
    ...patch,
  });
const authorize = (resultRef) =>
  JSON.stringify({
    action: "grafana_authorize",
    resultRef,
    requestId: randomUUID(),
  });
const open = (displayRef) =>
  JSON.stringify({
    action: "grafana_open",
    displayRef,
    requestId: randomUUID(),
  });

// This calls the real Python compiler and Host chain, but synthetic DB/Grafana
// callbacks. It is deliberately not labelled a live SQL/Grafana acceptance.
test("metadata-driven JOIN -> source result -> dynamic Dashboard -> light portal; no one-shot quota", async () => {
  const h = harness(),
    input = request();
  const receipt = await h.host.execute(input, context);
  assert.equal(receipt.format, "datahub-query.receipt/1");
  assert.equal(receipt.state, "AVAILABLE");
  assert.equal(JSON.stringify(receipt).includes("NORTH_FIXTURE"), false);
  assert.equal("sql" in receipt, false);
  assert.deepEqual(await h.host.execute(input, context), receipt);
  const embed = await h.host.request(authorize(receipt.resultRef), context);
  assert.equal(embed.format, "datahub-grafana.embed/2");
  assert.equal(embed.datasetUrns.length, 2);
  assert.equal("url" in embed, false);
  const portal = await h.host.request(open(embed.displayRef), context);
  assert.equal(new URL(portal.url).searchParams.get("theme"), "light");
  assert.equal(new URL(portal.url).pathname, `/d/${embed.dashboardUid}`);
  const rows = await h.host.read(embed.displayRef, {
    assertGrant(id, key) {
      assert.equal(id, context.grantId);
      assert.equal(key, actor.key);
    },
    viewerLogin: "alice",
    orgId: "org-2",
  });
  assert.equal(rows[1].revenue, "40.000000");
  const preview = await h.host.readResult(
    JSON.stringify({ action: "read_result", resultRef: receipt.resultRef }),
    context,
  );
  assert.match(preview.sql, /LEFT OUTER JOIN/);
  const second = await h.host.execute(request(), context);
  assert.notEqual(second.resultRef, receipt.resultRef);
  assert.deepEqual(h.counts(), { sourceCalls: 2, writes: 1 });
  h.expire();
  await assert.rejects(
    h.host.readResult(
      JSON.stringify({ action: "read_result", resultRef: receipt.resultRef }),
      context,
    ),
    /expired/,
  );
  assert.equal(h.counts().sourceCalls, 2);
});

test("all assets checked: metadata denial, field absence, ambiguous source, cross-source and invalid chart do not execute", async () => {
  const h = harness();
  h.revoke();
  await assert.rejects(h.host.execute(request(), context), /metadata_denied/);
  assert.equal(h.counts().sourceCalls, 0);
  const h2 = harness(),
    bad = structuredClone(plan);
  bad.joins[0].on[1].left.field = "private_missing";
  await assert.rejects(
    h2.host.execute(request({ plan: bad }), context),
    /field_unavailable/,
  );
  await assert.rejects(
    h2.host.execute(request({ chart: { ...chart, y: ["region"] } }), context),
    /chart_invalid/,
  );
  assert.equal(h2.counts().sourceCalls, 0);
  assert.throws(
    () =>
      resolveQueryBinding(
        metadata,
        [binding, { ...binding, id: "duplicate" }],
        actor,
      ),
    /ambiguous/,
  );
  assert.throws(
    () =>
      resolveQueryBinding(
        metadata,
        [binding],
        other.tenant === actor.tenant ? { ...other, tenant: "other" } : other,
      ),
    /unavailable/,
  );
});

test("wrong actor/viewer/org, lost browser grant and post-query revocation deny results without SQL replay", async () => {
  const h = harness(),
    input = request();
  const receipt = await h.host.execute(input, context);
  await assert.rejects(
    h.host.request(authorize(receipt.resultRef), { ...context, actor: other }),
    /expired/,
  );
  const e = await h.host.request(authorize(receipt.resultRef), context);
  await h.host.request(open(e.displayRef), context);
  for (const [viewerLogin, orgId] of [
    ["bob", "org-2"],
    ["alice", "default"],
  ])
    await assert.rejects(
      h.host.read(e.displayRef, { assertGrant() {}, viewerLogin, orgId }),
      /denied/,
    );
  await assert.rejects(
    h.host.read(e.displayRef, {
      assertGrant() {
        throw new Error("revoked");
      },
      viewerLogin: "alice",
      orgId: "org-2",
    }),
    /revoked/,
  );
  h.revoke();
  await assert.rejects(h.host.execute(input, context), /metadata_denied/);
  await assert.rejects(
    h.host.request(open(e.displayRef), context),
    /metadata_denied/,
  );
  assert.equal(h.counts().sourceCalls, 1);
});

test("DB denial and unknown Grafana write are retained, never replayed; empty result is EMPTY not PASS", async () => {
  const denied = harness({
      execute() {
        throw new QueryError("query_source_denied", 403);
      },
    }),
    input = request();
  for (let i = 0; i < 2; i++)
    await assert.rejects(denied.host.execute(input, context), /source_denied/);
  assert.equal(denied.counts().sourceCalls, 1);
  const unknown = harness({
    publish() {
      throw new QueryError("query_grafana_unconfirmed", 502);
    },
  });
  const r = await unknown.host.execute(request(), context);
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      unknown.host.request(authorize(r.resultRef), context),
      /unconfirmed/,
    );
  assert.deepEqual(unknown.counts(), { sourceCalls: 1, writes: 1 });
  const empty = harness({ empty: true });
  assert.equal((await empty.host.execute(request(), context)).state, "EMPTY");
});

test("operator login aliases bind existing Viewer accounts without becoming SQL grant lists", async () => {
  const h = harness({
    grafana: { subjectLogins: { [actor.urn]: "alice-viewer" } },
  });
  const r = await h.host.execute(request(), context),
    e = await h.host.request(authorize(r.resultRef), context);
  await h.host.request(open(e.displayRef), context);
  const c = { assertGrant() {}, viewerLogin: "alice-viewer", orgId: "org-2" };
  assert.equal((await h.host.read(e.displayRef, c)).length, 2);
  await assert.rejects(
    h.host.read(e.displayRef, { ...c, viewerLogin: "alice" }),
    /denied/,
  );
  const conflict = harness({
    grafana: { subjectLogins: { [other.urn]: "alice" } },
  });
  const stillAuthorized = await conflict.host.execute(request(), context);
  await assert.rejects(
    conflict.host.request(authorize(stillAuthorized.resultRef), context),
    /identity_unavailable/,
  );
  assert.equal(
    conflict.counts().sourceCalls,
    1,
    "identity mismatch is not a SQL allowlist",
  );
  assert.throws(
    () =>
      queryGrafanaConfig(
        {
          ...grafana,
          subjectLogins: { [actor.urn]: "shared", [other.urn]: "shared" },
        },
        "http://localhost:9002",
      ),
    /identity_configuration/,
  );
});

test("native DataHub adapter uses caller cookies, exact privileges and metadata; no arbitrary GraphQL or endpoints", async () => {
  const calls = [];
  const reader = queryMetadataReader({
    frontendOrigin: "http://localhost:9002",
    fetchImpl: async (url, options) => {
      assert.equal(url.pathname, "/api/v2/graphql");
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers.cookie, context.cookieHeader);
      const { query, variables } = JSON.parse(options.body);
      calls.push({ query, variables });
      let data;
      if (query === CATALOG_QUERIES.identity)
        data = { me: { corpUser: { urn: actor.urn } } };
      else if (query === CATALOG_QUERIES.privileges)
        data = { getGrantedPrivileges: { privileges: ["GET_ENTITY"] } };
      else {
        const m = metadata.find((m) => m.urn === variables.urn);
        data = {
          entity: {
            urn: m.urn,
            type: "DATASET",
            name: m.qualifiedName.split(".").at(-1),
            platform: { name: m.platform },
            dataPlatformInstance: { urn: m.platformInstanceUrn },
            properties: { origin: m.environment, qualifiedName: null },
            schemaMetadata: {
              version: 1,
              fields: m.fields.map((f) => ({
                fieldPath: f.path,
                nativeDataType: f.nativeType,
                type: "STRING",
              })),
            },
          },
        };
      }
      return Response.json({ data });
    },
  });
  const snapshots = await authorizeQueryMetadata(plan, reader, context);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(
    snapshots.map((s) => s.qualifiedName),
    metadata.map((m) => m.qualifiedName),
  );
  assert.equal(
    resolveQueryBinding(snapshots, queryBindings([binding]), actor).id,
    binding.id,
  );
  assert.deepEqual(
    calls
      .filter((c) => c.query === CATALOG_QUERIES.privileges)
      .map((c) => c.variables.input.resourceSpec.resourceUrn),
    metadata.map((m) => m.urn),
  );
});

test("every chart's companion table retains all returned columns and shares the same result, including truncation", () => {
  const displayRef = randomUUID();
  const columns = [
    { name: "day", type: "time" },
    { name: "total", type: "number" },
    { name: "extra", type: "string" },
  ];
  for (const type of ["table", "bar", "timeseries", "stat"]) {
    const dashboard = buildQueryDashboard({
      uid: `dq-${displayRef.replaceAll("-", "")}`,
      displayRef,
      chart: {
        title: "Fixture",
        type,
        ...(type === "table" ? {} : { y: ["total"] }),
        ...(type === "bar" || type === "timeseries" ? { x: "day" } : {}),
      },
      columns,
      config: grafana,
      rows: [{ day: "2026-09-27", total: "12.34", extra: "FIXTURE" }],
      truncated: true,
    });
    assert.equal(dashboard.panels.length, type === "table" ? 1 : 2);
    const table = dashboard.panels.find((panel) => panel.type === "table");
    assert.deepEqual(
      table.targets[0].columns.map((c) => c.selector),
      columns.map((c) => c.name),
    );
    assert.ok(table.targets[0].columns.every((c) => c.type === "string"));
    assert.ok(
      dashboard.panels.every(
        (panel) => panel.targets[0].url === table.targets[0].url,
      ),
    );
    assert.match(dashboard.description, /TRUNCATED/);
    assert.ok(
      dashboard.panels.every((panel) =>
        panel.title.includes("已截斷，僅含前 1 筆"),
      ),
    );
  }
});

test("native Grafana create-only write and exact readback; time series range is actual data range, not today", async () => {
  let saved,
    folder,
    permissions,
    writes = 0;
  const publish = createQueryGrafana({
    config: grafana,
    getToken: async () => "synthetic-token",
    fetchImpl: async (url, options) => {
      assert.equal(options.headers["X-Grafana-Org-Id"], "2");
      if (url.pathname === "/api/org") return Response.json({ id: 2 });
      if (url.pathname === "/api/user")
        return Response.json({ id: 9, orgId: 2 });
      if (url.pathname === "/api/org/users/lookup")
        return Response.json([{ userId: 3, login: "alice" }]);
      if (url.pathname === "/api/folders") {
        folder = JSON.parse(options.body);
        return Response.json(folder);
      }
      if (url.pathname.endsWith("/permissions")) {
        if (options.method === "POST")
          permissions = JSON.parse(options.body).items;
        return Response.json(permissions);
      }
      if (url.pathname.startsWith("/api/folders/"))
        return folder
          ? Response.json(folder)
          : new Response("", { status: 404 });
      if (options.method === "POST") {
        writes++;
        const body = JSON.parse(options.body);
        assert.equal(body.overwrite, false);
        assert.equal(body.folderUid, folder.uid);
        assert.deepEqual(permissions, [
          { userId: 3, permission: 1 },
          { userId: 9, permission: 4 },
        ]);
        saved = body.dashboard;
        return Response.json({ uid: saved.uid, status: "success" });
      }
      // JSON object member order is not part of the native API contract.
      const reorder = (value) =>
        Array.isArray(value)
          ? value.map(reorder)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => [k, reorder(v)]),
              )
            : value;
      return Response.json({
        dashboard: reorder(saved),
        meta: { folderUid: folder.uid },
      });
    },
  });
  const displayRef = randomUUID(),
    uid = `dq-${displayRef.replaceAll("-", "")}`;
  await publish(
    {
      uid,
      displayRef,
      viewerLogin: "alice",
      chart: {
        title: "Historical trend",
        type: "timeseries",
        x: "day",
        y: ["total"],
      },
      columns: [
        { name: "day", type: "time" },
        { name: "total", type: "number" },
      ],
      rows: [
        { day: "2014-01-01", total: "1" },
        { day: "2014-06-30", total: "2" },
      ],
    },
    context,
  );
  assert.equal(writes, 1);
  assert.match(saved.time.from, /^2013-12-31/);
  assert.match(saved.time.to, /^2014-06-30/);
  assert.equal(saved.panels[0].type, "timeseries");
  assert.equal(saved.panels[1].type, "table");
  for (const panel of saved.panels) {
    // Infinity 3.11.2 reads url_options.method before sending its query.
    assert.equal(panel.targets[0].url_options?.method, "GET");
  }
  assert.equal(
    saved.panels[1].targets[0].columns[1].type,
    "string",
    "table preserves decimal text; chart uses floats",
  );
  // A subsequently shared folder must not receive another private dashboard.
  permissions.push({ role: "Viewer", permission: 1 });
  await assert.rejects(
    publish(
      {
        uid,
        displayRef,
        viewerLogin: "alice",
        chart,
        columns: [
          { name: "region", type: "string" },
          { name: "revenue", type: "number" },
        ],
      },
      context,
    ),
    /folder_not_private/,
  );
  assert.equal(writes, 1);
});

test("running child cancellation drains close before releasing the query promise", async () => {
  const child = new EventEmitter(),
    kills = [],
    controller = new AbortController();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    kills.push(signal);
    return true;
  };
  const promise = runQueryChild(
    { operation: "compile" },
    {
      signal: controller.signal,
      spawnProcess(_python, args, options) {
        assert.equal(options.shell, false);
        assert.deepEqual(args.slice(0, 2), ["-I", "-B"]);
        assert.equal(options.env.HOME, "/dev/null");
        return child;
      },
    },
  );
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(kills, ["SIGTERM"]);
  child.emit("close", null, "SIGTERM");
  await assert.rejects(promise, /query_cancelled/);
});

test("cancelled compiler subprocess does not launch", async () => {
  const controller = new AbortController();
  controller.abort();
  let launches = 0;
  await assert.rejects(
    runQueryChild(
      { operation: "compile" },
      {
        signal: controller.signal,
        spawnProcess() {
          launches++;
        },
      },
    ),
    /cancelled/,
  );
  assert.equal(launches, 0);
});
