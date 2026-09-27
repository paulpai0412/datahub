import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { default: sqlRegister } = await jiti.import(
  "./datahub-sql-extension.ts",
);
const { default: grafanaRegister } = await jiti.import(
  "./datahub-grafana-extension.ts",
);
let sql, grafana;
sqlRegister({
  registerTool(t) {
    sql = t;
  },
});
grafanaRegister({
  registerTool(t) {
    grafana = t;
  },
});
const resultRef = "11111111-1111-4111-8111-111111111111";
const urn =
  "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture.main.table,TEST)";
const receipt = (request) => ({
  format: "datahub-query.receipt/1",
  action: "execute_query",
  requestId: request.requestId,
  resultRef,
  datasetUrns: [urn],
  resultExpiresAt: Date.now() + 900000,
  state: "AVAILABLE",
});
const embed = (request) => ({
  format: "datahub-grafana.embed/2",
  requestId: request.requestId,
  displayRef: resultRef,
  dashboardUid: `dq-${resultRef.replaceAll("-", "")}`,
  orgId: 2,
  title: "Dynamic query",
  datasetUrns: [urn],
  resultExpiresAt: Date.now() + 900000,
  status: "QUERY_RESULT",
});

test("general tools use metadata query intent and dynamic Grafana contract, not fixed metric or dates", async () => {
  assert.ok(sql.parameters.properties.plan.properties.joins);
  assert.equal(sql.parameters.properties.metric, undefined);
  const sent = [];
  const r = await sql.execute(
    "test",
    {
      plan: { datasets: [{ urn, alias: "x" }] },
      chart: { title: "Dynamic", type: "table" },
    },
    undefined,
    undefined,
    {
      mode: "rpc",
      ui: {
        input: async (title, body) => {
          const request = JSON.parse(body);
          sent.push(request);
          assert.equal(title, "DataHub SQL request");
          return JSON.stringify(receipt(request));
        },
      },
    },
  );
  assert.equal(sent[0].action, "execute_query");
  assert.deepEqual(r.content, [
    { type: "text", text: JSON.stringify(r.details) },
  ]);
  const g = await grafana.execute("test", { resultRef }, undefined, undefined, {
    mode: "rpc",
    ui: {
      input: async (_title, body) => JSON.stringify(embed(JSON.parse(body))),
    },
  });
  assert.equal(g.details.format, "datahub-grafana.embed/2");
  assert.equal("url" in g.details, false);
});

test("tools describe the companion table actually supplied by every chart, not a second SQL query", () => {
  for (const tool of [sql, grafana]) {
    assert.match(tool.description, /bar, timeseries and stat.*result table/i);
    assert.match(tool.description, /same returned rows and columns/i);
    assert.match(tool.description, /limit.*truncation/i);
    assert.match(tool.description, /not.*underlying.*transaction/i);
    assert.match(tool.description, /do not.*repeat.*query.*table/i);
  }
});

test("multi-dataset receipts are not truncated by the historical 4 KiB Grafana response limit", async () => {
  const datasetUrns = Array.from(
    { length: 8 },
    (_, i) => `urn:li:dataset:${"表".repeat(650)}${i}`,
  );
  for (const [tool, make] of [
    [sql, receipt],
    [grafana, embed],
  ]) {
    const result = await tool.execute(
      "test",
      { resultRef },
      undefined,
      undefined,
      {
        mode: "rpc",
        ui: {
          input: async (_title, body) =>
            JSON.stringify({ ...make(JSON.parse(body)), datasetUrns }),
        },
      },
    );
    assert.deepEqual(result.details.datasetUrns, datasetUrns);
  }
});

test("host output cannot leak SQL, source values, credentials or arbitrary URL into model receipts", async () => {
  for (const [tool, make] of [
    [sql, receipt],
    [grafana, embed],
  ]) {
    for (const extra of [
      { rows: [{ private: 1 }] },
      { sql: "SELECT private" },
      { password: "secret" },
      { url: "http://elsewhere" },
      { requestId: "wrong" },
    ])
      await assert.rejects(
        tool.execute("test", { resultRef }, undefined, undefined, {
          mode: "rpc",
          ui: {
            input: async (_t, b) =>
              JSON.stringify({ ...make(JSON.parse(b)), ...extra }),
          },
        }),
        /invalid_host_response/,
      );
    await assert.rejects(
      tool.execute("test", { resultRef }, undefined, undefined, {
        mode: "rpc",
        ui: {
          input: async () => JSON.stringify({ error: "query_source_denied" }),
        },
      }),
      /query_source_denied/,
    );
  }
});
