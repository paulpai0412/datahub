// Contract-level regression only; live Grafana / source / model require separate E2E.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createGrafanaHost,
  grafanaPolicies,
} from "../extensions/datahub-agent/integration/native-grafana.mjs";
const key = "a".repeat(48),
  other = "b".repeat(48);
const now = Date.parse("2026-09-26T00:00:00Z");
const uuid = "11111111-1111-4111-8111-111111111111";
const policy = {
  dashboardUid: "sales-monthly-category",
  datasetUrn:
    "urn:li:dataset:(urn:li:dataPlatform:mssql,SalesDatamart.reporting.v_sales_order_line,PROD)",
  orgId: 2,
  grafanaOrigin: "http://localhost:3000",
  title: "Source-only Sales",
  viewerLogin: "b-viewer",
  expiresAt: now + 60_000,
};
const configs = () =>
  grafanaPolicies(
    { [key]: policy },
    { datahubOrigin: "http://localhost:9002" },
  );
const card = () => ({
  format: "datahub-sql.source-card/1",
  metric: "sales_by_category",
  datasetUrn: policy.datasetUrn,
  resultExpiresAt: now + 60_000,
  from: "2014-06-01",
  through: "2014-06-30",
  observedAt: "2026-09-26T00:00:00Z",
  points: [{ month: "2014-06", category: "Bikes", salesAmount: "120.50" }],
});
const context = {
  actor: { key },
  cookieHeader: "session=example-not-real",
  grantId: uuid,
  assertActive() {},
};
const request = {
  action: "grafana_authorize",
  resultRef: uuid,
  requestId: uuid,
};
const make = (patch = {}) =>
  createGrafanaHost({
    policies: configs(),
    now: () => now,
    readSqlResult: async () => card(),
    verifyIdentity: async () => ({ key }),
    ...patch,
  });
test("unit: SQL receipt produces URL-free model card; approved portal exposes only a transient aggregate", async () => {
  let reads = 0,
    identityChecks = 0,
    grants = 0;
  const host = make({
    readSqlResult: async () => {
      reads++;
      return card();
    },
    verifyIdentity: async () => {
      identityChecks++;
      return { key };
    },
  });
  const receipt = await host.request(JSON.stringify(request), context);
  assert.equal(receipt.url, undefined);
  assert.equal(JSON.stringify(receipt).includes("120.50"), false);
  assert.equal(receipt.status, "SOURCE_ONLY_NOT_RECONCILED");
  const open = await host.request(
    JSON.stringify({
      action: "grafana_open",
      displayRef: receipt.displayRef,
      requestId: uuid,
    }),
    context,
  );
  const url = new URL(open.url);
  assert.equal(url.origin, policy.grafanaOrigin);
  assert.equal(url.searchParams.get("orgId"), String(policy.orgId));
  assert.equal(url.searchParams.get("from"), card().from);
  assert.equal(url.searchParams.get("var-display"), receipt.displayRef);
  assert.equal(url.searchParams.has("var-cap"), false);
  const rows = await host.read(receipt.displayRef, {
    viewerLogin: policy.viewerLogin,
    orgId: "org-2",
    assertGrant: () => {
      grants++;
    },
  });
  assert.deepEqual(rows, [
    {
      month: "2014-06",
      category: "Bikes",
      salesAmount: "120.50",
      from: "2014-06-01",
      through: "2014-06-30",
      observedAt: card().observedAt,
      status: "SOURCE_ONLY_NOT_RECONCILED",
    },
  ]);
  assert.equal(reads, 3); // authorize, open, GET: all reauthorize the original result.
  assert.equal(identityChecks, 1);
  assert.ok(grants >= 2);
});
test("unit: arbitrary URL/org/actor, missing grant, revoked ACL and expired result fail closed", async () => {
  const host = make();
  for (const field of [
    { url: "http://evil.test" },
    { orgId: 1 },
    { datasetUrn: "other" },
    { action: "execute" },
    { resultRef: "bogus" },
  ])
    await assert.rejects(
      host.request(JSON.stringify({ ...request, ...field }), context),
      /grafana_/,
    );
  await assert.rejects(
    host.request(JSON.stringify(request), {
      ...context,
      actor: { key: other },
    }),
    /grafana_scope_denied/,
  );
  await assert.rejects(
    host.request(JSON.stringify(request), { ...context, grantId: undefined }),
    /grafana_scope_denied/,
  );
  const entry = await host.request(JSON.stringify(request), context);
  await assert.rejects(
    host.read(entry.displayRef, {
      viewerLogin: policy.viewerLogin,
      orgId: "org-2",
      assertGrant() {},
    }),
    /grafana_scope_denied/,
  ); // A card alone cannot authorize a backend GET.
  const open = await host.request(
    JSON.stringify({
      action: "grafana_open",
      displayRef: entry.displayRef,
      requestId: uuid,
    }),
    context,
  );
  assert.equal(
    new URL(open.url).searchParams.get("var-display"),
    entry.displayRef,
  );
  await assert.rejects(
    host.read(entry.displayRef, {
      viewerLogin: policy.viewerLogin,
      orgId: "org-2",
      assertGrant() {
        throw new Error("revoked");
      },
    }),
    /revoked/,
  );
  for (const identity of [
    { viewerLogin: "other", orgId: "org-2" },
    { viewerLogin: policy.viewerLogin, orgId: "1" },
    { viewerLogin: policy.viewerLogin, orgId: "2" },
    { viewerLogin: policy.viewerLogin, orgId: "default" },
    { viewerLogin: undefined, orgId: "org-2" },
  ])
    await assert.rejects(
      host.read(entry.displayRef, { assertGrant() {}, ...identity }),
      /grafana_scope_denied/,
    );
  await assert.rejects(
    host.read("guess", { assertGrant() {} }),
    /grafana_scope_denied/,
  );
  const denied = make({
    readSqlResult: async () => {
      throw new Error("dataset_acl_revoked");
    },
  });
  await assert.rejects(
    denied.request(JSON.stringify(request), context),
    /dataset_acl_revoked/,
  );
  const expired = make({
    readSqlResult: async () => ({ ...card(), resultExpiresAt: now }),
  });
  await assert.rejects(
    expired.request(JSON.stringify(request), context),
    /grafana_result_unavailable/,
  );
});
test("unit: configuration only allows an explicit same-host, separately isolated Grafana origin", () => {
  for (const patch of [
    { grafanaOrigin: "http://evil.test:3000" },
    { grafanaOrigin: "http://localhost:9002" },
    { orgId: 0 },
    { dashboardUid: "../../admin" },
    { synthetic: true },
    { title: "\n" },
  ])
    assert.throws(
      () =>
        grafanaPolicies(
          { [key]: { ...policy, ...patch } },
          { datahubOrigin: "http://localhost:9002" },
        ),
      /invalid_grafana_policy/,
    );
});
