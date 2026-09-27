import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { default: register } = await jiti.import(
  "./datahub-dashboard-extension.ts",
);
const { isDashboardDraft } = await jiti.import("./dashboard-draft-contract.ts");
const tools = [];
register({
  registerTool(tool) {
    tools.push(tool);
  },
});
const tool = tools[0];
const urn = "urn:li:dataset:(urn:li:dataPlatform:mssql,example,PROD)";
const params = {
  datasetUrn: urn,
  title: "Order count",
  metric: "Distinct orders",
  dimension: "Order month",
  visualization: "line",
};
function result(request, overrides = {}) {
  const entity = {
    urn,
    type: "DATASET",
    name: "Example orders",
    qualifiedName: null,
    description: null,
    platform: null,
    platformUrn: null,
    platformInstanceUrn: null,
    environment: null,
    ingestedAt: null,
    url: null,
    parentUrn: null,
  };
  return JSON.stringify({
    format: "datahub-catalog/1",
    action: "entity",
    readOnly: true,
    requestId: request.requestId,
    request,
    queriedAt: "2026-09-25T00:00:00.000Z",
    limitations: [],
    entity: { ...entity, ...overrides },
    fields: [],
    references: [],
    properties: [],
    schemaFieldCount: 0,
    schemaVersion: null,
    schemaCreatedAt: null,
    pagination: {
      offset: 0,
      limit: 1,
      total: 0,
      nextOffset: null,
      completeness: "complete",
    },
  });
}

test("arbitrary Dataset proposal reads native Catalog but never calls SQL or Grafana", async () => {
  assert.equal(tools.length, 1);
  const calls = [];
  const ctx = {
    mode: "rpc",
    ui: {
      input: async (title, payload) => {
        calls.push({ title, request: JSON.parse(payload) });
        return result(JSON.parse(payload));
      },
    },
  };
  const output = await tool.execute("id", params, undefined, undefined, ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, "DataHub catalog request");
  assert.deepEqual(
    { ...calls[0].request, requestId: undefined },
    { action: "entity", urn, offset: 0, limit: 1, requestId: undefined },
  );
  assert.equal(output.details.state, "UNAPPROVED_NOT_EXECUTED");
  assert.equal(output.details.datasetUrn, urn);
  assert.ok(isDashboardDraft(output.details));
  assert.equal(Object.hasOwn(output.details, "values"), false);
  assert.equal(Object.hasOwn(output.details, "sql"), false);
});

test("forged asset, denied Catalog, or non-RPC request never yields a draft", async () => {
  await assert.rejects(
    tool.execute("id", params, undefined, undefined, {
      mode: "cli",
      ui: {
        input() {
          throw Error("called");
        },
      },
    }),
    /datahub_host_required/,
  );
  for (const reply of [
    (r) => result(r, { urn: "urn:li:dataset:other" }),
    (r) => result(r, { type: "CHART" }),
    () => JSON.stringify({ error: "catalog_read_denied" }),
  ]) {
    await assert.rejects(
      tool.execute("id", params, undefined, undefined, {
        mode: "rpc",
        ui: { input: async (_title, payload) => reply(JSON.parse(payload)) },
      }),
      /dashboard_catalog_denied/,
    );
  }
});
