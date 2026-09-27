// Real compiler/Host result contract; explicitly synthetic driver and publisher.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createMetadataQueryHost } from "../extensions/datahub-agent/integration/metadata-query.mjs";
import { createQuerySource } from "../extensions/datahub-agent/integration/query-source.mjs";
import { buildQueryDashboard } from "../extensions/datahub-agent/integration/query-grafana.mjs";
import {
  actor,
  binding,
  metadata,
  context,
  grafana,
} from "./fixtures/query-fixture.mjs";

const meta = [structuredClone(metadata[0])];
meta[0].fields = [
  { path: "id", nativeType: "bigint" },
  { path: "amount", nativeType: "decimal(38,18)" },
  { path: "label", nativeType: "nvarchar(8192)" },
  { path: "day", nativeType: "date" },
  { path: "enabled", nativeType: "bit" },
];
const plan = {
  datasets: [{ urn: meta[0].urn, alias: "p" }],
  joins: [],
  select: meta[0].fields.map(({ path }) => ({
    field: { dataset: "p", field: path },
    as: path,
  })),
  filters: [],
  groupBy: [],
  orderBy: [{ field: "id", direction: "asc" }],
  limit: 2,
};
const exactRows = [
  {
    id: "9223372036854775807",
    amount: "12345678901234567890.123456789012345678",
    label: "",
    day: "2026-09-27",
    enabled: false,
  },
  {
    id: "-9223372036854775808",
    amount: null,
    label: "中文📦",
    day: null,
    enabled: true,
  },
];
function harness(mutate = (result) => result) {
  const compiler = createQuerySource();
  let calls = 0,
    writes = 0,
    dashboard;
  const host = createMetadataQueryHost({
    bindings: [binding],
    readMetadata: async () => ({ snapshots: meta, visible: async () => true }),
    source: {
      ...compiler,
      execute: async (...args) => {
        calls++;
        const c = await compiler.compile(...args);
        return mutate({
          columns: c.columns,
          rows: structuredClone(exactRows),
          sql: c.sql,
          truncated: false,
          observedAt: "2026-09-27T00:00:00Z",
        });
      },
    },
    grafana,
    verifyIdentity: async () => actor,
    publishDashboard: async (args) => {
      writes++;
      dashboard = buildQueryDashboard({ ...args, config: grafana });
    },
  });
  return {
    host,
    counts: () => ({ calls, writes }),
    dashboard: () => dashboard,
  };
}
const input = () =>
  JSON.stringify({
    action: "execute_query",
    requestId: randomUUID(),
    plan,
    chart: { type: "bar", title: "合成精度邊界", x: "label", y: ["amount"] },
  });
const read = (h, resultRef) =>
  h.host.readResult(
    JSON.stringify({ action: "read_result", resultRef }),
    context,
  );
async function display(h, receipt) {
  const embed = await h.host.request(
    JSON.stringify({
      action: "grafana_authorize",
      resultRef: receipt.resultRef,
      requestId: randomUUID(),
    }),
    context,
  );
  await h.host.request(
    JSON.stringify({
      action: "grafana_open",
      displayRef: embed.displayRef,
      requestId: randomUUID(),
    }),
    context,
  );
  const rows = await h.host.read(embed.displayRef, {
    assertGrant() {},
    viewerLogin: "alice",
    orgId: "org-2",
  });
  return { embed, rows };
}

test("exact strings/null/false/empty string survive Host/UI/Grafana result reads, never model receipts", async () => {
  const h = harness(),
    request = input(),
    r = await h.host.execute(request, context);
  assert.equal(r.state, "AVAILABLE");
  assert.deepEqual(Object.keys(r).sort(), [
    "action",
    "datasetUrns",
    "format",
    "requestId",
    "resultExpiresAt",
    "resultRef",
    "state",
  ]);
  assert.deepEqual((await read(h, r.resultRef)).rows, exactRows);
  const { embed, rows } = await display(h, r);
  assert.deepEqual(rows, exactRows);
  assert.deepEqual((await read(h, r.resultRef)).rows, exactRows);
  assert.deepEqual(await h.host.execute(request, context), r);
  for (const secret of [
    exactRows[0].amount,
    exactRows[0].id,
    "SELECT",
    "rows",
    "columns",
    "truncated",
  ])
    assert.equal(JSON.stringify([r, embed]).includes(secret), false);
  const table = h.dashboard().panels.find((p) => p.type === "table");
  assert.ok(table.targets[0].columns.every((c) => c.type === "string"));
  assert.equal(
    h
      .dashboard()
      .panels[0].targets[0].columns.find((c) => c.selector === "amount").type,
    "number",
  );
  // Numeric chart projection is necessarily lossy; exact values belong to table.
  assert.notEqual(String(Number(exactRows[0].id)), exactRows[0].id);
  assert.deepEqual(h.counts(), { calls: 1, writes: 1 });
});

test("EMPTY is not zero or PASS; all-null/zero rows remain AVAILABLE", async () => {
  for (const rows of [
    [],
    [{ id: null, amount: null, label: null, day: null, enabled: null }],
    [
      {
        id: "0",
        amount: "0.000000000000000000",
        label: "",
        day: null,
        enabled: false,
      },
    ],
  ]) {
    const h = harness((r) => ({ ...r, rows })),
      r = await h.host.execute(input(), context);
    assert.equal(r.state, rows.length ? "AVAILABLE" : "EMPTY");
    const d = await display(h, r);
    assert.equal(d.embed.status, rows.length ? "QUERY_RESULT" : "EMPTY");
    assert.deepEqual(d.rows, rows);
    assert.equal(
      h.dashboard().description.includes("EMPTY result"),
      !rows.length,
    );
    assert.deepEqual(h.counts(), { calls: 1, writes: 1 });
  }
});

test("truncation retained in UI-only readback and native dashboard, refresh never reruns SQL", async () => {
  const h = harness((r) => ({ ...r, truncated: true })),
    r = await h.host.execute(input(), context);
  assert.equal((await read(h, r.resultRef)).truncated, true);
  await display(h, r);
  assert.match(h.dashboard().description, /TRUNCATED at requested row limit/);
  // Truncation must be visible on the result panel, not hidden in dashboard settings.
  assert.match(
    h.dashboard().panels.find((p) => p.type === "table").title,
    /截斷/,
  );
  assert.deepEqual(h.counts(), { calls: 1, writes: 1 });
});

test("oversized or malformed result is retained as failure, no receipt/publication/retry; new request recovers", async () => {
  for (const corrupt of [
    (r) => ({ ...r, rows: [...r.rows, r.rows[0]] }),
    (r) => ({ ...r, rows: [{ ...r.rows[0], label: "界".repeat(8193) }] }),
    (r) => ({ ...r, rows: [{ ...r.rows[0], amount: "NaN" }] }),
    (r) => ({ ...r, rows: [{ ...r.rows[0], amount: Infinity }] }),
    (r) => ({ ...r, rows: [{ ...r.rows[0], day: "not-a-date" }] }),
    (r) => ({ ...r, rows: [{ ...r.rows[0], extra: "unexpected" }] }),
  ]) {
    let broken = true;
    const h = harness((r) => (broken ? corrupt(r) : r)),
      request = input();
    await assert.rejects(
      h.host.execute(request, context),
      /query_result_invalid/,
    );
    await assert.rejects(
      h.host.execute(request, context),
      /query_result_invalid/,
    );
    assert.deepEqual(h.counts(), { calls: 1, writes: 0 });
    broken = false;
    assert.equal((await h.host.execute(input(), context)).state, "AVAILABLE");
    assert.deepEqual(h.counts(), { calls: 2, writes: 0 });
  }
});
