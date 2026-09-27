import assert from "node:assert/strict";
import test from "node:test";
import {
  createSqlHost,
  sqlPolicies,
} from "../extensions/datahub-agent/integration/native-sql.mjs";

const keyA = "a".repeat(48);
const keyB = "b".repeat(48);
const datasetUrn =
  "urn:li:dataset:(urn:li:dataPlatform:mssql,salesdatamart.reporting.v_sales_order_line,PROD)";
const policy = {
  chartUrn: "urn:li:chart:(grafana,dataflow-sales-v1.5)",
  commonScopeApproved: true,
  dashboardSha256: "a".repeat(64),
  dashboardUrn: "urn:li:dashboard:(grafana,dataflow-sales-v1)",
  datasetUrn,
  expiresAt: 10_000,
  grafanaQueryApproved: true,
  panelId: 5,
  sourceSelectApproved: true,
};
const requestId = "11111111-1111-4111-8111-111111111111";
const execute = (extra = {}) =>
  JSON.stringify({
    action: "execute",
    from: "2014-06-01",
    through: "2014-06-30",
    metric: "sales_by_category",
    requestId,
    ...extra,
  });
const read = (resultRef) =>
  JSON.stringify({ action: "read_result", resultRef });
const points = [
  { month: "2014-06-01", category: "Bikes", salesAmount: "120.500000" },
];
const result = {
  complete: true,
  points,
  observedAt: "2026-09-24T12:00:00Z",
  dataAsOf: null,
};
const actorA = { key: keyA, urn: "urn:li:corpuser:alice", tenant: "ekop" };
const actorB = { key: keyB, urn: "urn:li:corpuser:bob", tenant: "ekop" };
const context = (actor, assertActive = () => {}) => ({ actor, assertActive });
const panelEvidence = (
  totals = [{ category: "Bikes", salesAmount: "120.500000" }],
) => ({
  dashboardSha256: policy.dashboardSha256,
  dashboardUrn: policy.dashboardUrn,
  chartUrn: policy.chartUrn,
  panelId: policy.panelId,
  totals,
});

function host(extra = {}) {
  const calls = [];
  const policies = sqlPolicies({ [keyA]: policy });
  return {
    calls,
    policies,
    sql: createSqlHost({
      policies,
      now: () => 1000,
      authorizeAssets: async (ctx, owned) => {
        calls.push(["assets", ctx.actor.key]);
        assert.equal(owned.datasetUrn, datasetUrn);
        return true;
      },
      executeSource: async (intent) => {
        calls.push(["source", intent]);
        return result;
      },
      compareGrafana: async ({ points: actual }) => {
        calls.push(["grafana", actual]);
        return panelEvidence();
      },
      ...extra,
    }),
  };
}

test("operator policy is fixed, bounded and denies missing grant/executor", () => {
  assert.equal(sqlPolicies().size, 0);
  for (const bad of [
    { ...policy, panelId: 4 },
    { ...policy, sourceSelectApproved: false },
    { ...policy, extra: true },
    { ...policy, datasetUrn: "urn:li:dataset:unsafe\n" },
  ])
    assert.throws(
      () => sqlPolicies({ [keyA]: bad }),
      /sql_configuration_invalid/,
    );
  assert.throws(
    () => sqlPolicies({ bob: policy }),
    /sql_configuration_invalid/,
  );
  assert.throws(
    () => createSqlHost({ policies: sqlPolicies({ [keyA]: policy }) }),
    /sql_not_configured/,
  );
});

test("intent never accepts model SQL, credentials, URLs, unbounded dates or impersonation", async () => {
  const { sql, calls } = host();
  for (const bad of [
    execute({ rawSql: "SELECT 1; DROP TABLE t" }),
    execute({ datasourceUid: "attacker" }),
    execute({ from: "2014-06-01;DELETE" }),
    execute({ from: "2016-01-01" }),
    execute({ from: "2014-06-31" }),
    execute({ requestId: "not-a-uuid" }),
    execute({ metric: "join_anything" }),
  ])
    await assert.rejects(
      sql.execute(bad, context(actorA)),
      /sql_invalid_request/,
    );
  await assert.rejects(
    sql.execute(execute(), context(actorB)),
    /sql_not_authorized/,
  );
  assert.deepEqual(calls, []);
});

test("only trusted execution and Grafana agreement issue an opaque receipt, never numeric tool data", async () => {
  const { sql, calls } = host();
  const receipt = await sql.execute(execute(), context(actorA));
  assert.equal(receipt.format, "datahub-sql.receipt/1");
  assert.equal(JSON.stringify(receipt).includes("120.500000"), false);
  assert.equal(calls.filter(([kind]) => kind === "source").length, 1);
  const card = await sql.readResult(read(receipt.resultRef), context(actorA));
  assert.deepEqual(card.points, points);
  assert.equal(card.dataAsOf, null); // Query time is not source-data freshness.
  card.points[0].salesAmount = "999";
  assert.deepEqual(
    (await sql.readResult(read(receipt.resultRef), context(actorA))).points,
    points,
  );
  await assert.rejects(
    sql.readResult(read(receipt.resultRef), context(actorB)),
    /sql_result_expired/,
  );
  assert.deepEqual(
    (await sql.readResult(read(receipt.resultRef), context(actorA))).points,
    points,
  );
});

test("reconciles every month into exact category totals without trusting a mutable callback", async () => {
  const monthly = [
    points[0],
    { month: "2014-05-01", category: "Bikes", salesAmount: "0.000001" },
    { month: "2014-06-01", category: "Clothing", salesAmount: "0.300000" },
  ];
  const { sql } = host({
    executeSource: async () => ({ ...result, points: monthly }),
    compareGrafana: async ({ points: supplied }) => {
      supplied[0].salesAmount = "999.000000";
      return panelEvidence([
        { category: "Clothing", salesAmount: "0.300000" },
        { category: "Bikes", salesAmount: "120.500001" },
      ]);
    },
  });
  const receipt = await sql.execute(
    execute({ from: "2014-05-01" }),
    context(actorA),
  );
  assert.deepEqual(
    (await sql.readResult(read(receipt.resultRef), context(actorA))).points,
    monthly,
  );
  const tampered = host({
    compareGrafana: async ({ points: supplied }) => {
      supplied[0].salesAmount = "999.000000";
      return panelEvidence([{ category: "Bikes", salesAmount: "999.000000" }]);
    },
  });
  await assert.rejects(
    tampered.sql.execute(execute(), context(actorA)),
    /sql_comparison_inconclusive/,
  );
});

test("denial, drift, expiry and ambiguous result never become a successful card", async () => {
  const { sql, policies } = host();
  const receipt = await sql.execute(execute(), context(actorA));
  policies.delete(keyA);
  await assert.rejects(
    sql.readResult(read(receipt.resultRef), context(actorA)),
    /sql_result_expired/,
  );
  const denied = host({ authorizeAssets: async () => false });
  await assert.rejects(
    denied.sql.execute(execute(), context(actorA)),
    /sql_not_authorized/,
  );
  for (const badEvidence of [
    false,
    true,
    panelEvidence([{ category: "Bikes", salesAmount: "120.499999" }]),
    panelEvidence([{ category: "Components", salesAmount: "120.500000" }]),
    panelEvidence([
      { category: "Bikes", salesAmount: "120.500000" },
      { category: "Bikes", salesAmount: "120.500000" },
    ]),
    { ...panelEvidence(), dashboardSha256: "b".repeat(64) },
    { ...panelEvidence(), panelId: 4 },
  ]) {
    const mismatched = host({ compareGrafana: async () => badEvidence });
    await assert.rejects(
      mismatched.sql.execute(execute(), context(actorA)),
      /sql_comparison_inconclusive/,
    );
  }
  const malformed = host({
    executeSource: async () => ({
      ...result,
      points: [{ ...points[0], salesAmount: "NaN" }],
    }),
  });
  await assert.rejects(
    malformed.sql.execute(execute(), context(actorA)),
    /sql_result_invalid/,
  );
  for (const badResult of [
    { ...result, complete: false },
    { ...result, points: [{ ...points[0], month: "2014-05-01" }] },
    { ...result, points: [{ ...points[0], month: "2014-07-01" }] },
  ]) {
    const truncated = host({ executeSource: async () => badResult });
    await assert.rejects(
      truncated.sql.execute(execute(), context(actorA)),
      /sql_result_invalid/,
    );
  }
  const expired = createSqlHost({
    policies: sqlPolicies({ [keyA]: policy }),
    now: () => 10_000,
    authorizeAssets: async () => true,
    executeSource: async () => result,
    compareGrafana: async () => panelEvidence(),
  });
  await assert.rejects(
    expired.execute(execute(), context(actorA)),
    /sql_not_authorized/,
  );
});

test("explicit source-only policy returns a DISTINCT unverified dashboard receipt, never a Grafana success", async () => {
  const sourcePolicy = {
    ...policy,
    grafanaQueryApproved: false,
    sourceOnlyApproved: true,
    from: "2014-06-01",
    through: "2014-06-30",
  };
  assert.throws(
    () => sqlPolicies({ [keyA]: sourcePolicy }),
    /sql_configuration_invalid/,
  );
  for (const bad of [
    { ...sourcePolicy, from: undefined },
    { ...sourcePolicy, from: "2014-05-01", through: "2014-04-30" },
  ])
    assert.throws(
      () => sqlPolicies({ [keyA]: bad }, { sourceOnly: true }),
      /sql_configuration_invalid/,
    );
  const policies = sqlPolicies({ [keyA]: sourcePolicy }, { sourceOnly: true });
  assert.throws(
    () =>
      createSqlHost({
        policies,
        authorizeAssets: async () => true,
        executeSource: async () => result,
      }),
    /sql_not_configured/,
  );
  assert.throws(
    () =>
      createSqlHost({
        policies,
        sourceOnly: true,
        authorizeAssets: async () => true,
        executeSource: async () => result,
        compareGrafana: async () => panelEvidence(),
      }),
    /sql_not_configured/,
  );
  let reads = 0,
    executions = 0;
  const sql = createSqlHost({
    policies,
    sourceOnly: true,
    now: () => 1000,
    authorizeAssets: async () => {
      reads++;
      return true;
    },
    executeSource: async () => {
      executions++;
      return result;
    },
  });
  for (const outOfScope of [
    execute({ from: "2014-05-01" }),
    execute({ through: "2014-06-29" }),
  ])
    await assert.rejects(
      sql.execute(outOfScope, context(actorA)),
      /sql_not_authorized/,
    );
  assert.equal(reads, 0);
  assert.equal(executions, 0);
  const receipt = await sql.execute(execute(), context(actorA));
  assert.equal(receipt.format, "datahub-sql.source-receipt/1");
  assert.equal(JSON.stringify(receipt).includes("120.500000"), false);
  assert.equal(executions, 1);
  const card = await sql.readResult(read(receipt.resultRef), context(actorA));
  assert.equal(card.format, "datahub-sql.source-card/1");
  assert.deepEqual(card.points, points);
  assert.equal(reads, 3); // before, after and on history read
  await assert.rejects(
    sql.readResult(read(receipt.resultRef), context(actorB)),
    /sql_result_expired/,
  );
  policies.delete(keyA);
  await assert.rejects(
    sql.readResult(read(receipt.resultRef), context(actorA)),
    /sql_result_expired/,
  );
  assert.equal(executions, 1); // opening history never re-executes
});

test("a one-statement source grant consumes UNKNOWN and never replays in the same Host", async () => {
  const oneShot = sqlPolicies(
    {
      [keyA]: {
        ...policy,
        grafanaQueryApproved: false,
        sourceOnlyApproved: true,
        from: "2014-06-01",
        through: "2014-06-30",
        maxExecutions: 1,
      },
    },
    { sourceOnly: true },
  );
  let statements = 0;
  const sql = createSqlHost({
    policies: oneShot,
    sourceOnly: true,
    now: () => 1000,
    authorizeAssets: async () => true,
    executeSource: async () => {
      statements++;
      throw new Error("unknown_outcome");
    },
  });
  await assert.rejects(
    sql.execute(execute(), context(actorA)),
    /unknown_outcome/,
  );
  await assert.rejects(
    sql.execute(execute(), context(actorA)),
    /sql_not_authorized/,
  );
  assert.equal(statements, 1);
});

test("lost parent grant or cancellation after source execution suppresses results", async () => {
  let active = true;
  const { sql, calls } = host();
  const gate = context(actorA, () => {
    if (!active) throw new Error("grant_revoked");
  });
  const custom = host({
    executeSource: async () => {
      active = false;
      return result;
    },
  });
  await assert.rejects(custom.sql.execute(execute(), gate), /grant_revoked/);
  active = true;
  await assert.rejects(
    sql.execute(
      execute(),
      context(actorA, () => {
        if (calls.length) throw new Error("request_cancelled");
      }),
    ),
    /request_cancelled/,
  );
});
