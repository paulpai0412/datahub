import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { default: register } = await jiti.import(
  "./datahub-grafana-extension.ts",
);
const { isGrafanaEmbed } = await jiti.import("./grafana-embed-contract.ts");
let tool;
register({
  registerTool(value) {
    tool = value;
  },
});
const params = { resultRef: "11111111-1111-4111-8111-111111111111" };
const receipt = (request) => ({
  format: "datahub-grafana.embed/1",
  requestId: request.requestId,
  displayRef: "22222222-2222-4222-8222-222222222222",
  dashboardUid: "sales-monthly-category",
  orgId: 2,
  title: "Source-only Sales",
  datasetUrn:
    "urn:li:dataset:(urn:li:dataPlatform:mssql,SalesDatamart.reporting.v_sales_order_line,PROD)",
  from: "2014-06-01",
  to: "2014-06-30",
  resultExpiresAt: Date.now() + 60000,
  status: "SOURCE_ONLY_NOT_RECONCILED",
});
test("Grafana tool requests only display metadata; no SQL, credentials or URL in model result", async () => {
  const calls = [];
  const result = await tool.execute("test", params, undefined, undefined, {
    mode: "rpc",
    ui: {
      input: async (title, body) => {
        calls.push({ title, body: JSON.parse(body) });
        return JSON.stringify(receipt(JSON.parse(body)));
      },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, "DataHub Grafana request");
  assert.equal(calls[0].body.action, "grafana_authorize");
  assert.ok(isGrafanaEmbed(result.details));
  assert.equal(result.details.url, undefined);
  assert.equal(result.details.status, "SOURCE_ONLY_NOT_RECONCILED");
  assert.equal(calls[0].body.resultRef, params.resultRef);
});
test("unknown historical fields, denial, foreign response, date suffix and source values rejected", async () => {
  for (const patch of [
    { url: "http://evil.test" },
    { points: [1] },
    { synthetic: false },
    { to: "2014-06-30junk" },
    { orgId: 0 },
    { resultExpiresAt: 0 },
    { requestId: "other" },
  ]) {
    await assert.rejects(
      tool.execute("test", params, undefined, undefined, {
        mode: "rpc",
        ui: {
          input: async (_title, body) =>
            JSON.stringify({ ...receipt(JSON.parse(body)), ...patch }),
        },
      }),
      /grafana_invalid_host_response/,
    );
  }
  await assert.rejects(
    tool.execute("test", params, undefined, undefined, { mode: "cli" }),
    /host_required/,
  );
  await assert.rejects(
    tool.execute("test", params, undefined, undefined, {
      mode: "rpc",
      ui: { input: async () => undefined },
    }),
    /cancelled/,
  );
});
