import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { createJiti } = createRequire(new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url))("jiti");
const { default: semanticExtension } = await createJiti(import.meta.url).import("../extensions/datahub-agent/pi-web/lib/datahub-semantic-extension.ts");
import { semanticReviewPolicy } from "../extensions/datahub-agent/integration/semantic-native-client.mjs";
import { randomUUID } from "node:crypto";
import { semanticCatalogFixture } from "./fixtures/semantic-catalog-fixture.mjs";
import { sourceUrn, datasetUrn } from "./fixtures/semantic-fixture.mjs";
import { nativeSemantic } from "../extensions/datahub-agent/integration/native-semantic.mjs";
import { compileSemanticPublication, recompileSemanticPublication } from "../extensions/datahub-agent/integration/semantic-publication.mjs";

const policy = {
  semanticModelContextApproved: true,
  semanticCatalogUpdatesApproved: true,
  semanticPublicationApproved: true,
  semanticAgentUrn: "urn:li:aiAgent:configured",
  semanticAuditAudience: "EXISTING_TASK_RUN_ACL",
  semanticDefinitionCreationApproved: true,
  semanticDefinitionUpdatesApproved: false,
};
function tool() {
  let registered;
  semanticExtension({ on() {}, appendEntry() {}, registerTool(value) { registered = value; } });
  return registered;
}
const ctx = (input) => ({ mode: "rpc", abort() {}, ui: { input, notify() {} }, sessionManager: { getSessionId: () => "approved-fixture-session" } });

test("Source review eligibility is independent of human publication consent and definition flags", () => {
  assert.deepEqual(semanticReviewPolicy(policy, { catalog: true }), {
    basis: "current_host_source_policy_not_human_consent",
    canPrepareReview: true,
    canPrepareDefinitionCreation: true,
    canPrepareDefinitionUpdate: false,
    humanApprovalRequired: true,
    directPublicationAuthorized: false,
  });
  for (const patch of [{ semanticPublicationApproved: false }, { semanticAgentUrn: null }, { semanticAuditAudience: null }, { semanticCatalogUpdatesApproved: false }]) {
    const result = semanticReviewPolicy({ ...policy, ...patch }, { catalog: true });
    assert.equal(result.canPrepareReview, false);
    assert.equal(result.canPrepareDefinitionCreation, false);
    assert.equal(result.directPublicationAuthorized, false);
  }
  assert.equal(semanticReviewPolicy(undefined).canPrepareReview, false);
  assert.equal(semanticReviewPolicy({ ...policy, semanticCatalogUpdatesApproved: false }).canPrepareReview, true);
});

test("registered tool explains exact Catalog inputs and false flag without inventory/AUTO bypass", () => {
  const registered = tool();
  assert.match(registered.description, /sourceUrn.*REQUIRED/);
  assert.match(registered.description, /NO query, NO assetUrn/);
  assert.match(registered.description, /NO human consent.*NOT that Source review permission is denied/);
  assert.match(registered.description, /completeSourceInventory=false.*NOT explicit-scope Catalog manual review/);
  assert.match(registered.parameters.properties.query.description, /NEVER list_assets/);
  assert.match(registered.parameters.properties.sourceUrn.description, /REQUIRED/);
});

test("malformed read returns actionable static guidance, makes one call, never echoes payload or retries", async () => {
  let calls = 0;
  const registered = tool();
  await assert.rejects(registered.execute("id", { action: "list_assets", contract: "catalog/1", query: "payload-not-for-error-output" }, undefined, undefined,
    ctx(async () => { calls++; return JSON.stringify({ error: "invalid_semantic_catalog_request" }); })), (error) => {
      assert.match(error.message, /invalid_semantic_catalog_request.*list_assets\(sourceUrn/);
      assert.match(error.message, /NO query\/assetUrn/);
      assert.doesNotMatch(error.message, /payload-not-for-error-output/);
      return true;
    });
  assert.equal(calls, 1);
});

test("unknown preparation preserves reconciliation/no-retry instead of read-format guidance", async () => {
  let calls = 0;
  const result = await tool().execute("id", { action: "prepare_review", contract: "catalog/1" }, undefined, undefined,
    ctx(async () => { calls++; return JSON.stringify({ error: "invalid_semantic_request", reconciliation: { runUrn: "urn:li:dataProcessInstance:existing", decisionId: "existing" } }); }));
  assert.equal(calls, 1);
  assert.equal(result.details.retryAllowed, false);
  assert.match(result.details.note, /do not repeat preparation/);
  assert.equal(result.details.reconciliation.runUrn, "urn:li:dataProcessInstance:existing");
});

test("original malformed Catalog calls fail; correct explicit scope can save one pending definition without a complete inventory or target write", async () => {
  const f = semanticCatalogFixture();
  for (const input of [{ action: "list_assets", query: "Product" }, { action: "inspect_asset", assetUrn: datasetUrn }, { action: "search_vocabulary", kind: "term", query: "Product" }]) {
    await assert.rejects(nativeSemantic(JSON.stringify({ contract: "catalog/1", requestId: randomUUID(), ...input }), f.context), /invalid_semantic_catalog_request/);
  }
  const sources = await nativeSemantic(JSON.stringify({ action: "list_sources", requestId: randomUUID() }), f.context);
  assert.equal(sources.sources[0].reviewPolicy.canPrepareReview, true);
  const inspected = await f.inspect();
  assert.equal(inspected.publicationAuthorized, false);
  assert.equal(inspected.reviewPolicy.canPrepareDefinitionCreation, true);
  assert.equal(inspected.scope.completeSourceInventory, false);
  const req = await f.definitionRequest({ kind: "term", operation: "create", name: "Fixture Product Identity", description: "Explicit proposed identity grouping; human review required" });
  const prepared = await f.prepare(req);
  assert.ok(prepared.reviewRef.runUrn);
  assert.equal(prepared.publicationAuthorized, false);
  assert.equal(f.writes.targetWrites, 0);
  f.policy.semanticPublicationApproved = false;
  assert.equal((await f.inspect()).reviewPolicy.canPrepareDefinitionCreation, false);
  await assert.rejects(compileSemanticPublication(await f.definitionRequest(req.definition), f.context), /semantic_publication_not_authorized/);
});

test("read-only capability projection is excluded from stable review context/digests while policy is still pinned", async () => {
  const f = semanticCatalogFixture();
  const req = await f.definitionRequest({ kind: "term", operation: "create", name: "Fixture Stable Identity", description: "A synthetic definition proposal" });
  const review = await compileSemanticPublication(req, f.context, { createdAt: 1000, expiresAt: 61000 });
  const saved = JSON.parse(review.semanticContextJson);
  assert.equal(Object.hasOwn(saved.preview, "reviewPolicy"), false);
  assert.match(saved.policySha256, /^[a-f0-9]{64}$/);
  assert.equal((await recompileSemanticPublication(review, f.context)).planDigest, review.planDigest);
  const legacy = structuredClone(req); delete legacy.contract; delete legacy.assetUrn; delete legacy.definition.operation;
  legacy.datasetUrn = datasetUrn;
  const legacyInspect = await nativeSemantic(JSON.stringify({ action: "inspect_dataset", requestId: randomUUID(), sourceUrn, datasetUrn }), f.context);
  legacy.snapshotDigest = legacyInspect.snapshotDigest;
  legacy.evidenceIds = [legacyInspect.evidence.find((e) => e.id.startsWith("dataset:")).id];
  const legacyReview = await compileSemanticPublication(legacy, f.context, { createdAt: 1000, expiresAt: 61000 });
  assert.equal(Object.hasOwn(JSON.parse(legacyReview.semanticContextJson).preview, "reviewPolicy"), false);
  assert.equal((await recompileSemanticPublication(legacyReview, f.context)).planDigest, legacyReview.planDigest);
});

test("Source eligibility never relaxes SDK publicationAuthorized:false response guard", async () => {
  for (const publicationAuthorized of [false, true]) {
    const request = { action: "inspect_asset", contract: "catalog/1", sourceUrn: "urn:li:dataHubIngestionSource:fixture", assetUrn: "urn:li:dataset:fixture" };
    const promise = tool().execute("id", request, undefined, undefined, ctx(async (_title, body) => {
      const input = JSON.parse(body);
      return JSON.stringify({ format: "datahub-semantic.preview/1", action: input.action, requestId: input.requestId, publicationAuthorized,
        assetUrn: input.assetUrn, snapshotDigest: "a".repeat(64), offset: 0, nextOffset: null, reviewPolicy: semanticReviewPolicy(policy, { catalog: true }) });
    }));
    if (publicationAuthorized) {
      const rejected = (await promise).details;
      assert.equal(rejected.error, "invalid_semantic_host_response");
      assert.equal(rejected.retryAllowed, false);
      assert.equal(rejected.publicationAuthorized, undefined);
    } else assert.equal((await promise).details.reviewPolicy.canPrepareReview, true);
  }
});
