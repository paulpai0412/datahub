import { randomUUID } from "node:crypto";

/** A fixed first-party case, not an arbitrary SQL or Grafana datasource proxy. */
export class SqlError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.status = status;
  }
}

const reject = (code, status) => {
  throw new SqlError(code, status);
};
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const date = (value) =>
  typeof value === "string" &&
  /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(`${value}T`);
const amount = (value) =>
  typeof value === "string" &&
  /^(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/.test(value);
const salesView =
  "urn:li:dataset:(urn:li:dataPlatform:mssql,salesdatamart.reporting.v_sales_order_line,PROD)";
const salesChart = "urn:li:chart:(grafana,dataflow-sales-v1.5)";
const salesDashboard = "urn:li:dashboard:(grafana,dataflow-sales-v1)";

/** Operator-only actor grants. Catalog visibility alone never grants source SELECT. */
export function sqlPolicies(value = {}, { sourceOnly = false } = {}) {
  if (!record(value) || typeof sourceOnly !== "boolean")
    reject("sql_configuration_invalid", 503);
  const result = new Map();
  for (const [actorKey, policy] of Object.entries(value)) {
    if (
      !/^[a-f0-9]{48}$/.test(actorKey) ||
      !record(policy) ||
      ![
        sourceOnly
          ? "chartUrn,commonScopeApproved,dashboardSha256,dashboardUrn,datasetUrn,expiresAt,from,grafanaQueryApproved,panelId,sourceOnlyApproved,sourceSelectApproved,through"
          : "chartUrn,commonScopeApproved,dashboardSha256,dashboardUrn,datasetUrn,expiresAt,grafanaQueryApproved,panelId,sourceSelectApproved",
        sourceOnly
          ? "chartUrn,commonScopeApproved,dashboardSha256,dashboardUrn,datasetUrn,expiresAt,from,grafanaQueryApproved,maxExecutions,panelId,sourceOnlyApproved,sourceSelectApproved,through"
          : "chartUrn,commonScopeApproved,dashboardSha256,dashboardUrn,datasetUrn,expiresAt,grafanaQueryApproved,maxExecutions,panelId,sourceSelectApproved",
      ].includes(Object.keys(policy).sort().join()) ||
      (policy.maxExecutions !== undefined &&
        (!Number.isSafeInteger(policy.maxExecutions) ||
          policy.maxExecutions < 1 ||
          policy.maxExecutions > 10)) ||
      policy.datasetUrn !== salesView ||
      policy.chartUrn !== salesChart ||
      policy.dashboardUrn !== salesDashboard ||
      !sha(policy.dashboardSha256) ||
      policy.panelId !== 5 ||
      policy.commonScopeApproved !== true ||
      (sourceOnly
        ? policy.grafanaQueryApproved !== false ||
          policy.sourceOnlyApproved !== true
        : policy.grafanaQueryApproved !== true) ||
      policy.sourceSelectApproved !== true ||
      (sourceOnly &&
        (!date(policy.from) ||
          !date(policy.through) ||
          policy.from < "2011-05-31" ||
          policy.through > "2014-06-30" ||
          policy.from > policy.through)) ||
      !Number.isSafeInteger(policy.expiresAt) ||
      policy.expiresAt <= 0
    )
      reject("sql_configuration_invalid", 503);
    result.set(actorKey, Object.freeze({ ...policy }));
  }
  return result;
}

function parse(raw, kind) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 2048)
    reject("sql_invalid_request");
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    reject("sql_invalid_request");
  }
  if (!record(input)) reject("sql_invalid_request");
  if (kind === "execute") {
    if (
      Object.keys(input).sort().join() !==
        "action,from,metric,requestId,through" ||
      input.action !== "execute" ||
      input.metric !== "sales_by_category" ||
      !date(input.from) ||
      !date(input.through) ||
      input.from < "2011-05-31" ||
      input.through > "2014-06-30" ||
      input.from > input.through ||
      typeof input.requestId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(input.requestId)
    )
      reject("sql_invalid_request");
  } else if (kind === "read") {
    if (
      Object.keys(input).sort().join() !== "action,resultRef" ||
      input.action !== "read_result" ||
      typeof input.resultRef !== "string" ||
      !/^[a-f0-9-]{36}$/.test(input.resultRef)
    )
      reject("sql_invalid_request");
  } else reject("sql_invalid_request");
  return input;
}

function checkResult(result, intent) {
  if (
    !record(result) ||
    result.complete !== true ||
    !Array.isArray(result.points) ||
    result.points.length === 0 ||
    result.points.length > 200 ||
    typeof result.observedAt !== "string" ||
    !/^20\d{2}-\d{2}-\d{2}T[\d:.]+Z$/.test(result.observedAt) ||
    (result.dataAsOf !== null &&
      (typeof result.dataAsOf !== "string" ||
        !/^20\d{2}-\d{2}-\d{2}T[\d:.]+Z$/.test(result.dataAsOf))) ||
    result.points.some(
      (point) =>
        !record(point) ||
        Object.keys(point).sort().join() !== "category,month,salesAmount" ||
        !date(point.month) ||
        !point.month.endsWith("-01") ||
        point.month < `${intent.from.slice(0, 7)}-01` ||
        point.month > `${intent.through.slice(0, 7)}-01` ||
        typeof point.category !== "string" ||
        !point.category ||
        point.category.length > 80 ||
        /[\x00-\x1f\x7f]/.test(point.category) ||
        !amount(point.salesAmount),
    )
  )
    reject("sql_result_invalid", 502);
  const unique = new Set(result.points.map((p) => `${p.month}\0${p.category}`));
  if (
    unique.size !== result.points.length ||
    Buffer.byteLength(JSON.stringify(result.points)) > 24576
  )
    reject("sql_result_invalid", 502);
}

function decimalMillionths(value) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function checkComparison(evidence, policy, points) {
  if (
    !record(evidence) ||
    Object.keys(evidence).sort().join() !==
      "chartUrn,dashboardSha256,dashboardUrn,panelId,totals" ||
    evidence.chartUrn !== policy.chartUrn ||
    evidence.dashboardUrn !== policy.dashboardUrn ||
    evidence.dashboardSha256 !== policy.dashboardSha256 ||
    evidence.panelId !== policy.panelId ||
    !Array.isArray(evidence.totals) ||
    evidence.totals.length === 0 ||
    evidence.totals.length > 200
  )
    reject("sql_comparison_inconclusive", 409);
  const expected = new Map();
  for (const point of points)
    expected.set(
      point.category,
      (expected.get(point.category) ?? 0n) +
        decimalMillionths(point.salesAmount),
    );
  if (expected.size !== evidence.totals.length)
    reject("sql_comparison_inconclusive", 409);
  for (const row of evidence.totals) {
    if (
      !record(row) ||
      Object.keys(row).sort().join() !== "category,salesAmount" ||
      typeof row.category !== "string" ||
      !expected.has(row.category) ||
      !amount(row.salesAmount) ||
      expected.get(row.category) !== decimalMillionths(row.salesAmount)
    )
      reject("sql_comparison_inconclusive", 409);
    expected.delete(row.category);
  }
  if (expected.size) reject("sql_comparison_inconclusive", 409);
}

/** The two trusted callbacks must independently check native Grafana version/query
 * and execute the fixed read-only reporting-view template with a restricted DB login.
 * No callback is supplied by the Agent. Missing callbacks deny by default. */
export function createSqlHost({
  policies = new Map(),
  authorizeAssets,
  executeSource,
  compareGrafana,
  sourceOnly = false,
  now = Date.now,
} = {}) {
  if (
    !(policies instanceof Map) ||
    typeof authorizeAssets !== "function" ||
    typeof executeSource !== "function" ||
    typeof sourceOnly !== "boolean" ||
    (sourceOnly
      ? compareGrafana !== undefined
      : typeof compareGrafana !== "function") ||
    [...policies.values()].some(
      (policy) =>
        !record(policy) ||
        (sourceOnly
          ? policy.sourceOnlyApproved !== true ||
            policy.grafanaQueryApproved !== false
          : policy.grafanaQueryApproved !== true ||
            policy.sourceOnlyApproved !== undefined),
    )
  )
    reject("sql_not_configured", 503);
  const results = new Map(); // Transient only: never persist numerical values in a Pi session.
  const active = new Set();
  const attempts = new Map(); // Count admitted statements, including UNKNOWN outcomes.
  const prune = () => {
    for (const [ref, entry] of results)
      if (now() >= entry.expiresAt) results.delete(ref);
  };
  const check = async (context, policy) => {
    context.assertActive();
    if (!policy || now() >= policy.expiresAt) reject("sql_not_authorized", 403);
    const confirmed = await authorizeAssets(context, policy);
    context.assertActive();
    if (confirmed !== true) reject("sql_not_authorized", 403);
  };
  return {
    async execute(raw, context) {
      const input = parse(raw, "execute");
      const policy = policies.get(context.actor?.key);
      if (
        sourceOnly &&
        (input.from !== policy?.from || input.through !== policy?.through)
      )
        reject("sql_not_authorized", 403);
      await check(context, policy);
      if (active.has(context.actor.key) || active.size >= 2)
        reject("sql_capacity_exhausted", 429);
      if (policy.maxExecutions !== undefined) {
        const spent = attempts.get(context.actor.key) ?? 0;
        if (spent >= policy.maxExecutions) reject("sql_not_authorized", 403);
        // Seal before spawning: timeout, cancellation and unknown effects never
        // silently grant another attempt in this Host lifecycle.
        attempts.set(context.actor.key, spent + 1);
      }
      active.add(context.actor.key);
      try {
        // The executor receives only a metric enum and bounded dates; never raw SQL,
        // identifiers, datasource credentials or a URL from model/browser input.
        const result = await executeSource(
          { metric: input.metric, from: input.from, through: input.through },
          context,
          policy,
        );
        context.assertActive();
        checkResult(result, input);
        const verified = {
          observedAt: result.observedAt,
          dataAsOf: result.dataAsOf,
          points: structuredClone(result.points),
        };
        if (!sourceOnly) {
          const compared = await compareGrafana(
            {
              metric: input.metric,
              from: input.from,
              through: input.through,
              points: structuredClone(verified.points),
            },
            context,
            policy,
          );
          context.assertActive();
          checkComparison(compared, policy, verified.points);
        }
        await check(context, policy); // A grant or policy can expire during execution.
        prune();
        if (results.size >= 64) reject("sql_capacity_exhausted", 429);
        const resultRef = randomUUID();
        const expiresAt = Math.min(now() + 60_000, policy.expiresAt);
        results.set(resultRef, {
          actorKey: context.actor.key,
          policy,
          expiresAt,
          input: { from: input.from, through: input.through },
          result: verified,
        });
        // Explicitly exclude any numerical values from tool content/details/history.
        return {
          format: sourceOnly
            ? "datahub-sql.source-receipt/1"
            : "datahub-sql.receipt/1",
          action: "execute",
          requestId: input.requestId,
          resultRef,
          metric: input.metric,
          datasetUrn: policy.datasetUrn,
          chartUrn: policy.chartUrn,
          dashboardUrn: policy.dashboardUrn,
          panelId: policy.panelId,
          resultExpiresAt: expiresAt,
          note: sourceOnly
            ? "Source-only execution; not checked by Grafana. Values are ephemeral and require fresh actor checks."
            : "Numerical data is ephemeral; open the card with a fresh actor check. Expiry requires a new authorized request.",
        };
      } finally {
        active.delete(context.actor.key);
      }
    },
    async readResult(raw, context, { includeInternalExpiry = false } = {}) {
      const input = parse(raw, "read");
      const entry = results.get(input.resultRef);
      if (!entry || entry.actorKey !== context.actor?.key)
        reject("sql_result_expired", 410);
      if (now() >= entry.expiresAt) {
        results.delete(input.resultRef);
        reject("sql_result_expired", 410);
      }
      const current = policies.get(context.actor.key);
      if (current !== entry.policy) reject("sql_result_expired", 410);
      await check(context, current);
      // No implicit re-execution: a missing/expired/changed entry stays missing.
      return {
        format: sourceOnly ? "datahub-sql.source-card/1" : "datahub-sql.card/1",
        metric: "sales_by_category",
        resultRef: input.resultRef,
        datasetUrn: current.datasetUrn,
        chartUrn: current.chartUrn,
        dashboardUrn: current.dashboardUrn,
        panelId: current.panelId,
        ...entry.input,
        observedAt: entry.result.observedAt,
        dataAsOf: entry.result.dataAsOf,
        points: structuredClone(entry.result.points),
        // Trusted Host-to-Host bridge only. Browser /agent/sql-result calls
        // never supply the third argument, preserving the public card shape.
        ...(includeInternalExpiry ? { resultExpiresAt: entry.expiresAt } : {}),
      };
    },
  };
}
