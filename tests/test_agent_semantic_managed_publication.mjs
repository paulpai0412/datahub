import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { semanticCatalogFixture } from "./fixtures/semantic-catalog-fixture.mjs";
import { loadSemanticReviewBatch, approveSemanticReviewBatch } from "../extensions/datahub-agent/mfe/semantic-batch-review.js";
import { exactMssqlInventory } from "../extensions/datahub-agent/integration/semantic-managed-scope.mjs";
import { sourceUrn, executionUrn } from "./fixtures/semantic-fixture.mjs";
import { ingestionPolicies } from "../extensions/datahub-agent/integration/ingestion-policy.mjs";
import { taskRecords } from "../extensions/datahub-agent/integration/task-records.mjs";
import {
  managedCycleRef,
  managedException,
} from "../extensions/datahub-agent/integration/semantic-managed-cycle.mjs";

const recipe = JSON.parse(
  readFileSync(
    new URL(
      "../extensions/sales-datamart/metadata/target-ingestion.json",
      import.meta.url,
    ),
  ),
);
const members = exactMssqlInventory(recipe);
function managedFixture({ large = false } = {}) {
  const f = semanticCatalogFixture();
  const fieldCounts = large ? [7, 8, 4, 5, 13, 8, 24] : Array(7).fill(1);
  const text = JSON.stringify(recipe),
    rows = new Map();
  f.policy.recipeSha256 = createHash("sha256").update(text).digest("hex");
  f.policy.taskDatasets = [...members];
  f.policy.semanticAutoManagement = {
    id: "fixture-sales-auto",
    mode: "AUTO",
    runUrn: executionUrn,
    expiresAt: f.writes.now + 3600000,
    allowedKinds: ["description", "tag", "term", "domain", "property"],
    allowedTargets: [{ assetUrn: members[0] }],
  };
  const dataset = members[0];
  for (const urn of members) {
    const row = structuredClone(f.state.dataset);
    row.urn = urn;
    row.datasetKey.value.name = urn;
    row.schemaMetadata.value.fields = Array.from(
      { length: fieldCounts[members.indexOf(urn)] },
      (_, index) => ({
        fieldPath: index === 0 ? "order_id" : `order_id_${index}`,
        description: "Order identifier",
        nativeDataType: "bigint",
      }),
    );
    row.schemaMetadata.systemMetadata.runId = executionUrn.split(":").at(-1);
    row.schemaMetadata.systemMetadata.pipelineName = sourceUrn;
    row.datasetProperties.value.description = "Order identifier from source";
    delete row.editableDatasetProperties;
    rows.set(urn, row);
    f.state.definitions[urn] = row;
  }
  f.state.execution.dataHubExecutionRequestInput.value.args.recipe =
    JSON.stringify({
      ...recipe,
      run_id: executionUrn,
      pipeline_name: sourceUrn,
    });
  f.state.execution.dataHubExecutionRequestInput.value.args.version = "1.7.0.9";
  const original = f.context.fetchImpl;
  f.context.fetchImpl = async (url, options) => {
    const input = options.body ? JSON.parse(options.body) : null;
    if (
      url.pathname === "/api/v2/graphql" &&
      input.query.includes("getGrantedPrivileges") &&
      [sourceUrn, executionUrn].includes(
        input.variables.input.resourceSpec.resourceUrn,
      )
    )
      return Response.json({
        data: {
          getGrantedPrivileges: {
            privileges: ["VIEW_ENTITY_PAGE", "EDIT_ENTITY"],
          },
        },
      });
    if (url.pathname === "/openapi/v3/entity/datahubingestionsource/batchGet")
      return Response.json([
        {
          urn: sourceUrn,
          dataHubIngestionSourceInfo: {
            value: {
              name: "SalesDatamart",
              type: "mssql",
              config: {
                recipe: text,
                version: "1.7.0.9",
                executorId: "default",
              },
            },
            systemMetadata: { version: "1" },
          },
        },
      ]);
    if (
      url.pathname === "/openapi/v3/entity/dataset/batchGet" &&
      rows.has(input?.[0]?.urn)
    ) {
      const row = rows.get(input[0].urn);
      return Response.json([
        Object.fromEntries(
          Object.entries(row).filter(
            ([key]) => key === "urn" || Object.hasOwn(input[0], key),
          ),
        ),
      ]);
    }
    return original(url, options);
  };
  async function startCycle() {
    const inspected = await f.call({ action: "inspect_managed_scope", contract: "catalog/1", requestId: randomUUID(), sourceUrn });
    const scope = inspected.scope;
    const ref = inspected.managedCycle ?? managedCycleRef(f.context.actor.key, scope, "fixture-sales-auto");
    const body = {
      action: "start_managed_cycle",
      contract: "catalog/1",
      requestId: randomUUID(),
      sessionId: f.sessionId,
      sourceUrn,
      scopeFingerprint: scope.fingerprint,
      cycleRunUrn: ref.runUrn,
      cycleTaskUrn: ref.taskUrn,
      ...(ref.previousCycleRunUrn ? { previousCycleRunUrn: ref.previousCycleRunUrn } : {}),
    };
    f.writes.pending = body;
    const result = await f.call({ ...body, uiRequestId: "fixture-ui" });
    assert.equal(result.format, "datahub-semantic.managed-cycle/1");
    assert.equal(result.targetCount, large ? 76 : 14);
    return { scope, ref, result };
  }
  async function pending(candidate, extra = {}) {
    const { scope, ref } = await startCycle();
    const inspected = await f.inspect(dataset);
    const body = {
      action: "prepare_managed",
      contract: "catalog/1",
      requestId: randomUUID(),
      sessionId: f.sessionId,
      sourceUrn,
      assetUrn: dataset,
      snapshotDigest: inspected.snapshotDigest,
      scopeFingerprint: scope.fingerprint,
      cycleRunUrn: ref.runUrn,
      cycleTaskUrn: ref.taskUrn,
      candidates: [candidate],
      ...extra,
    };
    f.writes.pending = body;
    return { body, call: () => f.call({ ...body, uiRequestId: "fixture-ui" }) };
  }
  return { ...f, rows, dataset, pending, startCycle };
}
async function maintenance(f, assetUrn = f.dataset, extra = {}) {
  return f.call({
    action: "inspect_managed_maintenance", contract: "catalog/1",
    requestId: randomUUID(), sourceUrn, assetUrn, ...extra,
  });
}

const description = {
  kind: "description",
  operation: "set",
  value: "Order identifier from source",
  reason: "Copy the explicitly observed source description",
  evidenceIds: ["asset:source-description"],
};

test("maintenance inventories written evidence and exposes complete paged proposals without writes", async () => {
  const f = managedFixture({ large: true });
  const urn = members.at(-1);
  const first = await maintenance(f, urn);
  assert.equal(first.managedScope.fieldCount, 69);
  assert.equal(first.maintenance.items.length, 21);
  assert.equal(first.nextOffset, 20);
  const second = await maintenance(f, urn, { offset: first.nextOffset, snapshotDigest: first.snapshotDigest });
  assert.equal(second.maintenance.items.length, 4);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.maintenance.items, ...second.maintenance.items].map((item) => item.fieldPath ?? "dataset")).size, 25);
  assert.equal(first.maintenance.items[0].disposition, "ADD");
  assert.equal(first.maintenance.items[0].routing, "POLICY_DENIED");
  assert.equal(f.writes.recordWrites, 0);
  assert.equal(f.writes.targetWrites, 0);
  const row = f.rows.get(f.dataset);
  row.datasetProperties.value.description = "";
  for (const field of row.schemaMetadata.value.fields) field.description = "";
  const missing = await maintenance(f);
  assert(missing.maintenance.items.every((item) => item.disposition === "INSUFFICIENT_EVIDENCE" && item.candidate === undefined));
  await assert.rejects(maintenance(f, f.assets.container));
  await assert.rejects(maintenance(f, urn, { offset: 20, snapshotDigest: "f".repeat(64) }), { message: "semantic_snapshot_conflict" });
});

test("foreign-Source provenance protects the existing value without blocking authorized new targets", async () => {
  const f = managedFixture();
  f.rows.get(f.dataset).editableSchemaMetadata.value.editableSchemaFieldInfo = [];
  const first = await f.pending(description);
  await first.call();
  const foreignSource = "urn:li:dataHubIngestionSource:other-test-source";
  for (const locator of [`${first.body.cycleRunUrn}/ekopAgentRun`, `${first.body.cycleTaskUrn}/ekopAgentTask`])
    for (const entry of f.journal.get(locator)) entry.value.source = foreignSource;
  const oldHistory = structuredClone([...f.journal]);
  const originalDescription = structuredClone(f.rows.get(f.dataset).editableDatasetProperties);
  f.policy.semanticAutoManagement.id = "new-source-protected-content";
  f.policy.semanticAutoManagement.allowAgentDescriptionUpdates = true;
  f.policy.semanticAutoManagement.allowedTargets = [{ assetUrn: f.dataset }, { assetUrn: f.dataset, fieldPath: "order_id" }];
  f.rows.get(f.dataset).datasetProperties.value.description = "Current Source written description";
  const plan = await maintenance(f);
  const existing = plan.maintenance.items[0], fresh = plan.maintenance.items[1];
  assert.deepEqual(existing.priorAgent, { status: "NO_AGENT_BASELINE" });
  assert.equal(existing.disposition, "REVIEW_HUMAN_OR_CHANGED_VALUE");
  assert.equal(existing.routing, "HUMAN_REVIEW");
  assert.equal(fresh.disposition, "ADD");
  assert.equal(fresh.routing, "OPERATOR_POLICY");
  const previews = await f.call(await f.request([existing.candidate, fresh.candidate], f.dataset));
  assert.deepEqual(previews.changes[0].priorAgent, { status: "NO_AGENT_BASELINE" });
  assert.equal(f.writes.targetWrites, 1, "inventory and preview do not write");
  const protectedIntent = await f.pending(existing.candidate);
  const pending = await protectedIntent.call();
  assert.equal(pending.state, "PENDING", "even update opt-in cannot automatically adopt another Source's value");
  assert.equal(f.writes.targetWrites, 1);
  const freshIntent = await f.pending(fresh.candidate);
  const published = await freshIntent.call();
  assert.equal(published.publication.status, "VERIFIED_CURRENT_VALUES");
  assert.equal(f.writes.targetWrites, 2, "only the new field is published");
  assert.equal(f.rows.get(f.dataset).editableSchemaMetadata.value.editableSchemaFieldInfo.find(v => v.fieldPath === "order_id").description, fresh.after);
  assert.deepEqual(f.rows.get(f.dataset).editableDatasetProperties, originalDescription);
  for (const [locator, entries] of oldHistory) assert.deepEqual(f.journal.get(locator), entries, "foreign history is untouched");
});

test("foreign-Source equal values remain read-only KEEP without claiming an Agent baseline", async () => {
  const f = managedFixture();
  const first = await f.pending(description); await first.call();
  for (const locator of [`${first.body.cycleRunUrn}/ekopAgentRun`, `${first.body.cycleTaskUrn}/ekopAgentTask`])
    for (const entry of f.journal.get(locator)) entry.value.source = "urn:li:dataHubIngestionSource:other-test-source";
  delete f.policy.semanticAutoManagement;
  const before = structuredClone([...f.journal]);
  const plan = await maintenance(f);
  assert.deepEqual(plan.maintenance.items[0].priorAgent, { status: "NO_AGENT_BASELINE" });
  assert.equal(plan.maintenance.items[0].disposition, "KEEP");
  assert.equal(plan.maintenance.items[0].routing, "NO_WRITE");
  assert.equal(plan.maintenance.items[1].routing, "READ_ONLY");
  assert.equal(f.writes.targetWrites, 1); assert.deepEqual([...f.journal], before);
});

test("foreign provenance handling does not hide identity, ACL, binding or transport errors", async t => {
  for (const failure of ["actor", "binding", "record-acl", "unavailable", "asset-acl"]) await t.test(failure, async () => {
    const f = managedFixture();const first = await f.pending(description);await first.call();
    const run = f.journal.get(`${first.body.cycleRunUrn}/ekopAgentRun`).at(-1).value;
    if (failure === "actor") {
      run.actor = "urn:li:corpuser:other";
      for (const entry of f.journal.get(`${first.body.cycleTaskUrn}/ekopAgentTask`)) entry.value.actor = run.actor;
    } else if (failure === "binding") run.source = "urn:li:dataHubIngestionSource:other-test-source";
    else {
      const original = f.context.fetchImpl;
      f.context.fetchImpl = async (url, options) => {
        const body = JSON.parse(options.body);
        if (["record-acl", "unavailable"].includes(failure) && url.pathname.endsWith("/dataprocessinstance/batchGet") && body[0]?.urn === first.body.cycleRunUrn)
          return new Response(null, { status: failure === "record-acl" ? 403 : 503 });
        if (failure === "asset-acl" && url.pathname === "/api/v2/graphql" && body.query.includes("getGrantedPrivileges") && body.variables?.input?.resourceSpec?.resourceUrn === f.dataset)
          return Response.json({ data: { getGrantedPrivileges: { privileges: [] } } });
        return original(url, options);
      };
    }
    await assert.rejects(maintenance(f), failure === "asset-acl" ? undefined : { message: { actor: "task_owner_mismatch", binding: "task_run_binding_mismatch", "record-acl": "datahub_task_request_denied", unavailable: "datahub_task_unavailable" }[failure] });
    assert.equal(f.writes.targetWrites, 1);
  });
});

test("first-round publication then evidence-change round updates only intact Agent description and keeps history", async () => {
  const f = managedFixture();
  const initialPlan = await maintenance(f);
  assert.equal(initialPlan.maintenance.items[0].routing, "OPERATOR_POLICY");
  const first = await f.pending(initialPlan.maintenance.items[0].candidate);
  const published = await first.call();
  const oldRun = structuredClone(f.journal.get(`${first.body.cycleRunUrn}/ekopAgentRun`).at(-1).value);
  const kept = await maintenance(f);
  assert.equal(kept.maintenance.items[0].disposition, "KEEP");
  assert.equal(kept.maintenance.items[0].routing, "NO_WRITE");
  assert.equal(kept.maintenance.items[0].priorAgent.status, "VERIFIED_AGENT_BASELINE");
  assert.equal(f.writes.targetWrites, 1);
  f.rows.get(f.dataset).editableDatasetProperties.value.unknown = { preserve: true };
  // A concurrent edit, even of an unrelated member, needs human judgment.
  const changed = await maintenance(f);
  assert.equal(changed.maintenance.items[0].priorAgent.status, "CURRENT_CHANGED");
  delete f.rows.get(f.dataset).editableDatasetProperties.value.unknown;
  f.policy.semanticAutoManagement.id = "fixture-sales-auto-r2";
  f.policy.semanticAutoManagement.allowAgentDescriptionUpdates = true;
  f.rows.get(f.dataset).datasetProperties.value.description = "New explicitly written source description";
  const plan = await maintenance(f);
  const item = plan.maintenance.items[0];
  assert.equal(item.disposition, "UPDATE_AGENT");
  assert.equal(item.routing, "OPERATOR_POLICY");
  assert.equal(item.priorAgent.value, description.value);
  assert.equal(item.before, description.value);
  assert.equal(item.after, "New explicitly written source description");
  const next = await f.pending(item.candidate);
  assert.notEqual(next.body.cycleRunUrn, first.body.cycleRunUrn);
  const result = await next.call();
  assert.equal(result.state, "ATTEMPTED");
  assert.equal(result.history.at(-1).approvalMode, "OPERATOR_POLICY");
  assert.equal(f.writes.targetWrites, 2);
  assert.equal(f.rows.get(f.dataset).editableDatasetProperties.value.description, item.after);
  assert.deepEqual(f.journal.get(`${first.body.cycleRunUrn}/ekopAgentRun`).at(-1).value, oldRun);
  const current = await maintenance(f);
  assert.equal(current.maintenance.items[0].disposition, "KEEP");
  assert.deepEqual(current.maintenance.items[0].priorAgent.reviewRef, result.reviewRef);
  f.writes.pending = next.body;
  await next.call();
  assert.equal(f.writes.targetWrites, 2, "same intention is read-only after publication");
  assert.equal(published.publication.status, "VERIFIED_CURRENT_VALUES");
});

test("versioned source-schema change sends the Agent field update to review and preserves sibling human values", async () => {
  const f = managedFixture();
  f.policy.semanticAutoManagement.allowedTargets = [{ assetUrn: f.dataset, fieldPath: "order_id" }];
  const row = f.rows.get(f.dataset);
  row.editableSchemaMetadata.value.editableSchemaFieldInfo = [{ fieldPath: "other", description: "Human sibling", unknown: "retain" }];
  const candidate = { ...description, fieldPath: "order_id", value: "Order identifier", evidenceIds: ["field:0:source-description"] };
  const first = await f.pending(candidate);
  await first.call();
  const stamp = structuredClone(row.editableSchemaMetadata.value.created);
  f.policy.semanticAutoManagement.id = "fixture-sales-field-r2";
  f.policy.semanticAutoManagement.allowAgentDescriptionUpdates = true;
  row.schemaMetadata.value.fields[0].description = "Updated explicit identifier description";
  row.schemaMetadata.systemMetadata.version = "2";
  const plan = await maintenance(f);
  const item = plan.maintenance.items.find((entry) => entry.fieldPath === "order_id");
  assert.equal(item.disposition, "REVIEW_HUMAN_OR_CHANGED_VALUE");
  assert.equal(item.routing, "HUMAN_REVIEW");
  const next = await f.pending(item.candidate);
  const pending = await next.call();
  assert.equal(pending.state, "PENDING");
  assert.equal(f.writes.targetWrites, 1);
  await f.command(pending, "approve_review");
  assert.deepEqual(row.editableSchemaMetadata.value.editableSchemaFieldInfo[0], { fieldPath: "other", description: "Human sibling", unknown: "retain" });
  assert.deepEqual(row.editableSchemaMetadata.value.created, stamp);
  assert.equal(row.editableSchemaMetadata.value.editableSchemaFieldInfo[1].description, item.after);
  assert.equal(f.writes.targetWrites, 2);
});

test("protected human values become exact pending review, never automatic consent", async () => {
  const f = managedFixture();
  f.rows.get(f.dataset).editableDatasetProperties = { value: { description: "Human", unknown: "retain" }, systemMetadata: { version: "1" } };
  const plan = await maintenance(f);
  assert.equal(plan.maintenance.items[0].disposition, "REVIEW_HUMAN_OR_CHANGED_VALUE");
  assert.equal(plan.maintenance.items[0].routing, "HUMAN_REVIEW");
  const intent = await f.pending(plan.maintenance.items[0].candidate);
  const pending = await intent.call();
  assert.equal(pending.state, "PENDING");
  assert.equal(f.writes.targetWrites, 0);
  assert.equal(f.rows.get(f.dataset).editableDatasetProperties.value.description, "Human");
  await f.command(pending, "approve_review");
  assert.equal(f.writes.targetWrites, 1);
  assert.equal(f.rows.get(f.dataset).editableDatasetProperties.value.unknown, "retain");
});

test("description update authority is opt-in and schema drift/human rewrite never gains auto ownership", async (t) => {
  for (const change of ["disabled", "schema", "human", "sameValueRewrite"]) await t.test(change, async () => {
    const f = managedFixture();
    const first = await f.pending(description);
    await first.call();
    f.policy.semanticAutoManagement.id = `fixture-sales-${change.toLowerCase()}`;
    f.policy.semanticAutoManagement.allowAgentDescriptionUpdates = change !== "disabled";
    const row = f.rows.get(f.dataset);
    row.datasetProperties.value.description = "Updated source description";
    if (change === "schema") row.schemaMetadata.systemMetadata.version = "2";
    if (change === "human") row.editableDatasetProperties.value.description = "Human override";
    if (change === "sameValueRewrite") row.editableDatasetProperties.systemMetadata.version = "2";
    const plan = await maintenance(f);
    assert.equal(plan.maintenance.items[0].routing, "HUMAN_REVIEW");
    const next = await f.pending(plan.maintenance.items[0].candidate);
    const result = await next.call();
    assert.equal(result.state, "PENDING");
    assert.equal(f.writes.targetWrites, 1);
  });
});

test("initial UNKNOWN is not an Agent update baseline even when current native values match", async () => {
  const f = managedFixture();
  f.writes.lossAfter = 1;
  const first = await f.pending(description);
  await assert.rejects(first.call());
  f.policy.semanticAutoManagement.id = "fixture-sales-unknown-r2";
  f.policy.semanticAutoManagement.allowAgentDescriptionUpdates = true;
  f.rows.get(f.dataset).datasetProperties.value.description = "New written source value";
  const plan = await maintenance(f);
  assert.equal(plan.maintenance.items[0].priorAgent.status, "UNVERIFIED_AGENT_BASELINE");
  assert.equal(plan.maintenance.items[0].routing, "BLOCKED_UNVERIFIED_ATTEMPT");
  const next = await f.pending(plan.maintenance.items[0].candidate);
  await assert.rejects(next.call(), { message: "semantic_managed_prior_attempt_unverified" });
  assert.equal(f.writes.targetWrites, 1);
});

test("Host maintenance plan restores into the real React card with evidence, three-way values and no consent controls", async () => {
  const require = createRequire(new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url));
  const { buildSync } = require("esbuild"), React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const module = { exports: {} };
  const compiled = buildSync({ entryPoints: [fileURLToPath(new URL("../extensions/datahub-agent/pi-web/components/DataHubSemanticPreview.tsx", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic" });
  runInNewContext(compiled.outputFiles[0].text, { module, require, TextEncoder });
  const { isSemanticPreview, DataHubSemanticPreview } = module.exports;
  const f = managedFixture();
  f.rows.get(f.dataset).datasetProperties.value.description = "<script>not instructions</script>";
  const plan = JSON.parse(JSON.stringify(await maintenance(f)));
  assert.equal(isSemanticPreview(plan), true);
  const html = renderToStaticMarkup(React.createElement(DataHubSemanticPreview, { preview: plan }));
  for (const text of ["有依據的維護提案", "prior-Agent", "current", "new", "OPERATOR_POLICY", "&lt;script&gt;", "尚未核准／發布"]) assert(html.includes(text), text);
  assert.doesNotMatch(html, /<script|<button/);
  for (const changed of [
    { publicationAuthorized: true },
    { managedScope: { ...plan.managedScope, sourceUrn: "urn:li:dataHubIngestionSource:foreign" } },
    { maintenance: { ...plan.maintenance, items: [{ ...plan.maintenance.items[0], routing: "SELF_APPROVED" }] } },
    { nextOffset: 5 },
  ]) assert.equal(isSemanticPreview({ ...plan, ...changed }), false);
  assert.equal(f.writes.targetWrites, 0);
  f.rows.get(f.dataset).datasetProperties.value.description = "Reviewed tag usage";
  const first = await f.pending({ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", reason: "Explicit fixture", evidenceIds: ["asset:source-description"] });
  await first.call();
  const removal = await f.call(await f.request([{ kind: "tag", operation: "remove", value: "urn:li:tag:Reviewed", reason: "Show selected prior change", evidenceIds: ["asset:source-description"] }], f.dataset));
  assert.equal(isSemanticPreview(removal), true);
  const historyHtml = renderToStaticMarkup(React.createElement(DataHubSemanticPreview, { preview: removal }));
  for (const text of ["prior-Agent", "VERIFIED_AGENT_BASELINE", "先前實際改動", "被保留的人工關聯仍受保護", "current", "new"]) assert(historyHtml.includes(text), text);
  assert.equal(isSemanticPreview({ ...removal, changes: [{ ...removal.changes[0], priorAgent: { status: "SELF_APPROVED" } }] }), false);
  assert.doesNotMatch(historyHtml, /<button/);
});

async function closeLimitedFixtureCycle(f, runUrn) {
  // This fixture permits one Dataset description, not all its targets. These
  // are real policy exclusions in the synthetic scope, not product completion.
  let cycle = await readCycle(f, runUrn);
  while (cycle.missingCount) {
    for (const [assetUrn, fieldPath] of cycle.missing) {
      assert(!f.policy.semanticAutoManagement.allowedTargets.some((item) => item.assetUrn === assetUrn && (item.fieldPath ?? null) === fieldPath));
      await recordException(f, runUrn, assetUrn, "POLICY_DENIED", fieldPath ?? undefined);
    }
    cycle = await readCycle(f, runUrn);
  }
  const body = { action: "finish_managed_cycle", requestId: randomUUID(), sessionId: f.sessionId, cycleRunUrn: runUrn };
  f.writes.pending = body;
  const closed = await f.call({ ...body, uiRequestId: "fixture-ui" });
  assert.equal(closed.closed, true);
}

test("same operator policy advances one native Task by CAS to a safe evidence-change round; old versions stay readable", async () => {
  const f = managedFixture();
  f.policy.semanticAutoManagement.allowAgentDescriptionUpdates = true;
  const policy = structuredClone(f.policy.semanticAutoManagement);
  const first = await f.pending(description);
  await first.call();
  await closeLimitedFixtureCycle(f, first.body.cycleRunUrn);
  const oldRun = structuredClone(f.journal.get(`${first.body.cycleRunUrn}/ekopAgentRun`).at(-1).value);
  const oldTask = structuredClone(f.journal.get(`${first.body.cycleTaskUrn}/ekopAgentTask`)[0].value);
  const row = f.rows.get(f.dataset);
  row.datasetProperties.value.description = "Changed, explicitly observed source statement";
  row.datasetProperties.systemMetadata.version = "2";
  const plan = await maintenance(f);
  const next = await f.pending(plan.maintenance.items[0].candidate);
  assert.equal(next.body.cycleTaskUrn, first.body.cycleTaskUrn);
  assert.notEqual(next.body.cycleRunUrn, first.body.cycleRunUrn);
  const result = await next.call();
  assert.equal(result.publication.status, "VERIFIED_CURRENT_VALUES");
  assert.equal(f.writes.targetWrites, 2);
  assert.equal((await readCycle(f, next.body.cycleRunUrn)).generation, 2);
  const historical = await readCycle(f, first.body.cycleRunUrn);
  assert.equal(historical.generation, 1);
  assert.equal(historical.closed, true);
  assert.equal(historical.publications[0].status, "UNKNOWN_OR_CHANGED", "old initial success is not claimed as current after the second update");
  assert.deepEqual(f.journal.get(`${first.body.cycleRunUrn}/ekopAgentRun`).at(-1).value, oldRun);
  assert.deepEqual(f.journal.get(`${first.body.cycleTaskUrn}/ekopAgentTask`)[0].value, oldTask);
  assert.equal(f.journal.get(`${first.body.cycleTaskUrn}/ekopAgentTask`).length, 2);
  assert.deepEqual(f.policy.semanticAutoManagement, policy, "no new policy id, expiry or scope is synthesized");
  const kept = await maintenance(f);
  assert.equal(kept.maintenance.items[0].disposition, "KEEP");
  assert.equal(kept.maintenance.items[0].routing, "NO_WRITE");
  await closeLimitedFixtureCycle(f, next.body.cycleRunUrn);
  const nativeBeforeKeep = structuredClone(row.editableDatasetProperties);
  const third = await f.pending(kept.maintenance.items[0].candidate);
  const retained = await third.call();
  assert.equal(retained.generation, 3);
  assert.equal(retained.retentionCount, 1);
  assert.equal(retained.publicationCount, 0);
  assert.equal(f.writes.targetWrites, 2);
  assert.deepEqual(row.editableDatasetProperties, nativeBeforeKeep);
  await closeLimitedFixtureCycle(f, third.body.cycleRunUrn);
  assert.equal((await readCycle(f, third.body.cycleRunUrn)).closed, true);
});

test("concurrent successor starts have at most one Task allocation and one new Run", async () => {
  const f = managedFixture();
  const first = await f.pending(description);
  await first.call();
  await closeLimitedFixtureCycle(f, first.body.cycleRunUrn);
  const inspected = await f.call({ action: "inspect_managed_scope", contract: "catalog/1", requestId: randomUUID(), sourceUrn });
  const body = { action: "start_managed_cycle", contract: "catalog/1", requestId: randomUUID(), sourceUrn,
    scopeFingerprint: inspected.scope.fingerprint, sessionId: f.sessionId,
    cycleRunUrn: inspected.managedCycle.runUrn, cycleTaskUrn: inspected.managedCycle.taskUrn,
    previousCycleRunUrn: inspected.managedCycle.previousCycleRunUrn };
  f.writes.pending = body;
  const before = f.writes.recordWrites;
  const results = await Promise.allSettled([f.call({ ...body, uiRequestId: "fixture-ui" }), f.call({ ...body, uiRequestId: "fixture-ui" })]);
  assert(results.some((item) => item.status === "fulfilled"));
  assert.equal(f.writes.recordWrites - before, 2, "exactly one Task version and one new Run");
  assert.equal(f.journal.get(`${body.cycleTaskUrn}/ekopAgentTask`).length, 2);
  assert.equal(f.journal.get(`${body.cycleRunUrn}/ekopAgentRun`).length, 1);
  assert.equal(f.writes.targetWrites, 1);
  const again = await f.call({ ...body, uiRequestId: "fixture-ui" });
  assert.equal(again.generation, 2);
  assert.equal(f.writes.recordWrites - before, 2);
});

test("UNKNOWN or pending prior round cannot gain a successor even if generically closed by the owner", async (t) => {
  for (const condition of ["UNKNOWN", "PENDING"]) await t.test(condition, async () => {
    const f = managedFixture();
    if (condition === "UNKNOWN") f.writes.lossAfter = 1;
    else f.rows.get(f.dataset).editableDatasetProperties = { value: { description: "Human" }, systemMetadata: { version: "1" } };
    const first = await f.pending(description);
    if (condition === "UNKNOWN") await assert.rejects(first.call());
    else assert.equal((await first.call()).state, "PENDING");
    const records = taskRecords(f.context), run = await records.getRun(first.body.cycleRunUrn);
    await records.closeRun(run.urn, run.version, f.sessionId);
    const writes = f.writes.recordWrites;
    await assert.rejects(f.call({ action: "inspect_managed_scope", contract: "catalog/1", requestId: randomUUID(), sourceUrn }), { message: "semantic_managed_previous_cycle_unverified" });
    assert.equal(f.writes.recordWrites, writes);
    assert.equal(f.journal.get(`${first.body.cycleTaskUrn}/ekopAgentTask`).length, 1);
  });
});

test("lost Task-allocation ACK leaves a pinned incomplete successor and never replays or skips it", async () => {
  const f = managedFixture();
  const first = await f.pending(description);
  await first.call();
  await closeLimitedFixtureCycle(f, first.body.cycleRunUrn);
  const observed = await f.call({ action: "inspect_managed_scope", contract: "catalog/1", requestId: randomUUID(), sourceUrn });
  const body = { action: "start_managed_cycle", contract: "catalog/1", requestId: randomUUID(), sourceUrn,
    scopeFingerprint: observed.scope.fingerprint, sessionId: f.sessionId,
    cycleRunUrn: observed.managedCycle.runUrn, cycleTaskUrn: observed.managedCycle.taskUrn,
    previousCycleRunUrn: observed.managedCycle.previousCycleRunUrn };
  f.writes.pending = body;
  f.writes.recordLossAt = f.writes.recordWrites + 1;
  await assert.rejects(f.call({ ...body, uiRequestId: "fixture-ui" }));
  const writes = f.writes.recordWrites;
  assert.equal(f.journal.get(`${body.cycleTaskUrn}/ekopAgentTask`).length, 2);
  assert.equal(f.journal.has(`${body.cycleRunUrn}/ekopAgentRun`), false);
  await assert.rejects(f.call({ ...body, uiRequestId: "fixture-ui" }), { message: "semantic_managed_cycle_incomplete" });
  assert.equal(f.writes.recordWrites, writes);
  assert.equal(f.writes.targetWrites, 1);
});

test("KEEP is a durable non-publication decision and sibling field publication cannot invalidate its unchanged value", async () => {
  const f = managedFixture({ large: true });
  f.policy.semanticAutoManagement.allowedTargets = [{ assetUrn: f.dataset, fieldPath: "order_id" }, { assetUrn: f.dataset, fieldPath: "order_id_1" }];
  const before = structuredClone(f.rows.get(f.dataset).editableSchemaMetadata);
  const keep = await f.pending({ ...description, fieldPath: "order_id", value: before.value.editableSchemaFieldInfo[0].description, evidenceIds: ["field:0:source-description"] });
  const retained = await keep.call();
  assert.equal(retained.retentionCount, 1);
  assert.equal(retained.publicationCount, 0);
  assert.equal(f.writes.targetWrites, 0);
  assert.deepEqual(f.rows.get(f.dataset).editableSchemaMetadata, before);
  const next = await f.pending({ ...description, fieldPath: "order_id_1", value: "Order identifier", evidenceIds: ["field:1:source-description"] });
  await next.call();
  const cycle = await readCycle(f, keep.body.cycleRunUrn);
  assert.equal(cycle.retentionCount, 1);
  assert.equal(cycle.retentions[0].status, "OBSERVED_NO_CHANGE");
  assert.equal(cycle.pendingCount, 0);
  assert.equal(cycle.accountedCount, 2);
  assert.equal(f.writes.targetWrites, 1);
  const writes = f.writes.recordWrites;
  f.writes.pending = keep.body;
  await keep.call();
  assert.equal(f.writes.recordWrites, writes, "KEEP reconnect never writes or becomes approval");
});

test("selected value drift invalidates KEEP, while a lost KEEP ACK remains unconfirmed and read-only", async (t) => {
  for (const condition of ["changedValue", "lostAck"]) await t.test(condition, async () => {
    const f = managedFixture();
    const row = f.rows.get(f.dataset);
    row.editableDatasetProperties = { value: { description: description.value }, systemMetadata: { version: "1" } };
    const keep = await f.pending(description);
    if (condition === "lostAck") f.writes.recordLossAt = f.writes.recordWrites + 1;
    if (condition === "lostAck") await assert.rejects(keep.call());
    else {
      await keep.call();
      row.editableDatasetProperties.value.description = "Subsequent human edit";
      row.editableDatasetProperties.systemMetadata.version = "2";
    }
    const result = await readCycle(f, keep.body.cycleRunUrn);
    assert.equal(result.retentions[0].status, "CHANGED_OR_UNVERIFIED");
    assert.equal(result.accountedCount, 0);
    assert.equal(result.pendingCount, 1);
    const records = f.writes.recordWrites;
    f.writes.pending = keep.body;
    await keep.call();
    assert.equal(f.writes.recordWrites, records);
    assert.equal(f.writes.targetWrites, 0);
    const finish = { action: "finish_managed_cycle", requestId: randomUUID(), sessionId: f.sessionId, cycleRunUrn: keep.body.cycleRunUrn };
    f.writes.pending = finish;
    assert.equal((await f.call({ ...finish, uiRequestId: "fixture-ui" })).closed, false);
  });
});

async function linkDefinition(f, parent, review, overrides = {}) {
  const body = { action: "link_managed_definition", requestId: randomUUID(), sessionId: f.sessionId,
    cycleRunUrn: parent.ref.runUrn, cycleTaskUrn: parent.ref.taskUrn, ...review.reviewRef, ...overrides };
  f.writes.pending = body;
  return { body, call: () => f.call({ ...body, uiRequestId: "fixture-ui" }) };
}

test("managed cycle links separate human definition review, then publishes its association only after verified definition", async () => {
  const f = managedFixture();
  f.policy.semanticAutoManagement.mode = "REVIEW";
  const parent = await f.startCycle();
  const taskBefore = structuredClone(f.journal.get(`${parent.ref.taskUrn}/ekopAgentTask`));
  const request = await f.definitionRequest({ kind: "tag", operation: "create", name: "Reviewed Sales Fact", description: "Explicit synthetic definition" }, f.dataset);
  const review = await f.prepare(request);
  const link = await linkDefinition(f, parent, review);
  const pending = await link.call();
  assert.equal(pending.definitions[0].status, "PENDING");
  assert.equal(pending.accountedCount, 0, "a shared definition does not consume a Dataset/field slot");
  assert.equal(pending.pendingCount, 1);
  assert.equal(f.writes.targetWrites, 0);
  assert.deepEqual(f.journal.get(`${parent.ref.taskUrn}/ekopAgentTask`), taskBefore, "no expanded Task asset authority");
  const urn = review.preview.definition.proposedUrn;
  const candidate = { kind: "tag", operation: "add", value: urn, reason: "Human-reviewed shared definition", evidenceIds: ["asset:source-description"] };
  const beforeApproval = await f.pending(candidate);
  await assert.rejects(beforeApproval.call(), { message: "semantic_managed_definition_dependency_unverified" });
  const published = await f.command(review, "approve_review");
  assert.equal(published.publication.status, "VERIFIED_CURRENT_VALUES");
  assert.equal((await readCycle(f, parent.ref.runUrn)).definitions[0].status, "VERIFIED");
  const association = await f.pending(candidate);
  const queued = await association.call();
  assert.equal(queued.state, "PENDING", "human-reviewed definition is not automatic association evidence");
  const result = await f.command(queued, "approve_review");
  assert.equal(result.publication.status, "VERIFIED_CURRENT_VALUES");
  assert(f.rows.get(f.dataset).globalTags.value.tags.some((item) => item.tag === urn));
  await closeLimitedFixtureCycle(f, parent.ref.runUrn);
  assert.equal((await f.startCycle()).result.generation, 2);
});

test("linked definition UNKNOWN, unconfirmed link ACK and foreign-session binding cannot authorize an association", async (t) => {
  for (const condition of ["UNKNOWN", "lostLinkAck", "foreignSession"]) await t.test(condition, async () => {
    const f = managedFixture(), parent = await f.startCycle();
    const review = await f.prepare(await f.definitionRequest({ kind: "tag", operation: "create", name: "Dependency", description: "Synthetic" }, f.dataset));
    const link = await linkDefinition(f, parent, review);
    if (condition === "foreignSession") {
      f.journal.get(`${review.reviewRef.runUrn}/ekopAgentRun`).at(-1).value.sessionId = randomUUID();
      const writes = f.writes.recordWrites;
      await assert.rejects(link.call(), { message: "semantic_managed_definition_link_mismatch" });
      assert.equal(f.writes.recordWrites, writes);
      return;
    }
    if (condition === "lostLinkAck") {
      f.writes.recordLossAt = f.writes.recordWrites + 1;
      await assert.rejects(link.call());
      const writes = f.writes.recordWrites;
      await link.call();
      assert.equal(f.writes.recordWrites, writes);
    } else await link.call();
    if (condition === "UNKNOWN") f.writes.lossAfter = 1;
    if (condition === "UNKNOWN") await assert.rejects(f.command(review, "approve_review"));
    else await f.command(review, "approve_review");
    const candidate = await f.pending({ kind: "tag", operation: "add", value: review.preview.definition.proposedUrn,
      reason: "Cannot reuse uncertain effect", evidenceIds: ["asset:source-description"] });
    await assert.rejects(candidate.call(), { message: "semantic_managed_definition_dependency_unverified" });
    assert.equal((await readCycle(f, parent.ref.runUrn)).pendingCount, 1);
    assert.equal(f.writes.targetWrites, 1);
  });
});

test("bounded shared-impact observation cannot be promoted into managed update authority", async () => {
  const f = managedFixture(), parent = await f.startCycle();
  const review = await f.prepare(await f.definitionRequest({ kind: "tag", operation: "update", urn: "urn:li:tag:Existing", version: "1", description: "Changed shared meaning" }, f.dataset));
  const link = await linkDefinition(f, parent, review);
  const writes = f.writes.recordWrites;
  await assert.rejects(link.call(), { message: "semantic_managed_shared_impact_unverified" });
  assert.equal(f.writes.recordWrites, writes);
  assert.equal(f.writes.targetWrites, 0);
});

test("Domain, Glossary Group then Term, and Structured Property reuse separate native human review without widening cycle assets", async () => {
  const f = managedFixture(), parent = await f.startCycle();
  let parentUrn;
  for (const definition of [
    { kind: "domain", operation: "create", name: "Scoped Sales", description: "Synthetic domain evidence" },
    { kind: "node", operation: "create", name: "Scoped Group", description: "Synthetic grouping evidence" },
    { kind: "term", operation: "create", name: "Scoped Term", description: "Synthetic term evidence" },
    { kind: "property", operation: "create", name: "Scoped Property", description: "Synthetic property evidence", valueType: "string", cardinality: "SINGLE", entityTypes: ["dataset"] },
  ]) {
    if (definition.kind === "term") definition.parentUrn = parentUrn;
    const review = await f.prepare(await f.definitionRequest(definition, f.dataset));
    const link = await linkDefinition(f, parent, review);
    await link.call();
    assert.equal((await f.command(review, "approve_review")).publication.status, "VERIFIED_CURRENT_VALUES");
    if (definition.kind === "node") parentUrn = review.preview.definition.proposedUrn;
  }
  const result = await readCycle(f, parent.ref.runUrn);
  assert.deepEqual(result.definitions.map((item) => item.kind), ["domain", "node", "term", "property"]);
  assert(result.definitions.every((item) => item.status === "VERIFIED"));
  assert.equal(result.accountedCount, 0);
  assert.equal(result.pendingCount, 0);
  assert.deepEqual(f.journal.get(`${parent.ref.taskUrn}/ekopAgentTask`).at(-1).value.assets, [...members]);
});

test("non-description associations carry selected prior-Agent/current/new across rounds; replacements stay human-only", async (t) => {
  for (const kind of ["domain", "tag", "term", "property"]) await t.test(kind, async () => {
    const f = managedFixture(), row = f.rows.get(f.dataset);
    row.datasetProperties.value.description = "Explicit fixture usage: Reviewed Governance Fact Priority";
    const urns = { domain: "urn:li:domain:Governance", tag: "urn:li:tag:Reviewed", term: "urn:li:glossaryTerm:Fact", property: "urn:li:structuredProperty:priority" };
    f.state.definitions[urns.domain] = { domainProperties: { value: { name: "Governance" }, systemMetadata: { version: "1" } } };
    f.state.definitions[urns.term] = { glossaryTermInfo: { value: { name: "Fact", definition: "Fixture only" }, systemMetadata: { version: "1" } } };
    if (kind === "property") row.structuredProperties.value.properties = [{ propertyUrn: "urn:li:structuredProperty:human", values: [{ string: "keep" }], context: "human annotation" }];
    if (kind === "tag") row.globalTags.value.tags[0].context = "human annotation";
    const firstCandidate = { kind, operation: kind === "property" ? "set" : "add", value: urns[kind],
      ...(kind === "property" ? { values: ["normal"] } : {}), reason: "Explicit written fixture evidence", evidenceIds: ["asset:source-description"] };
    const first = await f.pending(firstCandidate);
    assert.equal((await first.call()).publication.status, "VERIFIED_CURRENT_VALUES");
    await closeLimitedFixtureCycle(f, first.body.cycleRunUrn);
    const aspect = { domain: "domains", tag: "globalTags", term: "glossaryTerms", property: "structuredProperties" }[kind];
    const nativeBefore = structuredClone(row[aspect]);
    const nextCandidate = { ...firstCandidate, operation: kind === "property" ? "set" : "remove", ...(kind === "property" ? { values: ["high"] } : {}) };
    const second = await f.pending(nextCandidate);
    const review = await second.call();
    assert.equal(review.state, "PENDING");
    assert.equal(f.writes.targetWrites, 1, "no automatic replacement/removal permission was added");
    const change = review.preview.changes[0];
    assert.equal(change.priorAgent.status, "VERIFIED_AGENT_BASELINE");
    assert.equal(change.priorAgent.ownership, "SELECTED_CHANGE_ONLY");
    assert.deepEqual(change.priorAgent.value, change.before);
    assert.deepEqual(change.priorAgent.changedValues.added, kind === "property" ? ["normal"] : [urns[kind]]);
    assert.deepEqual(change.priorAgent.changedValues.removed, []);
    assert.deepEqual(row[aspect], nativeBefore);
    assert.equal((await f.command(review, "approve_review")).publication.status, "VERIFIED_CURRENT_VALUES");
    assert.equal(f.writes.targetWrites, 2);
    if (kind === "tag") assert.equal(row.globalTags.value.tags[0].context, "human annotation");
    if (kind === "property") assert.deepEqual(row.structuredProperties.value.properties.find((item) => item.propertyUrn.endsWith(":human")),
      nativeBefore.value.properties.find((item) => item.propertyUrn.endsWith(":human")));
  });
});

test("association baseline does not adopt human additions, same-value rewrites, UNKNOWN or untouched sibling kinds", async (t) => {
  for (const condition of ["HUMAN", "SAME_VALUE", "UNKNOWN", "SIBLING_KIND"]) await t.test(condition, async () => {
    const f = managedFixture(), row = f.rows.get(f.dataset);
    row.datasetProperties.value.description = "Reviewed";
    if (condition === "UNKNOWN") f.writes.lossAfter = 1;
    const first = await f.pending({ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", reason: "Direct evidence", evidenceIds: ["asset:source-description"] });
    if (condition === "UNKNOWN") await assert.rejects(first.call()); else await first.call();
    if (["HUMAN", "SAME_VALUE"].includes(condition)) {
      if (condition === "HUMAN") row.globalTags.value.tags.push({ tag: "urn:li:tag:HumanAddition", context: "human" });
      row.globalTags.systemMetadata.version = String(Number(row.globalTags.systemMetadata.version) + 1);
    }
    const request = await f.request([{ kind: "tag", operation: "remove", value: "urn:li:tag:Reviewed", reason: "Compare baseline", evidenceIds: ["asset:source-description"] }], f.dataset);
    const result = await f.call(request);
    assert.equal(result.changes[0].priorAgent.status, condition === "UNKNOWN" ? "UNVERIFIED_AGENT_BASELINE" : ["HUMAN", "SAME_VALUE"].includes(condition) ? "CURRENT_CHANGED" : "VERIFIED_AGENT_BASELINE");
    if (condition === "SIBLING_KIND") {
      // A prior field tag publication must not claim the preserved human description.
      f.policy.semanticAutoManagement.allowedTargets = [{ assetUrn: f.dataset, fieldPath: "order_id" }];
      f.policy.semanticAutoManagement.id = "fixture-field-sibling";
      row.schemaMetadata.value.fields[0].description = "Reviewed";
      const field = await f.pending({ kind: "tag", operation: "add", fieldPath: "order_id", value: "urn:li:tag:Reviewed", reason: "Field tag evidence", evidenceIds: ["field:0:source-description"] });
      await field.call();
      const snapshot = await f.call(await f.request([{ ...description, fieldPath: "order_id", value: "Human: source key", evidenceIds: ["field:0:source-description"] }], f.dataset));
      assert.equal(snapshot.changes[0].priorAgent.status, "NO_SELECTED_AGENT_BASELINE");
      assert.equal(snapshot.changes[0].before, "Human: source key");
    }
  });
});

test("field Structured Property baseline binds the schemaField Aspect, not the Dataset property", async () => {
  const f = managedFixture(), row = f.rows.get(f.dataset);
  row.schemaMetadata.value.fields[0].description = "Priority";
  f.policy.semanticAutoManagement.allowedTargets = [{ assetUrn: f.dataset, fieldPath: "order_id" }];
  const firstSnapshot = await f.inspect(f.dataset, { fieldPath: "order_id" });
  const candidate = { kind: "property", operation: "set", value: "urn:li:structuredProperty:priority", values: ["normal"],
    fieldPath: "order_id", reason: "Explicit column Priority", evidenceIds: ["field:0:source-description"] };
  const first = await f.pending(candidate, { fieldPath: "order_id", snapshotDigest: firstSnapshot.snapshotDigest });
  assert.equal((await first.call()).publication.status, "VERIFIED_CURRENT_VALUES");
  await closeLimitedFixtureCycle(f, first.body.cycleRunUrn);
  const secondSnapshot = await f.inspect(f.dataset, { fieldPath: "order_id" });
  const second = await f.pending({ ...candidate, values: ["high"] }, { fieldPath: "order_id", snapshotDigest: secondSnapshot.snapshotDigest });
  const review = await second.call();
  assert.equal(review.state, "PENDING");
  assert.equal(review.preview.changes[0].priorAgent.status, "VERIFIED_AGENT_BASELINE");
  assert.deepEqual(review.preview.changes[0].priorAgent.value, ["normal"]);
  const datasetBefore = structuredClone(row.structuredProperties);
  assert.equal((await f.command(review, "approve_review")).publication.status, "VERIFIED_CURRENT_VALUES");
  assert.deepEqual(row.structuredProperties, datasetBefore);
});

test("human-review routing of one association cannot conceal an evidence failure later in the same proposal", async () => {
  const f = managedFixture();
  f.rows.get(f.dataset).datasetProperties.value.description = "Existing";
  const remove = { kind: "tag", operation: "remove", value: "urn:li:tag:Existing", reason: "Review existing association", evidenceIds: ["asset:source-description"] };
  const next = await f.pending(remove, { candidates: [remove, { ...description, value: "Unsupported inferred business meaning" }] });
  const records = f.writes.recordWrites;
  await assert.rejects(next.call(), { message: "semantic_managed_evidence_exception" });
  assert.equal(f.writes.recordWrites, records);
  assert.equal(f.writes.targetWrites, 0);
});

async function batchFixture() {
  const f = managedFixture();
  f.policy.semanticAutoManagement.mode = "REVIEW";
  f.policy.semanticAutoManagement.allowedTargets = members.map((assetUrn) => ({ assetUrn }));
  let cycleRunUrn;
  for (const assetUrn of members.slice(0, 3)) {
    const snapshot = await f.inspect(assetUrn);
    const pending = await f.pending(description, { assetUrn, snapshotDigest: snapshot.snapshotDigest });
    assert.equal((await pending.call()).state, "PENDING");
    cycleRunUrn = pending.body.cycleRunUrn;
  }
  return { ...f, cycleRunUrn };
}

test("managed batch re-reads CAS versions between native decisions and stops without replay on the first uncertain result", async (t) => {
  for (const condition of ["SUCCESS", "LOST_ACK", "STALE", "REVOKED", "CANCELLED", "WRONG_REVISION"]) await t.test(condition, async () => {
    const f = await batchFixture(), abort = new AbortController();
    const send = (request) => f.call(request);
    const batch = await loadSemanticReviewBatch({ cycleRunUrn: f.cycleRunUrn }, send, abort.signal);
    assert.equal(batch.reviews.length, 3);
    assert(batch.reviews.every((review) => review.runVersion === batch.cycle.runVersion));
    let dispatches = 0;
    const outcome = await approveSemanticReviewBatch(batch, batch.reviews.map((review) => JSON.stringify([review.reviewRef.runUrn, review.reviewRef.decisionId])), async (request) => {
      if (request.action === "approve_review") {
        dispatches++;
        const result = await send(request);
        if (dispatches === 1) {
          if (condition === "LOST_ACK") throw new Error("synthetic_lost_http_ack");
          if (condition === "STALE") f.rows.get(members[1]).editableDatasetProperties = { value: { description: "Human current value" }, systemMetadata: { version: "1" } };
          if (condition === "REVOKED") f.policy.semanticPublicationApproved = false;
          if (condition === "CANCELLED") abort.abort();
        }
        return result;
      }
      const result = await send(request);
      if (condition === "WRONG_REVISION" && dispatches === 1) result.planDigest = "f".repeat(64);
      return result;
    }, abort.signal);
    assert.equal(outcome.stopped, condition !== "SUCCESS", JSON.stringify(outcome));
    assert.equal(dispatches, condition === "SUCCESS" ? 3 : 1);
    assert.equal(f.writes.targetWrites, condition === "SUCCESS" ? 3 : 1);
    assert.equal(outcome.results[0].status, condition === "LOST_ACK" ? "UNCONFIRMED" : "VERIFIED");
    if (condition === "STALE") assert.equal(f.rows.get(members[1]).editableDatasetProperties.value.description, "Human current value");
    const run = f.journal.get(`${f.cycleRunUrn}/ekopAgentRun`).at(-1).value;
    assert.equal(run.decisions.filter((decision) => decision.publicationAttempt).length, condition === "SUCCESS" ? 3 : 1);
  });
});

test("managed batch has no automatic selection, rejects unknown refs and detects changing receipt pages", async () => {
  const f = await batchFixture(), abort = new AbortController();
  const send = (request) => f.call(request);
  const reference = { cycleRunUrn: f.cycleRunUrn };
  const batch = await loadSemanticReviewBatch(reference, send, abort.signal);
  for (const selection of [[], ["untrusted"]]) await assert.rejects(approveSemanticReviewBatch(batch, selection, send, abort.signal), { message: "semantic_batch_selection_invalid" });
  let pages = 0;
  await assert.rejects(loadSemanticReviewBatch(reference, async (request) => {
    const page = await send({ ...request, offset: 0 });
    page.offset = request.offset;
    if (pages++ === 0) page.nextReceiptOffset = 20; else page.runVersion = String(Number(page.runVersion) + 1);
    return page;
  }, abort.signal), { message: "semantic_batch_snapshot_changed" });
  assert.equal(f.writes.targetWrites, 0);
});

test("managed batch includes linked native definition decisions without expanding asset authority", async () => {
  const f = await batchFixture();
  const parent = await f.startCycle();
  const taskBefore = structuredClone(f.journal.get(`${parent.ref.taskUrn}/ekopAgentTask`));
  const review = await f.prepare(await f.definitionRequest({ kind: "tag", operation: "create", name: "Batch Reviewed", description: "Explicit independent fixture definition" }, f.dataset));
  const linked = await linkDefinition(f, parent, review);
  await linked.call();
  const signal = new AbortController().signal, send = (request) => f.call(request);
  const batch = await loadSemanticReviewBatch({ cycleRunUrn: f.cycleRunUrn }, send, signal);
  assert.equal(batch.reviews.length, 4);
  assert.deepEqual(batch.reviews[0].reviewRef, review.reviewRef);
  const outcome = await approveSemanticReviewBatch(batch, batch.reviews.map((item) => JSON.stringify([item.reviewRef.runUrn, item.reviewRef.decisionId])), send, signal);
  assert.equal(outcome.stopped, false, JSON.stringify(outcome));
  assert.equal(f.writes.targetWrites, 4);
  assert.deepEqual(f.journal.get(`${parent.ref.taskUrn}/ekopAgentTask`), taskBefore);
  const current = await readCycle(f, f.cycleRunUrn);
  assert.equal(current.definitions[0].status, "VERIFIED");
  assert.equal(current.accountedCount, 3, "definition never becomes Dataset coverage or consent for an association");
});

test("pending managed reviews coexist with disjoint KEEP and evidence-gap receipts without approving them", async () => {
  const f = await batchFixture();
  f.rows.get(members[3]).datasetProperties.value.description = "";
  const input = { action: "record_managed_exception", requestId: randomUUID(), sessionId: f.sessionId,
    cycleRunUrn: f.cycleRunUrn, assetUrn: members[3], code: "INSUFFICIENT_EVIDENCE" };
  f.writes.pending = input;
  const exception = await f.call({ ...input, uiRequestId: "fixture-ui" });
  assert.equal(exception.pendingCount, 3);
  assert.equal(exception.exceptionCount, 1);
  f.rows.get(members[4]).editableDatasetProperties = { value: { description: description.value }, systemMetadata: { version: "1" } };
  const inspected = await f.inspect(members[4]);
  const keep = await f.pending(description, { assetUrn: members[4], snapshotDigest: inspected.snapshotDigest });
  const result = await keep.call();
  assert.equal(result.retentionCount, 1);
  assert.equal(result.pendingCount, 3);
  assert.equal(f.writes.targetWrites, 0);
});

test("managed batch browser uses the real React opener, parent controls and native fixture decisions", async () => {
  const { checkSemanticBatchBrowser } = await import("./fixtures/semantic-batch-browser.mjs");
  await checkSemanticBatchBrowser(batchFixture);
});

test("operator policy is explicit, typed, expiring, Run-bound and immutable", () => {
  const f = managedFixture();
  const entries = ingestionPolicies({ [f.context.actor.key]: [f.policy] });
  const loaded = entries.get(f.context.actor.key)[0];
  assert(Object.isFrozen(loaded.semanticAutoManagement));
  assert(Object.isFrozen(loaded.semanticAutoManagement.allowedKinds));
  for (const mutate of [
    (x) => {
      x.semanticAutoManagement.mode = "ALWAYS";
    },
    (x) => {
      x.semanticAutoManagement.allowAgentDescriptionUpdates = "yes";
    },
    (x) => {
      x.semanticAutoManagement.runUrn = "not-a-run";
    },
    (x) => {
      x.semanticAutoManagement.allowedKinds = ["description", "description"];
    },
    (x) => {
      x.semanticPublicationApproved = false;
    },
  ]) {
    const value = structuredClone(f.policy);
    mutate(value);
    assert.throws(() => ingestionPolicies({ [f.context.actor.key]: [value] }), {
      message: "invalid_ingestion_policy",
    });
  }
});

test("operator policy automatically publishes an evidence-backed fill through native CAS and one attempt", async () => {
  const f = managedFixture();
  const run = await f.pending(description);
  const result = await run.call();
  assert.equal(result.state, "ATTEMPTED");
  assert.equal(result.history.at(-1).approvalMode, "OPERATOR_POLICY");
  assert.equal(f.writes.targetWrites, 1);
  const cycle = await f.call({
    action: "read_managed_cycle",
    requestId: randomUUID(),
    cycleRunUrn: result.reviewRef.runUrn,
  });
  assert.equal(cycle.accountedCount, 1);
  assert.equal(cycle.missingCount, 13);
  assert.equal(cycle.status, "INCOMPLETE_OR_UNVERIFIED");
  const writesBeforeReconnect = f.writes.recordWrites;
  const repeatedStart = await f.startCycle();
  assert.equal(repeatedStart.ref.runUrn, result.reviewRef.runUrn);
  assert.equal(
    f.writes.recordWrites,
    writesBeforeReconnect,
    "same scope/policy cannot create a second cycle",
  );
  assert.equal(
    f.rows.get(f.dataset).editableDatasetProperties.value.description,
    description.value,
  );
  const writes = f.writes.targetWrites;
  f.writes.pending = run.body;
  const again = await run.call();
  assert.equal(again.reviewRef.runUrn, result.reviewRef.runUrn);
  assert.equal(
    f.writes.targetWrites,
    writes,
    "a repeated key is read-only, not a new attempt",
  );
});

test("REVIEW mode persists the same scoped decision but cannot self-approve or publish", async () => {
  const f = managedFixture();
  f.policy.semanticAutoManagement.mode = "REVIEW";
  const intent = await f.pending(description);
  const review = await intent.call();
  assert.equal(review.state, "PENDING");
  assert.equal(f.writes.targetWrites, 0);
  await assert.rejects(
    f.call({
      ...intent.body,
      requestId: randomUUID(),
      definition: { kind: "term", operation: "create", name: "Unreviewed" },
    }),
  );
  const cycle = await f.call({
    action: "read_managed_cycle",
    requestId: randomUUID(),
    cycleRunUrn: intent.body.cycleRunUrn,
  });
  assert.equal(cycle.pendingCount, 1);
  const published = await f.command(review, "approve_review");
  assert.equal(published.state, "ATTEMPTED");
  assert.equal(published.history.at(-1).approvalMode, "HUMAN");
  assert.equal(f.writes.targetWrites, 1);
  const receipt = await f.call({
    action: "read_managed_cycle",
    requestId: randomUUID(),
    cycleRunUrn: intent.body.cycleRunUrn,
  });
  assert.equal(receipt.accountedCount, 1);
  assert.equal(receipt.pendingCount, 0);
  assert.equal(receipt.publications[0].status, "VERIFIED");
});

test("a human-rejected managed proposal is terminal but still leaves its target unaccounted", async () => {
  const f = managedFixture();
  f.policy.semanticAutoManagement.mode = "REVIEW";
  const intent = await f.pending(description);
  const review = await intent.call();
  const rejected = await f.command(review, "reject_review");
  assert.equal(rejected.state, "REJECT");
  assert.equal(f.writes.targetWrites, 0);
  const cycle = await f.call({
    action: "read_managed_cycle",
    requestId: randomUUID(),
    cycleRunUrn: intent.body.cycleRunUrn,
  });
  assert.equal(cycle.pendingCount, 0);
  assert.equal(cycle.publications[0].status, "REJECTED");
  assert.equal(cycle.missingCount, cycle.targetCount);
});

test("one native cycle accounts for every Dataset and field with verified item receipts or explicit exceptions", async () => {
  const f = managedFixture();
  const run = await f.pending(description);
  const published = await run.call();
  const cycleRunUrn = published.reviewRef.runUrn;
  const earlyBody = {
    action: "finish_managed_cycle",
    requestId: randomUUID(),
    sessionId: f.sessionId,
    cycleRunUrn,
  };
  f.writes.pending = earlyBody;
  const early = await f.call({ ...earlyBody, uiRequestId: "fixture-ui" });
  assert.equal(early.closed, false);
  assert.equal(early.missingCount, 13);
  for (const [assetUrn, fieldPath] of early.missing) {
    const body = {
      action: "record_managed_exception",
      requestId: randomUUID(),
      sessionId: f.sessionId,
      cycleRunUrn,
      assetUrn,
      ...(fieldPath === null ? {} : { fieldPath }),
      code: "INSUFFICIENT_EVIDENCE",
    };
    f.writes.pending = body;
    const current = await f.call({ ...body, uiRequestId: "fixture-ui" });
    assert.equal(current.exceptionCount > 0, true);
  }
  const finishBody = { ...earlyBody, requestId: randomUUID() };
  f.writes.pending = finishBody;
  const finished = await f.call({ ...finishBody, uiRequestId: "fixture-ui" });
  assert.equal(finished.status, "SCOPE_ACCOUNTED_WITH_ITEM_RECEIPTS");
  assert.equal(finished.closed, true);
  assert.equal(finished.accountedCount, 14);
  assert.equal(finished.exceptionCount, 13);
  assert.equal(f.writes.targetWrites, 1);
  const read = await f.call({
    action: "read_managed_cycle",
    requestId: randomUUID(),
    cycleRunUrn,
  });
  assert.equal(read.closed, true);
  assert.equal(read.missingCount, 0);
});

test("no active policy, modified scope, existing human value and lost ACK cannot turn into automatic success", async () => {
  for (const modify of [
    (f) => {
      delete f.policy.semanticAutoManagement;
    },
  ]) {
    const f = managedFixture();
    modify(f);
    await assert.rejects(async () => {
      const run = await f.pending(description);
      await run.call();
    });
    assert.equal(f.writes.targetWrites, 0);
  }
  const outsideTarget = managedFixture();
  outsideTarget.policy.semanticAutoManagement.allowedTargets = [
    { assetUrn: members[1] },
  ];
  const outsideIntent = await outsideTarget.pending(description);
  await assert.rejects(outsideIntent.call());
  assert.equal(outsideTarget.writes.targetWrites, 0);
  assert.equal(
    outsideTarget.writes.recordWrites,
    2,
    "a canary policy cannot publish a different scoped target",
  );
  const absentField = managedFixture();
  absentField.policy.semanticAutoManagement.allowedTargets = [
    { assetUrn: members[0], fieldPath: "not_in_schema" },
  ];
  await assert.rejects(absentField.pending(description));
  assert.equal(absentField.writes.targetWrites, 0);
  const invented = managedFixture();
  const inventedPending = await invented.pending({
    ...description,
    value: "Invented business revenue",
  });
  await assert.rejects(inventedPending.call());
  assert.equal(invented.writes.recordWrites, 2); // Only cycle Task/Run, no item decision.
  const expired = managedFixture();
  expired.writes.afterRecord = async (aspect, value) => {
    if (
      aspect === "ekopAgentRun" &&
      value.decisions?.some((entry) =>
        entry.response?.text?.startsWith("semantic-auto/1:"),
      )
    )
      expired.writes.now = expired.policy.semanticAutoManagement.expiresAt;
  };
  const expiry = await expired.pending(description);
  await assert.rejects(expiry.call());
  assert.equal(
    expired.writes.targetWrites,
    0,
    "revocation/expiry after decision blocks the publication claim",
  );
  const drift = managedFixture();
  const pending = await drift.pending(description);
  pending.body.scopeFingerprint = "f".repeat(64);
  drift.writes.pending.scopeFingerprint = pending.body.scopeFingerprint;
  await assert.rejects(pending.call());
  assert.equal(drift.writes.recordWrites, 2); // No item decision was admitted.
  const lost = managedFixture();
  lost.writes.lossAfter = 1;
  const attempt = await lost.pending(description);
  await assert.rejects(attempt.call());
  assert.equal(lost.writes.targetWrites, 1);
  const reconcile = await lost.call({
    action: "read_managed_cycle",
    requestId: randomUUID(),
    cycleRunUrn: attempt.body.cycleRunUrn,
  });
  assert.equal(reconcile.accountedCount, 0);
  assert.equal(reconcile.pendingCount, 1);
  assert.equal(
    reconcile.publications[0].status,
    "UNKNOWN_OR_CHANGED",
    "matching present values never upgrade the initial lost ACK",
  );
  const writes = lost.writes.targetWrites;
  await attempt.call();
  assert.equal(lost.writes.targetWrites, writes);
});

async function recordException(
  f,
  cycleRunUrn,
  assetUrn = f.dataset,
  code = "INSUFFICIENT_EVIDENCE",
  fieldPath,
) {
  const body = {
    action: "record_managed_exception",
    requestId: randomUUID(),
    sessionId: f.sessionId,
    cycleRunUrn,
    assetUrn,
    code,
    ...(fieldPath === undefined ? {} : { fieldPath }),
  };
  f.writes.pending = body;
  return f.call({ ...body, uiRequestId: "fixture-ui" });
}

const readCycle = (f, cycleRunUrn, offset = 0) =>
  f.call({
    action: "read_managed_cycle",
    requestId: randomUUID(),
    cycleRunUrn,
    offset,
  });

test("a new requestId cannot dispatch a target whose prior UNKNOWN attempt is not visible", async () => {
  const f = managedFixture(),
    original = f.context.fetchImpl;
  let targetRequests = 0;
  f.context.fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.pathname === "/openapi/v3/entity/generic" && body?.dataset) {
      targetRequests++;
      if (targetRequests === 1)
        throw new Error(
          "synthetic dispatched request lost; target not yet observable",
        );
    }
    return original(url, options);
  };
  const first = await f.pending(description);
  await assert.rejects(first.call(), {
    message: "publication_write_unconfirmed",
  });
  assert.equal(targetRequests, 1);
  assert.equal(f.writes.targetWrites, 0);
  const before = await readCycle(f, first.body.cycleRunUrn);
  assert.equal(before.publications[0].status, "UNKNOWN_OR_CHANGED");
  const recordWrites = f.writes.recordWrites;
  const second = await f.pending(description);
  assert.notEqual(second.body.requestId, first.body.requestId);
  await assert.rejects(second.call(), {
    message: "semantic_managed_target_conflict",
  });
  assert.equal(
    targetRequests,
    1,
    "no second target request, even when the current value remains empty",
  );
  assert.equal(f.writes.targetWrites, 0);
  assert.equal(f.writes.recordWrites, recordWrites);
  const after = await readCycle(f, first.body.cycleRunUrn);
  assert.deepEqual(after.publications, before.publications);
  assert.equal(after.pendingCount, before.pendingCount);
  assert.equal(after.accountedCount, before.accountedCount);
});

test("an appended pending review reserves its targets before consent and claim", async () => {
  const f = managedFixture();
  let checked = false;
  f.writes.afterRecord = async (aspect, value) => {
    if (
      checked ||
      aspect !== "ekopAgentRun" ||
      !value.decisions?.some((d) => d.publicationReview && !d.response)
    )
      return;
    checked = true;
    const competing = await f.pending(description);
    await assert.rejects(competing.call(), {
      message: "semantic_managed_target_conflict",
    });
  };
  const first = await f.pending(description);
  const published = await first.call();
  assert(checked);
  assert.equal(published.state, "ATTEMPTED");
  assert.equal(f.writes.submissions, 1);
  assert.equal(f.writes.targetWrites, 1);
});

test("managed expiry and revocation after claim stop dispatch and keep the attempt consumed", async (t) => {
  for (const change of ["expire", "revoke"])
    await t.test(change, async () => {
      const f = managedFixture();
      f.policy.semanticAutoManagement.expiresAt = f.writes.now + 1000;
      const originalPolicy = f.policy.semanticAutoManagement,
        originalNow = f.writes.now;
      const original = f.context.fetchImpl;
      let claimed = false,
        changed = false;
      f.writes.afterRecord = async (aspect, value) => {
        if (
          aspect === "ekopAgentRun" &&
          value.decisions?.some((d) => d.publicationAttempt)
        )
          claimed = true;
      };
      f.context.fetchImpl = async (url, options) => {
        const result = await original(url, options);
        const body = options.body ? JSON.parse(options.body) : null;
        // The final activeRun task read is after post-claim recompile/ACL/version reads.
        if (
          claimed &&
          !changed &&
          url.pathname.endsWith("/batchGet") &&
          body?.[0]?.ekopAgentTask
        ) {
          changed = true;
          if (change === "expire") f.writes.now = originalPolicy.expiresAt;
          else delete f.policy.semanticAutoManagement;
        }
        return result;
      };
      const intent = await f.pending(description);
      await assert.rejects(intent.call(), {
        message: "publication_not_dispatched",
      });
      assert(claimed && changed);
      assert.equal(f.writes.submissions, 0);
      assert.equal(f.writes.targetWrites, 0);
      const decision = f.journal
        .get(`${intent.body.cycleRunUrn}/ekopAgentRun`)
        .at(-1).value.decisions[0];
      const attempt = structuredClone(decision.publicationAttempt);
      assert(attempt.attemptId);
      assert.equal(JSON.parse(attempt.outcomeJson).status, "NOT_DISPATCHED");
      f.writes.now = originalNow;
      f.policy.semanticAutoManagement = originalPolicy;
      const recordWrites = f.writes.recordWrites;
      f.writes.pending = intent.body;
      await intent.call();
      const second = await f.pending(description);
      await assert.rejects(second.call(), {
        message: "semantic_managed_target_conflict",
      });
      assert.deepEqual(
        f.journal.get(`${intent.body.cycleRunUrn}/ekopAgentRun`).at(-1).value
          .decisions[0].publicationAttempt,
        attempt,
      );
      assert.equal(f.writes.recordWrites, recordWrites);
      assert.equal(f.writes.submissions, 0);
    });
});

test("managed native scope is rechecked after claim before dispatch", async () => {
  const f = managedFixture();
  let changed = false;
  f.writes.afterRecord = async (aspect, value) => {
    if (
      !changed &&
      aspect === "ekopAgentRun" &&
      value.decisions?.some((d) => d.publicationAttempt)
    ) {
      changed = true;
      f.rows.get(members[1]).schemaMetadata.systemMetadata.version = "2";
    }
  };
  const intent = await f.pending(description);
  await assert.rejects(intent.call(), {
    message: "publication_not_dispatched",
  });
  assert(changed);
  assert.equal(f.writes.submissions, 0);
  const attempt = f.journal
    .get(`${intent.body.cycleRunUrn}/ekopAgentRun`)
    .at(-1).value.decisions[0].publicationAttempt;
  assert.equal(JSON.parse(attempt.outcomeJson).status, "NOT_DISPATCHED");
});

test("scope drift during the final Run read cannot dispatch a managed target", async (t) => {
  for (const change of ["schema", "recipe"]) {
    await t.test(change, async () => {
      const f = managedFixture();
      const original = f.context.fetchImpl;
      let claimed = false;
      let changed = false;
      f.writes.afterRecord = async (aspect, value) => {
        if (
          aspect === "ekopAgentRun" &&
          value.decisions?.some((d) => d.publicationAttempt)
        ) {
          claimed = true;
        }
      };
      f.context.fetchImpl = async (url, options) => {
        const response = await original(url, options);
        const body = options.body ? JSON.parse(options.body) : null;
        if (
          claimed &&
          !changed &&
          url.pathname.endsWith("/batchGet") &&
          body?.[0]?.ekopAgentTask
        ) {
          changed = true;
          if (change === "schema") {
            // Drift outside the write target: target Aspect CAS cannot detect this.
            f.rows.get(members[1]).schemaMetadata.systemMetadata.version = "2";
          } else {
            const next = structuredClone(recipe);
            next.source.config.table_pattern.allow.pop();
            f.state.execution.dataHubExecutionRequestInput.value.args.recipe =
              JSON.stringify({
                ...next,
                run_id: executionUrn,
                pipeline_name: sourceUrn,
              });
          }
        }
        return response;
      };
      const intent = await f.pending(description);
      let error;
      try {
        await intent.call();
      } catch (caught) {
        error = caught;
      }
      assert(claimed && changed);
      assert.equal(
        f.writes.submissions,
        0,
        "scope drift must be caught before any target request",
      );
      assert.equal(f.writes.targetWrites, 0);
      assert.equal(error?.message, "publication_not_dispatched");
      const attempt = f.journal
        .get(`${intent.body.cycleRunUrn}/ekopAgentRun`)
        .at(-1).value.decisions[0].publicationAttempt;
      assert(attempt.attemptId);
      assert.equal(JSON.parse(attempt.outcomeJson).status, "NOT_DISPATCHED");
    });
  }
});

test("cycle lease cannot expire while the final managed scope is being read", async () => {
  const f = managedFixture();
  const expiresAt = f.writes.now + 7200000;
  f.policy.semanticAutoManagement.expiresAt = f.writes.now + 10800000;
  await f.startCycle();
  f.writes.now = expiresAt - 1000;
  const original = f.context.fetchImpl;
  let claimed = false;
  let changed = false;
  f.writes.afterRecord = async (aspect, value) => {
    if (
      aspect === "ekopAgentRun" &&
      value.decisions?.some((d) => d.publicationAttempt)
    )
      claimed = true;
  };
  f.context.fetchImpl = async (url, options) => {
    const response = await original(url, options);
    const body = options.body ? JSON.parse(options.body) : null;
    if (
      claimed &&
      !changed &&
      body?.[0]?.urn === members.at(-1) &&
      body[0].schemaMetadata
    ) {
      changed = true;
      f.writes.now = expiresAt;
    }
    return response;
  };
  const intent = await f.pending(description);
  let error;
  try {
    await intent.call();
  } catch (caught) {
    error = caught;
  }
  assert(claimed && changed);
  assert.equal(
    f.writes.submissions,
    0,
    "cycle lease must still be active at dispatch",
  );
  assert.equal(error?.message, "publication_not_dispatched");
  const attempt = f.journal
    .get(`${intent.body.cycleRunUrn}/ekopAgentRun`)
    .at(-1).value.decisions[0].publicationAttempt;
  assert.equal(JSON.parse(attempt.outcomeJson).status, "NOT_DISPATCHED");
});

test("exceptions cannot conceal attempts or duplicate another target receipt", async (t) => {
  for (const previous of ["VERIFIED", "UNKNOWN", "EXCEPTION"])
    await t.test(previous, async () => {
      const f = managedFixture();
      const { ref } = await f.startCycle();
      if (previous === "EXCEPTION") await recordException(f, ref.runUrn);
      else {
        const intent = await f.pending(description);
        if (previous === "UNKNOWN") {
          f.writes.lossAfter = 1;
          await assert.rejects(intent.call());
        } else await intent.call();
      }
      const before = await readCycle(f, ref.runUrn),
        recordWrites = f.writes.recordWrites;
      await assert.rejects(
        recordException(f, ref.runUrn, f.dataset, "POLICY_DENIED"),
        { message: "semantic_managed_target_conflict" },
      );
      assert.equal(f.writes.recordWrites, recordWrites);
      const after = await readCycle(f, ref.runUrn);
      assert.equal(after.accountedCount, before.accountedCount);
      assert.equal(after.missingCount, before.missingCount);
      assert.equal(after.exceptionCount, before.exceptionCount);
      assert.deepEqual(after.publications, before.publications);
      if (previous === "UNKNOWN") {
        assert.equal(after.pendingCount, 1);
        assert.equal(after.accountedCount, 0);
      }
    });
});

test("an exception reserves its target against a later publication", async () => {
  const f = managedFixture(),
    { ref } = await f.startCycle();
  await recordException(f, ref.runUrn);
  const recordWrites = f.writes.recordWrites,
    intent = await f.pending(description);
  await assert.rejects(intent.call(), {
    message: "semantic_managed_target_conflict",
  });
  assert.equal(f.writes.recordWrites, recordWrites);
  assert.equal(f.writes.targetWrites, 0);
});

test("historical duplicate target receipts fail closed instead of claiming coverage", async () => {
  const f = managedFixture(),
    intent = await f.pending(description);
  await intent.call();
  const { scope } = await f.startCycle();
  await recordException(f, intent.body.cycleRunUrn, members[1]);
  const run = f.journal
    .get(`${intent.body.cycleRunUrn}/ekopAgentRun`)
    .at(-1).value;
  const exception = run.decisions.find((d) => !d.publicationReview);
  exception.question = managedException(
    { assetUrn: f.dataset, code: "INSUFFICIENT_EVIDENCE" },
    scope,
  );
  exception.response.text = exception.question;
  await assert.rejects(readCycle(f, intent.body.cycleRunUrn), {
    message: "semantic_managed_target_conflict",
  });
});

test("an unattempted human rejection allows a new proposal without reviving old consent", async () => {
  const f = managedFixture();
  f.policy.semanticAutoManagement.mode = "REVIEW";
  const first = await f.pending(description);
  const rejected = await f.command(await first.call(), "reject_review");
  const second = await f.pending(description);
  const pending = await second.call();
  assert.notEqual(pending.reviewRef.decisionId, rejected.reviewRef.decisionId);
  assert.equal(pending.state, "PENDING");
  assert.equal(f.writes.targetWrites, 0);
  await f.command(pending, "approve_review");
  const cycle = await readCycle(f, first.body.cycleRunUrn);
  assert.equal(cycle.publications[0].status, "REJECTED");
  assert.equal(cycle.publications[1].status, "VERIFIED");
  assert.equal(cycle.accountedCount, 1);
  assert.equal(f.writes.targetWrites, 1);
});

test("human selection supersession and different targets remain usable", async () => {
  const f = managedFixture();
  f.policy.semanticAutoManagement.mode = "REVIEW";
  f.policy.semanticAutoManagement.allowedTargets.push({ assetUrn: members[1] });
  const intent = await f.pending(description),
    review = await intent.call();
  const selected = await f.command(review, "select_review", {
    candidateIds: [review.candidateIds[0]],
  });
  const pending = await readCycle(f, intent.body.cycleRunUrn);
  assert.equal(pending.publications[0].status, "REJECTED");
  assert.equal(pending.pendingCount, 1);
  await f.command(selected, "approve_review");
  const other = await f.inspect(members[1]);
  const second = await f.pending(description, {
    assetUrn: members[1],
    snapshotDigest: other.snapshotDigest,
  });
  await f.command(await second.call(), "approve_review");
  const finished = await readCycle(f, intent.body.cycleRunUrn);
  assert.equal(finished.accountedCount, 2);
  assert.equal(finished.pendingCount, 0);
  assert.equal(f.writes.targetWrites, 2);
});

const latestValue = (f, aspect) => structuredClone([...f.journal.entries()].find(([key]) => key.endsWith(`/${aspect}`))[1].at(-1).value);
function permitAuditRecovery(f, cycle) {
  const originalPolicy = structuredClone(f.policy.semanticAutoManagement);
  f.writes.now += 7200001; // Both original publication policy AND cycle lease expired.
  f.policy.semanticPublicationApproved = false;
  f.policy.semanticDefinitionCreationApproved = false;
  f.policy.semanticDefinitionUpdatesApproved = false;
  delete f.policy.semanticAutoManagement;
  f.policy.semanticAuditRecovery = {
    id: "fixture-audit-recovery",
    cycleRunUrn: cycle.runUrn,
    sessionId: f.sessionId,
    scopeFingerprint: cycle.scopeFingerprint,
    expiresAt: f.writes.now + 1800000,
    originalPolicy,
    targets: cycle.missing.map(([assetUrn, fieldPath]) => ({assetUrn, ...(fieldPath === null ? {} : {fieldPath})})),
  };
  return f.policy.semanticAuditRecovery;
}
async function recoveryFixture(large = false) {
  const f = managedFixture({ large }), prepared = await f.pending(description);
  await prepared.call();
  if (large) {
    for (let index = 0; index < 24; index++) {
      const page = await readCycle(f, prepared.body.cycleRunUrn);
      const [assetUrn, fieldPath] = page.missing[0];
      await recordException(f, prepared.body.cycleRunUrn, assetUrn, "POLICY_DENIED", fieldPath ?? undefined);
    }
  } else await recordException(f, prepared.body.cycleRunUrn, members[1], "POLICY_DENIED");
  const before = latestValue(f, "ekopAgentRun"), task = latestValue(f, "ekopAgentTask");
  const cycle = await readCycle(f, prepared.body.cycleRunUrn);
  for (let offset = 20; offset < cycle.missingCount; offset += 20) {
    const page = await readCycle(f, prepared.body.cycleRunUrn, offset);
    cycle.missing.push(...page.missing);
  }
  const grant = permitAuditRecovery(f, cycle);
  return { f, prepared, before, task, grant, target: grant.targets[0] };
}
const recoverTarget = ({f,grant,target}, code = "POLICY_DENIED") => recordException(f, grant.cycleRunUrn, target.assetUrn, code, target.fieldPath);

test("audit-only recovery completes existing receipts after expiry without changing old authority or publishing", async () => {
  const x = await recoveryFixture(true), {f,grant,before,task} = x;
  assert.equal(before.decisions.length, 25);
  assert.equal(grant.targets.length, 51);
  const loaded = ingestionPolicies({[f.context.actor.key]:[f.policy]}).get(f.context.actor.key)[0].semanticAuditRecovery;
  assert(Object.isFrozen(loaded) && Object.isFrozen(loaded.targets) && Object.isFrozen(loaded.targets[0]));
  assert(Object.isFrozen(loaded.originalPolicy) && Object.isFrozen(loaded.originalPolicy.allowedTargets[0]));
  const targetWrites = f.writes.targetWrites;
  for (const target of grant.targets) await recoverTarget({...x,target});
  const filled = await readCycle(f, grant.cycleRunUrn);
  assert.equal(filled.accountedCount,76); assert.equal(filled.exceptionCount,75); assert.equal(filled.pendingCount,0);
  assert.equal(filled.publications[0].status,"VERIFIED");
  const receipts = [];
  for (const offset of [0, 20, 40, 60]) {
    const page = await readCycle(f, grant.cycleRunUrn, offset);
    receipts.push(...page.publications, ...page.exceptions);
  }
  assert.equal(new Set(receipts.map((entry) => entry.decisionId)).size, 76);
  const native = latestValue(f,"ekopAgentRun");
  assert.deepEqual(native.decisions.slice(0,before.decisions.length),before.decisions);
  assert.deepEqual(latestValue(f,"ekopAgentTask"),task,"old instructions, policy digest and lease stay byte-equivalent");
  assert(native.decisions.slice(before.decisions.length).every(d=>JSON.parse(d.question.slice("semantic-managed-exception/1:".length)).auditRecovery.id===grant.id));
  const body={action:"finish_managed_cycle",requestId:randomUUID(),sessionId:f.sessionId,cycleRunUrn:grant.cycleRunUrn};
  f.writes.pending=body; const closed=await f.call({...body,uiRequestId:"fixture-ui"}); assert.equal(closed.closed,true);
  delete f.policy.semanticAuditRecovery;
  f.writes.now += 1800000;
  assert.equal((await readCycle(f,grant.cycleRunUrn)).accountedCount,76,"historical audit remains readable after grant revocation/expiry");
  assert.equal(f.writes.targetWrites,targetWrites); assert.equal(targetWrites,1);
});

test("recovery grant never enables a new cycle or publication and cannot be supplied by a model", async () => {
  const x=await recoveryFixture(),{f,prepared}=x, writes=f.writes.recordWrites;
  f.writes.pending={...prepared.body,requestId:randomUUID()};
  await assert.rejects(f.call({...f.writes.pending,uiRequestId:"fixture-ui"}));
  await assert.rejects(f.startCycle());
  const body={action:"record_managed_exception",requestId:randomUUID(),sessionId:f.sessionId,cycleRunUrn:x.grant.cycleRunUrn,...x.target,code:"POLICY_DENIED",auditRecovery:x.grant};
  f.writes.pending=body; await assert.rejects(f.call({...body,uiRequestId:"fixture-ui"}),{message:"invalid_semantic_request"});
  assert.equal(f.writes.recordWrites,writes); assert.equal(f.writes.targetWrites,1);
});

test("audit recovery rejects wrong bindings, grants, targets and fabricated denial codes", async (t) => {
  for (const [name,mutate] of [
    ["missing grant",x=>delete x.f.policy.semanticAuditRecovery],
    ["expired grant",x=>x.grant.expiresAt=x.f.writes.now],
    ["unbounded grant",x=>x.grant.expiresAt=x.f.writes.now+1800001],
    ["other actor",x=>x.grant.cycleRunUrn=x.grant.cycleRunUrn.replace(x.f.context.actor.key,"f".repeat(48))],
    ["other run",x=>x.grant.cycleRunUrn=x.grant.cycleRunUrn.slice(0,-1)+(x.grant.cycleRunUrn.endsWith("0")?"1":"0")],
    ["other session",x=>x.grant.sessionId=randomUUID()],
    ["different schema scope",x=>x.grant.scopeFingerprint="f".repeat(64)],
    ["changed old policy digest",x=>x.grant.originalPolicy.expiresAt++],
    ["publication enabled",x=>x.f.policy.semanticPublicationApproved=true],
    ["original policy reactivated",x=>x.f.policy.semanticAutoManagement=x.grant.originalPolicy],
    ["target was originally allowed",x=>{x.target={assetUrn:x.f.dataset};x.grant.targets=[x.target]}],
    ["unlisted target",x=>x.grant.targets=x.grant.targets.slice(1)],
  ]) await t.test(name,async()=>{const x=await recoveryFixture(),writes=x.f.writes.recordWrites;mutate(x);await assert.rejects(recoverTarget(x));assert.equal(x.f.writes.recordWrites,writes);assert.equal(x.f.writes.targetWrites,1)});
  const x=await recoveryFixture(),writes=x.f.writes.recordWrites;
  await assert.rejects(recoverTarget(x,"INSUFFICIENT_EVIDENCE"));assert.equal(x.f.writes.recordWrites,writes);
});

test("audit-only receipts cannot overwrite an occupied target or conceal UNKNOWN", async () => {
  const x=await recoveryFixture();await recoverTarget(x);const writes=x.f.writes.recordWrites;
  await assert.rejects(recoverTarget(x),{message:"semantic_managed_target_conflict"});assert.equal(x.f.writes.recordWrites,writes);
  const f=managedFixture();f.writes.lossAfter=1;const prepared=await f.pending(description);await assert.rejects(prepared.call());
  const cycle=await readCycle(f,prepared.body.cycleRunUrn);assert.equal(cycle.pendingCount,1);
  // Only a different, truly denied target is granted; this cannot bless the failed publication.
  cycle.missing=cycle.missing.filter(([urn,field])=>urn!==f.dataset||field!==null);
  const grant=permitAuditRecovery(f,cycle),beforeWrites=f.writes.recordWrites;
  await assert.rejects(recoverTarget({f,grant,target:grant.targets[0]}),{message:"semantic_audit_recovery_unverified_cycle"});
  assert.equal(f.writes.recordWrites,beforeWrites);assert.equal(f.writes.targetWrites,1);
  assert.equal((await readCycle(f,grant.cycleRunUrn)).publications[0].status,"UNKNOWN_OR_CHANGED");
});

test("audit grant is rechecked after the final awaited identity and for the response CAS", async (t) => {
  for(const where of ["beforeAppend","betweenAppendAndResponse"]) await t.test(where,async()=>{
    const x=await recoveryFixture(),{f}=x,base=f.writes.recordWrites;
    if(where==="beforeAppend"){
      const state=f.context.runtime.state,fetch=f.context.fetchImpl;let pending=0,identities=0;
      f.context.runtime.state=async(...args)=>{const value=await state(...args);pending++;return value};
      f.context.fetchImpl=async(url,options)=>{const body=options.body?JSON.parse(options.body):{};const response=await fetch(url,options);if(pending>=2&&url.pathname==="/api/v2/graphql"&&body.query?.includes("me { corpUser")&&++identities===2)f.writes.now=x.grant.expiresAt;return response};
    }else f.writes.afterRecord=(aspect,value)=>{if(aspect==="ekopAgentRun"&&value.decisions.at(-1)?.question.includes('"auditRecovery"'))delete f.policy.semanticAuditRecovery};
    await assert.rejects(recoverTarget(x),{message:"semantic_audit_recovery_not_active"});assert.equal(f.writes.targetWrites,1);
    assert.equal(f.writes.recordWrites-base,where==="beforeAppend"?0:1);
    if(where!=="beforeAppend")assert.equal(latestValue(f,"ekopAgentRun").decisions.at(-1).response,undefined,"revocation leaves the intent unconfirmed rather than fabricating a receipt");
  });
});

test("audit configuration rejects unknown, mutable-scope and contradictory authority shapes", async () => {
  const {f}=await recoveryFixture();
  for (const mutate of [
    source=>source.semanticAuditRecovery.allowPublish=true,
    source=>source.semanticAuditRecovery.targets.push(source.semanticAuditRecovery.targets[0]),
    source=>source.semanticAuditRecovery.targets=[{assetUrn:f.dataset}],
    source=>source.semanticAuditRecovery.originalPolicy.extra=true,
    source=>source.semanticAuditRecovery.expiresAt=String(source.semanticAuditRecovery.expiresAt),
    source=>source.semanticAuditRecovery.id=[source.semanticAuditRecovery.id],
    source=>delete source.semanticAgentUrn,
    source=>source.semanticAuditRecovery.targets=[{assetUrn:"urn:li:dataset:foreign"}],
  ]) {const source=structuredClone(f.policy);mutate(source);assert.throws(()=>ingestionPolicies({[f.context.actor.key]:[source]}),{message:"invalid_ingestion_policy"})}
});

test("a changed recovery grant cannot silently replace the proof during final identity read", async () => {
  const x=await recoveryFixture(),{f}=x,state=f.context.runtime.state,fetch=f.context.fetchImpl,writes=f.writes.recordWrites;let pending=0,identities=0,changed=false;
  f.context.runtime.state=async(...args)=>{const result=await state(...args);pending++;return result};
  f.context.fetchImpl=async(url,options)=>{const body=options.body?JSON.parse(options.body):{};const result=await fetch(url,options);if(pending>=2&&url.pathname==="/api/v2/graphql"&&body.query?.includes("me { corpUser")&&++identities===2){x.grant.id="different-recovery";changed=true}return result};
  await assert.rejects(recoverTarget(x),{message:"semantic_audit_recovery_changed"});assert(changed);assert.equal(f.writes.recordWrites,writes);assert.equal(f.writes.targetWrites,1);
});

test("audit recovery rejects changed values, pending intents, and consumed NOT_DISPATCHED", async(t)=>{
  for(const kind of ["changedTarget","pendingIntent","notDispatched"])await t.test(kind,async()=>{
    const x=await recoveryFixture(),{f}=x,native=f.journal.get(`${x.grant.cycleRunUrn}/ekopAgentRun`).at(-1).value;
    if(kind==="changedTarget")f.rows.get(f.dataset).editableDatasetProperties.value.description="Changed by another writer";
    if(kind==="pendingIntent")native.decisions.push({id:randomUUID(),question:"Unanswered original intent",choices:[],requestedAt:f.writes.now});
    if(kind==="notDispatched")native.decisions.find(d=>d.publicationAttempt).publicationAttempt.outcomeJson=JSON.stringify({status:"NOT_DISPATCHED",recordedAt:f.writes.now});
    const writes=f.writes.recordWrites;await assert.rejects(recoverTarget(x),{message:"semantic_audit_recovery_unverified_cycle"});assert.equal(f.writes.recordWrites,writes);assert.equal(f.writes.targetWrites,1);
  });
});

test("recovery receipt readback rejects substituted policy bindings and out-of-window responses",async(t)=>{
  for(const kind of ["policyDigest","respondedAt","requestedBeforeWindow"])await t.test(kind,async()=>{
    const x=await recoveryFixture();await recoverTarget(x);const last=x.f.journal.get(`${x.grant.cycleRunUrn}/ekopAgentRun`).at(-1).value.decisions.at(-1),prefix="semantic-managed-exception/1:";
    if(kind==="policyDigest"){const payload=JSON.parse(last.question.slice(prefix.length));payload.auditRecovery.policyDigest="f".repeat(64);last.question=prefix+JSON.stringify(payload);last.response.text=last.question}
    else if(kind==="respondedAt")last.response.respondedAt=x.grant.expiresAt;
    else last.requestedAt=x.grant.expiresAt-1800001;
    await assert.rejects(readCycle(x.f,x.grant.cycleRunUrn),{message:"semantic_managed_audit_receipt_invalid"});assert.equal(x.f.writes.targetWrites,1);
  });
});
