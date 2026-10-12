import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { projectManagedContractEvidence } from "../extensions/datahub-agent/integration/semantic-managed-evidence.mjs";
import { semanticCatalogFixture } from "./fixtures/semantic-catalog-fixture.mjs";
import { executionUrn } from "./fixtures/semantic-fixture.mjs";
import { parseCatalogRequest } from "../extensions/datahub-agent/integration/native-semantic-catalog.mjs";
import { semanticCandidateLimit } from "../extensions/datahub-agent/integration/semantic-catalog-contract.mjs";

const sourceUrn = "urn:li:dataHubIngestionSource:c382a4fe-48a9-4a0b-893a-95029a74b25f";
const root = new URL("../", import.meta.url);
const sourceFile = "extensions/sales-datamart/src/sales_datamart/summary.py";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const asset = (name) => `urn:li:dataset:(urn:li:dataPlatform:mssql,salesdatamart.${name},PROD)`;
const schemas = {
  "dm.dim_date": ["datekey", "fulldate", "calendaryear", "calendarquarter", "calendarmonth", "monthname", "dayofmonth"],
  "dm.dim_product": ["productkey", "sourceproductid", "productname", "productnumber", "sourceproductsubcategoryid", "productsubcategoryname", "sourceproductcategoryid", "productcategoryname"],
  "dm.dim_customer": ["customerkey", "sourcecustomerid", "sourceterritoryid", "territorykey"],
  "dm.dim_territory": ["territorykey", "sourceterritoryid", "territoryname", "countryregioncode", "territorygroup"],
  "dm.fact_sales_order_line": ["salesorderid", "salesorderdetailid", "orderdatekey", "productkey", "customerkey", "territorykey", "status", "currencyrateid", "orderqty", "unitprice", "unitpricediscount", "linenetamount", "sourcelinetotal"],
  "dm.monthly_category_summary": ["monthstart", "productcategoryid", "productcategoryname", "linecount", "ordercount", "quantity", "netsales", "sourcelinetotal"],
  "reporting.v_sales_order_line": ["salesorderid", "salesorderdetailid", "orderdate", "orderdatekey", "productkey", "sourceproductid", "productname", "productnumber", "productsubcategoryname", "productcategoryname", "customerkey", "sourcecustomerid", "territorykey", "sourceterritoryid", "territoryname", "countryregioncode", "territorygroup", "status", "currencyrateid", "orderqty", "unitprice", "unitpricediscount", "linenetamount", "sourcelinetotal"],
};
const document = (value) => Buffer.from("# Synthetic contract only\n\n- `Quantity = SUM(OrderQty)`; legacy contextual measure, not a second scoped statement.\n\n<!-- ekop-semantic-catalog-evidence/1 -->\n```json\n" + JSON.stringify(value) + "\n```\n");
const reference = () => [{ file: sourceFile, startLine: 23, endLine: 42 }];
const sample = () => ({ format: "salesdatamart.semantic-evidence/1", sources: { [sourceFile]: "a".repeat(64) }, statements: [
  { assetUrn: asset("dm.monthly_category_summary"), text: "Synthetic explicit monthly/category grain statement", references: reference() },
  { assetUrn: asset("dm.monthly_category_summary"), fieldPath: "quantity", text: "Synthetic explicit quantity aggregation per month/category, not a business assertion", references: reference() },
] });
function project(value = sample(), urn = asset("dm.monthly_category_summary"), fields = [{ fieldPath: "quantity" }]) {
  const bytes = document(value);
  return projectManagedContractEvidence({ urn: sourceUrn, semanticEvidenceSha256: hash(bytes) }, urn, fields, bytes);
}

test("candidate count accepts 1024 and rejects 1025 independently of byte/policy limits", () => {
  assert.equal(semanticCandidateLimit, 1024);
  const request = { action: "preview", contract: "catalog/1", requestId: randomUUID(), sourceUrn,
    assetUrn: asset("dm.dim_date"), snapshotDigest: "a".repeat(64), candidates: Array.from({ length: 1024 }, (_, i) => ({
      kind: "description", fieldPath: `field_${i}`, operation: "set", value: "Pinned statement", reason: "Evidence",
      evidenceIds: ["asset:contract-statement-1"],
    })) };
  assert.equal(parseCatalogRequest(request).candidates.length, 1024, "pure shape check is not publication permission");
  request.candidates.push({ ...request.candidates[0] });
  assert.throws(() => parseCatalogRequest(request), { message: "semantic_invalid_candidate" });
});

test("scoped statements preserve exact Dataset/field binding, explicit text and pinned code references", () => {
  const proof = project();
  assert.equal(proof.length, 2);
  assert.equal(proof[0].id, "asset:contract-statement-1");
  assert.equal(proof[1].id, "field:0:contract-statement-2");
  assert.equal(proof[1].text, sample().statements[1].text);
  assert.equal(proof[1].provenance.pointer, "/statements/1");
  assert.deepEqual(proof[1].provenance.references[0], { ...reference()[0], sha256: "a".repeat(64) });
  assert.deepEqual(project(sample(), asset("dm.fact_sales_order_line")), []);
  assert.equal(project(sample(), asset("dm.monthly_category_summary"), [{ fieldPath: "Quantity" }]).length, 1, "v2 never lowercases field identity");
  assert.deepEqual(project(sample(), "urn:li:dataset:outside"), []);
});

for (const [name, alter] of [
  ["duplicate scoped target", (v) => v.statements.push(structuredClone(v.statements[1]))],
  ["unapproved file", (v) => { v.sources["../../.env"] = "a".repeat(64); }],
  ["unbound reference", (v) => { v.statements[0].references[0].file = "../../.env"; }],
  ["unknown selector", (v) => { v.statements[0].sql = "SELECT secret"; }],
  ["different source/asset namespace", (v) => { v.statements[0].assetUrn = "urn:li:dataset:(urn:li:dataPlatform:mssql,other.dm.dim_date,PROD)"; }],
  ["null field identity", (v) => { v.statements[0].fieldPath = null; }],
  ["empty evidence", (v) => { v.statements[0].text = " "; }],
  ["reversed lines", (v) => { v.statements[0].references[0].endLine = 1; }],
  ["missing proof", (v) => { v.statements[0].references = []; }],
]) test(`invalid ${name} stops without legacy fallback`, () => {
  const value = sample(); alter(value);
  assert.throws(() => project(value), { message: "semantic_contract_invalid" });
});

test("unsupported/malformed/multiple blocks and wrong bytes or Source fail closed", () => {
  for (const bytes of [document(sample()).toString().replace("evidence/1 -->", "evidence/2 -->"), document(sample()).toString().replace('"format"', 'invalid"format"'), document(sample()).toString().repeat(2)]) {
    const b = Buffer.from(bytes);
    assert.throws(() => projectManagedContractEvidence({ urn: sourceUrn, semanticEvidenceSha256: hash(b) }, asset("dm.monthly_category_summary"), [], b), { message: "semantic_contract_invalid" });
  }
  const bytes = document(sample());
  assert.throws(() => projectManagedContractEvidence({ urn: sourceUrn, semanticEvidenceSha256: "0".repeat(64) }, asset("dm.monthly_category_summary"), [], bytes), { message: "semantic_contract_changed" });
  assert.throws(() => projectManagedContractEvidence({ urn: "urn:li:dataHubIngestionSource:other", semanticEvidenceSha256: hash(bytes) }, asset("dm.monthly_category_summary"), [], bytes), { message: "semantic_contract_not_authorized" });
});

/** Real Host/compiler/reader source in an owned temporary deployment layout,
 * mocked public API only. Neither overwrites active metrics.md nor runs ETL/SQL,
 * provider code, containers or a production listener. */
async function isolatedFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "semantic-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "extensions/datahub-agent"), { recursive: true });
  await cp(new URL("extensions/datahub-agent/integration", root), join(directory, "extensions/datahub-agent/integration"), { recursive: true });
  await mkdir(join(directory, "extensions/sales-datamart/metadata"), { recursive: true });
  await mkdir(join(directory, "extensions/sales-datamart/src/sales_datamart"), { recursive: true });
  const code = await readFile(new URL(sourceFile, root));
  await writeFile(join(directory, sourceFile), code);
  const { semanticHost } = await import(pathToFileURL(join(directory, "extensions/datahub-agent/integration/native-semantic-tasks.mjs")).href);
  const f = semanticCatalogFixture(), rows = new Map(), recipe = JSON.parse(await readFile(new URL("extensions/sales-datamart/metadata/target-ingestion.json", root)));
  const text = JSON.stringify(recipe);
  Object.assign(f.policy, { urn: sourceUrn, recipeSha256: hash(text), taskDatasets: Object.keys(schemas).map(asset), semanticAutoManagement: {
    id: "fixture-scoped-contract", mode: "AUTO", runUrn: executionUrn, expiresAt: f.writes.now + 3600000,
    allowedKinds: ["description", "tag"], allowAgentDescriptionUpdates: true,
    allowedTargets: Object.entries(schemas).flatMap(([name, fields]) => [{ assetUrn: asset(name) }, ...fields.map((fieldPath) => ({ assetUrn: asset(name), fieldPath }))]),
  } });
  for (const [name, fields] of Object.entries(schemas)) {
    const urn = asset(name), row = structuredClone(f.state.dataset);
    row.urn = urn; row.datasetKey.value.name = "salesdatamart." + name;
    row.datasetProperties.value.description = ""; delete row.editableDatasetProperties;
    row.editableSchemaMetadata.value.editableSchemaFieldInfo = []; row.editableSchemaMetadata.value.unknown = { preserved: true };
    row.schemaMetadata.value.fields = fields.map((fieldPath) => ({ fieldPath, nativeDataType: "synthetic", description: "" }));
    Object.assign(row.schemaMetadata.systemMetadata, { runId: executionUrn.split(":").at(-1), pipelineName: sourceUrn });
    rows.set(urn, row); f.state.definitions[urn] = row;
  }
  f.state.execution.dataHubExecutionRequestInput.value.source.ingestionSource = sourceUrn;
  Object.assign(f.state.execution.dataHubExecutionRequestInput.value.args, { version: "1.7.0.9", recipe: JSON.stringify({ ...recipe, run_id: executionUrn, pipeline_name: sourceUrn }) });
  const fetchImpl = f.context.fetchImpl;
  f.context.fetchImpl = async (url, options) => {
    const input = JSON.parse(options.body);
    if (url.pathname === "/api/v2/graphql" && input.query.includes("latestSuccessfulExecution"))
      return Response.json({ data: { ingestionSource: { urn: sourceUrn, latestSuccessfulExecution: { urn: executionUrn } } } });
    if (url.pathname === "/api/v2/graphql" && input.query.includes("getGrantedPrivileges") && [sourceUrn, executionUrn].includes(input.variables.input.resourceSpec.resourceUrn))
      return Response.json({ data: { getGrantedPrivileges: { privileges: ["VIEW_ENTITY_PAGE", "EDIT_ENTITY"] } } });
    if (url.pathname === "/openapi/v3/entity/datahubingestionsource/batchGet")
      return Response.json([{ urn: sourceUrn, dataHubIngestionSourceInfo: { value: { name: "Synthetic contract source", type: "mssql", config: { recipe: text, version: "1.7.0.9", executorId: "default" } }, systemMetadata: { version: "1" } } }]);
    if (url.pathname === "/openapi/v3/entity/dataset/batchGet" && rows.has(input[0].urn))
      return Response.json([Object.fromEntries(Object.entries(rows.get(input[0].urn)).filter(([key]) => key === "urn" || Object.hasOwn(input[0], key)))]);
    return fetchImpl(url, options);
  };
  const data = { format: "salesdatamart.semantic-evidence/1", sources: { [sourceFile]: hash(code) }, statements: Object.entries(schemas).flatMap(([name, fields]) => [
    { assetUrn: asset(name), text: `Synthetic explicit Dataset statement for ${name}`, references: reference() },
    ...fields.map((fieldPath) => ({ assetUrn: asset(name), fieldPath, text: `Synthetic explicit field statement for ${name}.${fieldPath}`, references: reference() })),
  ]) };
  async function installContract() {
    const bytes = document(data); await writeFile(join(directory, "extensions/sales-datamart/metadata/metrics.md"), bytes); f.policy.semanticEvidenceSha256 = hash(bytes);
  }
  await installContract();
  const call = (body) => semanticHost(JSON.stringify(body), f.context);
  const inspect = (assetUrn, offset = 0, snapshotDigest) => call({ action: "inspect_managed_maintenance", contract: "catalog/1", requestId: randomUUID(), sourceUrn, assetUrn, offset, ...(snapshotDigest ? { snapshotDigest } : {}) });
  async function start() {
    const scope = await call({ action: "inspect_managed_scope", contract: "catalog/1", requestId: randomUUID(), sourceUrn });
    const ref = scope.managedCycle;
    const body = { action: "start_managed_cycle", contract: "catalog/1", requestId: randomUUID(), sessionId: f.sessionId, sourceUrn,
      scopeFingerprint: scope.scope.fingerprint, cycleRunUrn: ref.runUrn, cycleTaskUrn: ref.taskUrn,
      ...(ref.previousCycleRunUrn ? { previousCycleRunUrn: ref.previousCycleRunUrn } : {}) };
    f.writes.pending = body; await call({ ...body, uiRequestId: "fixture-ui" });
    return { ref, scope: scope.scope };
  }
  async function prepare(cycle, assetUrn, candidates) {
    const plan = await inspect(assetUrn);
    const body = { action: "prepare_managed", contract: "catalog/1", requestId: randomUUID(), sessionId: f.sessionId, sourceUrn, assetUrn,
      snapshotDigest: plan.snapshotDigest, scopeFingerprint: cycle.scope.fingerprint, cycleRunUrn: cycle.ref.runUrn, cycleTaskUrn: cycle.ref.taskUrn, candidates };
    f.writes.pending = body; return call({ ...body, uiRequestId: "fixture-ui" });
  }
  async function finish(cycle) {
    const body = { action: "finish_managed_cycle", requestId: randomUUID(), sessionId: f.sessionId, cycleRunUrn: cycle.ref.runUrn };
    f.writes.pending = body; return call({ ...body, uiRequestId: "fixture-ui" });
  }
  async function proposals(urn) {
    const first = await inspect(urn), items = [...first.maintenance.items];
    if (first.nextOffset !== null) items.push(...(await inspect(urn, first.nextOffset, first.snapshotDigest)).maintenance.items);
    return items;
  }
  return { ...f, directory, data, rows, call, inspect, start, prepare, finish, proposals, installContract };
}

test("actual fixed reader and native Host maintain all 76 synthetic targets, then same-policy evidence revision updates one and keeps 75", async (t) => {
  const f = await isolatedFixture(t), cycle = await f.start();
  const policy = structuredClone(f.policy.semanticAutoManagement);
  let count = 0;
  for (const urn of f.rows.keys()) {
    const items = await f.proposals(urn); count += items.length;
    assert(items.every((item) => item.disposition === "ADD" && item.routing === "OPERATOR_POLICY"));
    // Whole-asset write: paging inspection is not permission to shard writes
    // to the same Aspect and invalidate earlier current-value observations.
    assert.equal((await f.prepare(cycle, urn, items.map((item) => item.candidate))).publication.status, "VERIFIED_CURRENT_VALUES");
  }
  assert.equal(count, 76);
  const completed = await f.finish(cycle);
  assert.equal(completed.closed, true, JSON.stringify({ status: completed.status, accountedCount: completed.accountedCount,
    missingCount: completed.missingCount, publications: completed.publications.map((item) => ({ status: item.status, targets: item.targets })) }));
  const oldRun = structuredClone(f.journal.get(`${cycle.ref.runUrn}/ekopAgentRun`).at(-1));
  const oldTask = structuredClone(f.journal.get(`${cycle.ref.taskUrn}/ekopAgentTask`)[0]);
  const baseline = structuredClone([...f.rows]);
  f.data.statements[0].text = "Synthetic revised, explicitly written Dataset statement";
  await f.installContract();
  const next = await f.start();
  assert.equal(next.ref.taskUrn, cycle.ref.taskUrn); assert.notEqual(next.ref.runUrn, cycle.ref.runUrn);
  const writes = f.writes.targetWrites;
  for (const urn of f.rows.keys()) {
    const items = await f.proposals(urn);
    for (const item of items) {
      if (urn === f.data.statements[0].assetUrn && item.fieldPath === undefined) {
        assert.equal(item.disposition, "UPDATE_AGENT"); assert.equal(item.priorAgent.status, "VERIFIED_AGENT_BASELINE");
        assert.equal(item.before, baseline[0][1].editableDatasetProperties.value.description);
      } else assert.equal(item.disposition, "KEEP");
      await f.prepare(next, urn, [item.candidate]);
    }
  }
  assert.equal((await f.finish(next)).closed, true);
  assert.equal(f.writes.targetWrites - writes, 1, "revision does not republish unchanged targets");
  assert.deepEqual(f.policy.semanticAutoManagement, policy);
  assert.deepEqual(f.journal.get(`${cycle.ref.runUrn}/ekopAgentRun`).at(-1), oldRun);
  assert.deepEqual(f.journal.get(`${cycle.ref.taskUrn}/ekopAgentTask`)[0], oldTask);
  for (const [urn, row] of baseline) {
    const current = f.rows.get(urn);
    assert.deepEqual(current.editableSchemaMetadata, row.editableSchemaMetadata);
    assert.deepEqual(current.globalTags, row.globalTags); assert.deepEqual(current.structuredProperties, row.structuredProperties);
    if (urn !== f.data.statements[0].assetUrn) assert.deepEqual(current.editableDatasetProperties, row.editableDatasetProperties);
  }
});

test("raised count still rejects oversized Host input before identity/API or native write", async (t) => {
  const f = await isolatedFixture(t);
  const before = JSON.stringify([...f.journal]);
  const writes = { record: f.writes.recordWrites, target: f.writes.targetWrites };
  await assert.rejects(f.call({ action: "preview", requestId: randomUUID(), padding: "x".repeat(24001) }),
    { message: "invalid_semantic_request" });
  assert.equal(JSON.stringify([...f.journal]), before);
  assert.deepEqual({ record: f.writes.recordWrites, target: f.writes.targetWrites }, writes);
});

test("fixed source drift rejects inspection before any native write; contract statements do not widen non-description AUTO evidence", async (t) => {
  const f = await isolatedFixture(t), cycle = await f.start(), urn = f.data.statements[0].assetUrn;
  const writes = f.writes.recordWrites;
  await writeFile(join(f.directory, sourceFile), "# drifted implementation\n");
  await assert.rejects(f.inspect(urn), { message: "semantic_contract_changed" });
  assert.equal(f.writes.recordWrites, writes); assert.equal(f.writes.targetWrites, 0);
  await writeFile(join(f.directory, sourceFile), await readFile(new URL(sourceFile, root)));
  const item = (await f.proposals(urn))[0];
  await assert.rejects(f.prepare(cycle, urn, [{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", reason: "Synthetic negative only", evidenceIds: item.candidate.evidenceIds }]), /semantic_managed_evidence_exception/);
  assert.equal(f.writes.targetWrites, 0);
});

test("scoped statements retain human protection and reject revoked publication, asset ACL and Source identity", async (t) => {
  const f = await isolatedFixture(t), cycle = await f.start(), urn = f.data.statements[0].assetUrn;
  f.rows.get(urn).editableDatasetProperties = { value: { description: "Existing human statement", unknown: { preserved: true } }, systemMetadata: { version: "1" } };
  const item = (await f.proposals(urn))[0]; assert.equal(item.routing, "HUMAN_REVIEW");
  const pending = await f.prepare(cycle, urn, [item.candidate]); assert.equal(pending.state, "PENDING"); assert.equal(f.writes.targetWrites, 0);
  f.policy.semanticPublicationApproved = false;
  await assert.rejects(f.call({ action: "approve_review", ...pending.reviewRef, version: pending.runVersion, planDigest: pending.planDigest }), /semantic_publication_not_authorized/);
  const history = await f.call({ action: "read_review", ...pending.reviewRef }); assert.equal(history.readOnly, true);
  assert.equal(f.rows.get(urn).editableDatasetProperties.value.description, "Existing human statement"); assert.equal(f.writes.targetWrites, 0);
  f.state.denied.add(urn); await assert.rejects(f.inspect(urn), /denied|forbidden/);
  f.state.denied.delete(urn); f.state.meUrn = "urn:li:corpuser:other"; await assert.rejects(f.inspect(urn), /identity_denied|semantic_identity_required/);
});
