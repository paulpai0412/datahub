import assert from "node:assert/strict";
import test from "node:test";
import { sqlAssetAuthorizer } from "../extensions/datahub-agent/integration/native-sql-assets.mjs";
import { CATALOG_QUERIES } from "../extensions/datahub-agent/integration/native-catalog.mjs";

const policy = {
  datasetUrn:
    "urn:li:dataset:(urn:li:dataPlatform:mssql,salesdatamart.reporting.v_sales_order_line,PROD)",
  chartUrn: "urn:li:chart:(grafana,dataflow-sales-v1.5)",
  dashboardUrn: "urn:li:dashboard:(grafana,dataflow-sales-v1)",
};
const actor = {
  tenant: "ekop",
  key: "a".repeat(48),
  urn: "urn:li:corpuser:alice",
};
const context = {
  actor,
  cookieHeader: "PLAY_SESSION=synthetic; actor=synthetic",
  assertActive() {},
};

function native({
  deny,
  missing,
  switchActor,
  malformedErrors,
  status = 200,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const { query, variables } = JSON.parse(options.body);
    calls.push({ query, variables, cookie: options.headers.cookie });
    let data;
    if (query === CATALOG_QUERIES.identity)
      data = {
        me: {
          corpUser: { urn: switchActor ? "urn:li:corpuser:bob" : actor.urn },
        },
      };
    else if (query === CATALOG_QUERIES.privileges)
      data = {
        getGrantedPrivileges: { privileges: deny ? [] : ["VIEW_ENTITY_PAGE"] },
      };
    else
      data = {
        entity: missing
          ? null
          : {
              urn: variables.urn,
              type:
                variables.urn === policy.datasetUrn
                  ? "DATASET"
                  : variables.urn === policy.chartUrn
                    ? "CHART"
                    : "DASHBOARD",
            },
      };
    assert.equal(url.pathname, "/api/v2/graphql");
    assert.equal(options.redirect, "manual");
    return new Response(
      JSON.stringify({ data, ...(malformedErrors ? { errors: {} } : {}) }),
      { status, headers: { "content-type": "application/json" } },
    );
  };
  return {
    calls,
    authorize: sqlAssetAuthorizer({
      frontendOrigin: "http://localhost:9002",
      fetchImpl,
    }),
  };
}

test("current actor and all three exact native assets are visible before source admission", async () => {
  const { calls, authorize } = native();
  assert.equal(await authorize(context, policy), true);
  assert.equal(calls.length, 7);
  assert.deepEqual(
    calls
      .filter((item) => item.query === CATALOG_QUERIES.privileges)
      .map((item) => item.variables.input.resourceSpec.resourceUrn),
    [policy.datasetUrn, policy.chartUrn, policy.dashboardUrn],
  );
  assert.ok(calls.every((item) => item.cookie === context.cookieHeader));
});

test("actor mismatch, missing cookie, native grant or entity deny without checking source", async () => {
  for (const options of [
    { deny: true },
    { missing: true },
    { switchActor: true },
  ]) {
    const { authorize } = native(options);
    await assert.rejects(authorize(context, policy), /sql_not_authorized/);
  }
  const { authorize, calls } = native();
  await assert.rejects(
    authorize({ ...context, cookieHeader: "PLAY_SESSION=synthetic" }, policy),
    /sql_not_authorized/,
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    native({ status: 503 }).authorize(context, policy),
    /sql_native_unavailable/,
  );
  await assert.rejects(
    native({ malformedErrors: true }).authorize(context, policy),
    /sql_native_unavailable/,
  );
});
