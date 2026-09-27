// Worker for the owned SQL fixture. No model, DataHub ACL or real Grafana here.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createMetadataQueryHost } from "../../extensions/datahub-agent/integration/metadata-query.mjs";
import {
  createQuerySource,
  runQueryChild,
} from "../../extensions/datahub-agent/integration/query-source.mjs";
import { buildQueryDashboard } from "../../extensions/datahub-agent/integration/query-grafana.mjs";
import { actor, context, grafana } from "./query-fixture.mjs";
const out = resolve(process.argv[2]);
const proof = {
  complete: false,
  sourceDispatches: 0,
  cases: [],
  publications: 0,
};
const fields = [
  ["id", "int"],
  ["big", "bigint"],
  ["amount", "decimal(38,18)"],
  ["label", "nvarchar(max)"],
  ["day", "date"],
  ["enabled", "bit"],
  ["payload", "nvarchar(max)"],
];
const metadata = [
  {
    urn: "urn:li:dataset:(urn:li:dataPlatform:mssql,query_boundaries.dbo.result_probe,TEST)",
    qualifiedName: "query_boundaries.dbo.result_probe",
    platform: "mssql",
    platformInstanceUrn: null,
    environment: "TEST",
    schemaVersion: 1,
    fields: fields.map(([path, nativeType]) => ({ path, nativeType })),
  },
];
const binding = {
  id: "result-boundary-test",
  tenant: actor.tenant,
  platform: "mssql",
  platformInstanceUrn: null,
  environment: "TEST",
  database: "query_boundaries",
  datasetPrefix: "",
  connectionPath: join(out, "connection-private.json"),
};
const projections = fields
  .slice(0, -1)
  .map(([field]) => ({ field: { dataset: "p", field }, as: field }));
const plan = (limit, filters = [], select = projections) => ({
  datasets: [{ urn: metadata[0].urn, alias: "p" }],
  joins: [],
  select,
  filters,
  groupBy: [],
  orderBy: select.some((s) => s.as === "id")
    ? [{ field: "id", direction: "asc" }]
    : [],
  limit,
});
const filter = (op, value) => [
  { field: { dataset: "p", field: "id" }, op, value },
];
const exact = [
  {
    id: "1",
    big: "9223372036854775807",
    amount: "12345678901234567890.123456789012345678",
    label: "",
    day: "2026-09-27",
    enabled: false,
  },
  {
    id: "2",
    big: "-9223372036854775808",
    amount: "-123.000000000000000001",
    label: "中文📦",
    day: null,
    enabled: true,
  },
  { id: "3", big: null, amount: null, label: null, day: null, enabled: null },
];
const cases = [
  {
    name: "exact_limit_precision_nulls",
    plan: plan(3, filter("lte", 3)),
    rows: exact,
    truncated: false,
  },
  { name: "empty", plan: plan(3, filter("lt", 0)), rows: [], truncated: false },
  {
    name: "empty_sum_count",
    plan: plan(3, filter("lt", 0), [
      {
        field: { dataset: "p", field: "amount" },
        aggregate: "sum",
        as: "total",
      },
      { field: null, aggregate: "count", as: "count" },
    ]),
    rows: [{ total: null, count: "0" }],
    truncated: false,
  },
  {
    name: "truncated",
    plan: plan(1),
    rows: exact.slice(0, 1),
    truncated: true,
  },
  {
    name: "max_limit",
    plan: plan(1000, [], projections.slice(0, 1)),
    rows: Array.from({ length: 1000 }, (_, i) => ({ id: String(i + 1) })),
    truncated: true,
  },
  {
    name: "oversized_cell",
    plan: plan(1, filter("eq", 1002), [
      { field: { dataset: "p", field: "payload" }, as: "payload" },
    ]),
    error: "query_result_too_large",
  },
  {
    name: "oversized_utf8_bytes",
    plan: plan(50, filter("lte", 50), [
      { field: { dataset: "p", field: "payload" }, as: "payload" },
    ]),
    error: "query_result_too_large",
  },
  {
    name: "recovery",
    plan: plan(1, filter("eq", 1), projections.slice(0, 1)),
    rows: [{ id: "1" }],
    truncated: false,
  },
];
let activeCase;
const source = createQuerySource({
  run: async (payload, ctx) => {
    if (payload.operation === "execute") {
      proof.sourceDispatches++;
      assert.ok(proof.sourceDispatches <= 8, "approved_test_ceiling");
    }
    return runQueryChild(payload, ctx);
  },
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
  publishDashboard: async (args) => {
    proof.publications++;
    activeCase.dashboard = buildQueryDashboard({ ...args, config: grafana });
  },
});
const save = () =>
  writeFile(
    join(out, "host-results-private.json"),
    JSON.stringify(proof, null, 2) + "\n",
    { mode: 0o600 },
  );
try {
  for (const spec of cases) {
    activeCase = { name: spec.name, passed: false };
    proof.cases.push(activeCase);
    const chart = { type: "table", title: `合成邊界 ${spec.name}` };
    const request = JSON.stringify({
      action: "execute_query",
      requestId: randomUUID(),
      plan: spec.plan,
      chart,
    });
    if (spec.error) {
      for (let n = 0; n < 2; n++)
        await assert.rejects(
          host.execute(request, context),
          (e) => e.message === spec.error,
        );
      activeCase.error = spec.error;
    } else {
      const receipt = await host.execute(request, context);
      assert.equal(receipt.state, spec.rows.length ? "AVAILABLE" : "EMPTY");
      const result = await host.readResult(
        JSON.stringify({ action: "read_result", resultRef: receipt.resultRef }),
        context,
      );
      assert.deepEqual(result.rows, spec.rows);
      assert.equal(result.truncated, spec.truncated);
      assert.deepEqual(await host.execute(request, context), receipt);
      assert.equal(
        "rows" in receipt ||
          "sql" in receipt ||
          "columns" in receipt ||
          "truncated" in receipt,
        false,
      );
      const embed = await host.request(
        JSON.stringify({
          action: "grafana_authorize",
          resultRef: receipt.resultRef,
          requestId: randomUUID(),
        }),
        context,
      );
      await host.request(
        JSON.stringify({
          action: "grafana_open",
          displayRef: embed.displayRef,
          requestId: randomUUID(),
        }),
        context,
      );
      assert.deepEqual(
        await host.read(embed.displayRef, {
          assertGrant() {},
          viewerLogin: "alice",
          orgId: "org-2",
        }),
        spec.rows,
      );
      activeCase.result = result;
      activeCase.receipt = receipt;
      activeCase.embed = embed;
      if (spec.truncated)
        assert.ok(
          activeCase.dashboard.panels.every((p) => p.title.includes("截斷")),
        );
    }
    activeCase.passed = true;
    await save();
  }
  assert.equal(proof.sourceDispatches, 8);
  proof.complete = true;
} catch (error) {
  proof.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  await save();
  console.log(
    JSON.stringify({
      complete: proof.complete,
      sourceDispatches: proof.sourceDispatches,
      cases: proof.cases.map((c) => ({ name: c.name, passed: c.passed })),
    }),
  );
}
