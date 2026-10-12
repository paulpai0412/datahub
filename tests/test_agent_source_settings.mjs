import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rm, chmod, symlink, stat } from "node:fs/promises";
import { sourceSettingsFixture } from "./fixtures/source-settings-fixture.mjs";
import { createSourceSettingsStore, sourcePolicyContext } from "../extensions/datahub-agent/integration/source-settings.mjs";
import { nativeIngestion } from "../extensions/datahub-agent/integration/native-ingestion.mjs";
import { ingestionPolicies, sourceDatasetLimit } from "../extensions/datahub-agent/integration/ingestion-policy.mjs";
import { nativeSemanticCatalog } from "../extensions/datahub-agent/integration/native-semantic-catalog.mjs";
import { compileSemanticPublication } from "../extensions/datahub-agent/integration/semantic-publication.mjs";

async function fixture(t, count) { const f = await sourceSettingsFixture(count); t.after(() => rm(f.dir, { recursive: true, force: true })); return f; }
async function input(f, enabled = true) {
  const view = await f.call({ action: "inspect", sourceUrn: f.urn });
  return { action: "preview", sourceUrn: f.urn, revision: view.revision, sourceVersion: view.source.version,
    datasetUrns: view.assets.map((a) => a.urn), enabled };
}

test("native admin enables 91 exact Dataset scopes, saved policy is active, persistent, actor isolated and read-only", async (t) => {
  const f = await fixture(t), before = await f.store.current();
  const list = await f.call({ action: "list" }); assert.equal(list.sources[0].enabled, false); assert.equal(list.sources[1].editable, false);
  const request = await input(f), preview = await f.call(request);
  assert.equal(preview.after.datasetUrns.length, 91); assert.equal(preview.publicationApproved, false);
  assert.equal((await f.store.current()).revision, before.revision); assert.equal(f.applied, undefined);
  const saved = await f.call({ ...request, action: "save", planDigest: preview.planDigest });
  assert.equal(saved.status, "SAVED_AND_ACTIVE"); assert.notEqual(saved.revision, before.revision);
  const policy = f.applied.get(f.actor.key).find((s) => s.urn === f.urn);
  assert.equal(policy.ingestionExecutionApproved, false); assert.equal(policy.semanticPublicationApproved, false);
  assert.equal(policy.semanticModelContextApproved, true); assert.equal(policy.semanticCatalogUpdatesApproved, true);
  assert.equal(policy.semanticAutoManagement, undefined); assert.equal(policy.recipeSha256, f.hashRecipe);
  const disk = JSON.parse(await readFile(f.path, "utf8")); assert.deepEqual(disk.unchanged, f.initial.unchanged);
  assert.deepEqual(disk.ingestionSourcesByActor["b".repeat(48)], f.initial.ingestionSourcesByActor["b".repeat(48)]);
  assert.deepEqual(disk.ingestionSourcesByActor[f.actor.key][0], f.protectedPolicy);
  const restarted = await createSourceSettingsStore(f.path, () => {}); assert.equal((await restarted.current()).revision, saved.revision);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  const reloaded = await f.call({ action: "inspect", sourceUrn: f.urn }); assert.equal(reloaded.enabled, true); assert.equal(reloaded.selectedDatasetUrns.length, 91);
  assert(!JSON.stringify({ list, preview, saved }).includes("FIXTURE_SECRET_NAME"));
  assert(f.calls.every((c) => !c.body.query || c.body.query.startsWith("query")), "no native mutation");
  await assert.rejects(f.call({ ...request, action: "save", planDigest: preview.planDigest }), /version_conflict/);
});

test("disabled/ordinary/forged admin cannot read source configuration or save", async (t) => {
  const f = await fixture(t), original = await readFile(f.path);
  f.setPrivileges(false); await assert.rejects(f.call({ action: "list" }), /admin_required/);
  f.setPrivileges(true); await assert.rejects(f.call({ action: "list" }, { ...f.context, actor: { ...f.actor, urn: "urn:li:corpuser:forged" } }), /admin_required/);
  for (const key of ["actor", "recipe", "publicationApproved", "semanticAutoManagement", "endpoint"])
    await assert.rejects(f.call({ action: "list", [key]: "forged" }), /invalid_request/);
  assert.deepEqual(await readFile(f.path), original);
  await writeFile(f.path, JSON.stringify({ ...f.initial, sourceSettingsEnabled: false }));
  await assert.rejects(createSourceSettingsStore(f.path, () => {}), /not_enabled/);
});

test("version/plan conflicts and membership revocation prevent any save", async (t) => {
  const f = await fixture(t), request = await input(f), preview = await f.call(request), original = await readFile(f.path);
  await assert.rejects(f.call({ ...request, action: "save", planDigest: "f".repeat(64) }), /plan_changed/);
  f.setVersion("6"); await assert.rejects(f.call({ ...request, action: "save", planDigest: preview.planDigest }), /version_conflict/); f.setVersion("5");
  f.denied.add(f.datasets[0]); await assert.rejects(f.call({ ...request, action: "save", planDigest: preview.planDigest }), /scope_not_authorized/); f.denied.clear();
  f.foreign.add(f.datasets[0]); await assert.rejects(f.call({ ...request, action: "save", planDigest: preview.planDigest }), /scope_not_authorized/); f.foreign.clear();
  f.removed.add(f.datasets[0]); await assert.rejects(f.call({ ...request, action: "save", planDigest: preview.planDigest }), /scope_not_authorized/);
  assert.deepEqual(await readFile(f.path), original);
});

test("external operator changes and concurrent stale revisions preserve unrelated configuration", async (t) => {
  const f = await fixture(t), request = await input(f), preview = await f.call(request);
  const changed = JSON.stringify({ ...f.initial, unchanged: { external: true } }); await writeFile(f.path, changed);
  await assert.rejects(f.call({ ...request, action: "save", planDigest: preview.planDigest }), /configuration_changed/);
  assert.equal(await readFile(f.path, "utf8"), changed);
});

test("save lock rechecks admin revocation and leaves no new config/temp file", async (t) => {
  const f = await fixture(t), original = await readFile(f.path), state = await f.store.current();
  await assert.rejects(f.store.save(state.revision, f.actor.key, f.protectedPolicy, async () => { throw Error("native revoked"); }), /native revoked/);
  assert.deepEqual(await readFile(f.path), original);
  const { readdir } = await import("node:fs/promises"); assert.deepEqual(await readdir(f.dir), ["operator.json"]);
});

test("source UI entry can be disabled without adding AUTO or disturbing prior Dataset metadata", async (t) => {
  const f = await fixture(t), first = await input(f), p = await f.call(first);
  await f.call({ ...first, action: "save", planDigest: p.planDigest });
  const second = await input(f, false), p2 = await f.call(second);
  const saved = await f.call({ ...second, action: "save", planDigest: p2.planDigest }); assert.equal(saved.enabled, false);
  assert.equal(saved.selectedDatasetUrns.length, 91); assert.equal((await f.call({ action: "list" })).sources[0].enabled, false);
});

test("metadata-only grants cannot list, run, test or cancel ingestion, but preserve legacy explicit operator grants", async (t) => {
  const f = await fixture(t), request = await input(f), preview = await f.call(request);
  await f.call({ ...request, action: "save", planDigest: preview.planDigest });
  const sources = f.applied.get(f.actor.key);
  const fetchImpl = async () => new Response(JSON.stringify({ data: { me: { corpUser: { urn: f.actor.urn }, platformPrivileges: { manageIngestion: true } } } }));
  const context = { ...f.context, frontendOrigin: "http://fixture.invalid", fetchImpl, sources };
  const list = await nativeIngestion(JSON.stringify({ action: "list_sources", requestId: "33333333-3333-4333-8333-333333333333" }), context);
  assert.deepEqual(list.sources.map((s) => s.urn), [f.protectedUrn]);
  for (const action of ["run", "test_connection", "cancel", "inspect_source"])
    await assert.rejects(nativeIngestion(JSON.stringify({ action, sourceUrn: f.urn, requestId: "33333333-3333-4333-8333-333333333333" }), context), /source_not_approved/);
});

test("large exact read scopes are bounded and independent of unchanged AUTO target capacity", async () => {
  assert.equal(sourceDatasetLimit, 1024);
  const f = await sourceSettingsFixture(1025);
  try { await assert.rejects(f.call({ action: "inspect", sourceUrn: f.urn }), /inventory_incomplete/); }
  finally { await rm(f.dir, { recursive: true, force: true }); }
  const bad = { urn: "urn:li:dataHubIngestionSource:11111111-1111-4111-8111-111111111111", cliVersion: "1.7.0.9", recipeSha256: "a".repeat(64), taskDatasets: Array.from({ length: 1025 }, (_, i) => `urn:li:dataset:fixture${i}`) };
  assert.throws(() => ingestionPolicies({ ["a".repeat(48)]: [bad] }), /invalid_ingestion_policy/);
});

test("saved UI policy reaches the real semantic Catalog reader across five pages without granting publication", async (t) => {
  const f = await fixture(t), request = await input(f), plan = await f.call(request);
  await f.call({ ...request, action: "save", planDigest: plan.planDigest });
  const context = { ...f.context, frontendOrigin: "http://fixture.invalid", fetchImpl: f.fetchImpl, sources: f.applied.get(f.actor.key) };
  const seen = [];
  let offset = 0;
  do {
    const result = await nativeSemanticCatalog({ contract: "catalog/1", action: "list_assets", requestId: "33333333-3333-4333-8333-333333333333", sourceUrn: f.urn, offset }, context);
    assert.equal(result.publicationAuthorized, false);
    seen.push(...result.assets.map((asset) => asset.urn));
    offset = result.nextOffset;
  } while (offset !== null);
  assert.deepEqual([...seen].sort(), [...f.datasets].sort());
  const inspect = await nativeSemanticCatalog({ contract: "catalog/1", action: "inspect_asset", requestId: "22222222-2222-4222-8222-222222222222", sourceUrn: f.urn, assetUrn: f.datasets[0] }, context);
  const preview = await nativeSemanticCatalog({ contract: "catalog/1", action: "preview", requestId: "22222222-2222-4222-8222-222222222222", sourceUrn: f.urn, assetUrn: f.datasets[0], snapshotDigest: inspect.snapshotDigest,
    candidates: [{ kind: "description", operation: "set", fieldPath: "id", value: "Synthetic field label, not business meaning", reason: "Fixture preview only", evidenceIds: ["field:0:path"] }] }, context);
  assert.equal(preview.publicationAuthorized, false); assert.equal(preview.changes.length, 1);
  assert.equal(preview.changes[0].requiresHumanReview, true); assert.equal(preview.changes[0].businessMeaningVerified, false);
  await assert.rejects(nativeSemanticCatalog({ contract: "catalog/1", action: "inspect_asset", requestId: "22222222-2222-4222-8222-222222222222", sourceUrn: f.urn, assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,adventureworks2019.production.outside,PROD)" }, context), /outside_scope/);
  f.denied.add(f.datasets[0]);
  const revoked = await nativeSemanticCatalog({ contract: "catalog/1", action: "list_assets", requestId: "33333333-3333-4333-8333-333333333333", sourceUrn: f.urn, offset: 0 }, context);
  assert.equal(revoked.assets.some((asset) => asset.urn === f.datasets[0]), false);
  assert.equal(revoked.hiddenResultsOmitted, true);
});

test("concurrent saves admit once and reject a stale competing intent without clobbering another actor", async (t) => {
  const f = await fixture(t), request = await input(f), plan = await f.call(request);
  const results = await Promise.allSettled([f.call({ ...request, action: "save", planDigest: plan.planDigest }), f.call({ ...request, action: "save", planDigest: plan.planDigest })]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected"); assert.match(rejected.reason.message, /busy|version_conflict/);
  assert.deepEqual(JSON.parse(await readFile(f.path)).ingestionSourcesByActor["b".repeat(48)], f.initial.ingestionSourcesByActor["b".repeat(48)]);
});

test("in-flight semantic reads stop after source grant revocation, but unrelated additions don't invalidate existing grants", async (t) => {
  const f = await fixture(t), request = await input(f), plan = await f.call(request);
  await f.call({ ...request, action: "save", planDigest: plan.planDigest });
  const policies = f.applied, captured = sourcePolicyContext(f.context, policies);
  assert.doesNotThrow(() => captured.assertActive());
  policies.set("b".repeat(48), []); assert.doesNotThrow(() => captured.assertActive());
  const original = policies.get(f.actor.key);
  policies.set(f.actor.key, [...original, { ...original[0], urn: "urn:li:dataHubIngestionSource:44444444-4444-4444-8444-444444444444" }]);
  assert.doesNotThrow(() => captured.assertActive());
  policies.set(f.actor.key, original);
  let revokedDuringAwait = false;
  const fetchImpl = async (url, options) => {
    const response = await f.fetchImpl(url, options);
    if (String(url).includes("/datahubingestionsource/") && !revokedDuringAwait) {
      revokedDuringAwait = true;
      policies.set(f.actor.key, original.map((s) => s.urn === f.urn ? { ...s, semanticModelContextApproved: false } : s));
    }
    return response;
  };
  await assert.rejects(nativeSemanticCatalog({ contract: "catalog/1", action: "list_assets", requestId: "33333333-3333-4333-8333-333333333333", sourceUrn: f.urn, offset: 0 }, { ...captured, frontendOrigin: "http://fixture.invalid", fetchImpl }), /access_changed|catalog_unavailable/);
  assert.equal(revokedDuringAwait, true);
});

test("UI review grant repairs the Catalog publication boundary, with independent definition rights and no AUTO", async (t) => {
  const f = await fixture(t), request = await input(f);
  const context = () => ({ ...f.context, frontendOrigin: "http://fixture.invalid", fetchImpl: f.fetchImpl, sources: f.applied.get(f.actor.key) });
  let plan = await f.call(request);
  await f.call({ ...request, action: "save", planDigest: plan.planDigest });
  const inspect = await nativeSemanticCatalog({ contract: "catalog/1", action: "inspect_asset", requestId: "22222222-2222-4222-8222-222222222222", sourceUrn: f.urn, assetUrn: f.datasets[0] }, context());
  const candidate = { contract: "catalog/1", action: "preview", requestId: "22222222-2222-4222-8222-222222222222", sourceUrn: f.urn, assetUrn: f.datasets[0], snapshotDigest: inspect.snapshotDigest,
    candidates: [{ kind: "description", operation: "set", fieldPath: "id", value: "Fixture field label", reason: "Fixture only", evidenceIds: ["field:0:path"] }] };
  await assert.rejects(compileSemanticPublication(candidate, context()), /semantic_publication_not_authorized/);
  const publication = { review: true, createDefinitions: false, updateDefinitions: false, agentUrn: f.agentUrn };
  let next = { ...await input(f), publication };
  plan = await f.call(next); assert.equal(plan.before.publication.review, false); assert.equal(plan.after.publication.review, true);
  assert.equal(plan.autoPublicationEnabled, false);
  await f.call({ ...next, action: "save", planDigest: plan.planDigest });
  await assert.rejects(compileSemanticPublication(candidate, context()), /semantic_snapshot_conflict/);
  candidate.snapshotDigest = (await nativeSemanticCatalog({ contract: candidate.contract, action: "inspect_asset", requestId: candidate.requestId, sourceUrn: f.urn, assetUrn: f.datasets[0] }, context())).snapshotDigest;
  const compiled = await compileSemanticPublication(candidate, context());
  assert.equal(compiled.purpose, "SEMANTIC"); assert(compiled.changes.some((change) => change.aspect === "editableSchemaMetadata"));
  const snapshot = await f.call({ action: "inspect", sourceUrn: f.urn }); assert.equal(snapshot.editable, true); assert.deepEqual(snapshot.publication, publication);
  await assert.rejects(f.call({ ...await input(f), publication: undefined }), /confirmation_required/);
  next = { ...await input(f), publication: { ...publication, createDefinitions: true } }; plan = await f.call(next);
  await assert.rejects(f.call({ ...next, publication: { ...publication, createDefinitions: true, updateDefinitions: true }, action: "save", planDigest: plan.planDigest }), /plan_changed/);
  await f.call({ ...next, action: "save", planDigest: plan.planDigest });
  let policy = f.applied.get(f.actor.key).find((p) => p.urn === f.urn);
  assert.equal(policy.semanticDefinitionCreationApproved, true); assert.equal(policy.semanticDefinitionUpdatesApproved, false);
  next = { ...await input(f), publication: { ...publication, updateDefinitions: true } }; plan = await f.call(next);
  await f.call({ ...next, action: "save", planDigest: plan.planDigest });
  policy = f.applied.get(f.actor.key).find((p) => p.urn === f.urn);
  assert.equal(policy.semanticDefinitionCreationApproved, false); assert.equal(policy.semanticDefinitionUpdatesApproved, true);
  assert.equal(policy.semanticAutoManagement, undefined); assert.equal(policy.ingestionExecutionApproved, false);
  const captured = sourcePolicyContext(f.context, f.applied);
  next = { ...await input(f), publication: { ...publication, review: false } }; plan = await f.call(next);
  await f.call({ ...next, action: "save", planDigest: plan.planDigest });
  candidate.snapshotDigest = (await nativeSemanticCatalog({ contract: candidate.contract, action: "inspect_asset", requestId: candidate.requestId, sourceUrn: f.urn, assetUrn: f.datasets[0] }, context())).snapshotDigest;
  await assert.rejects(compileSemanticPublication(candidate, context()), /semantic_publication_not_authorized/);
  assert.throws(() => captured.assertActive(), /access_changed/);
  assert.deepEqual(JSON.parse(await readFile(f.path)).ingestionSourcesByActor["b".repeat(48)], f.initial.ingestionSourcesByActor["b".repeat(48)]);
});

test("UI cannot invent Agent identity, definition dependency, AUTO or override deployment policies", async (t) => {
  const f = await fixture(t), request = await input(f), original = await readFile(f.path);
  const publication = { review: true, createDefinitions: true, updateDefinitions: true, agentUrn: f.agentUrn };
  for (const agentUrn of [null, "urn:li:aiAgent:browser-forged"])
    await assert.rejects(f.call({ ...request, publication: { ...publication, agentUrn } }), /agent_not_configured/);
  for (const bad of [{ ...publication, review: false }, { ...publication, extra: true }, { ...publication, review: "true" }])
    await assert.rejects(f.call({ ...request, publication: bad }), /publication_invalid/);
  await assert.rejects(f.call({ ...request, enabled: false, publication }), /publication_invalid/);
  await assert.rejects(f.call({ ...request, semanticAutoManagement: {} }), /invalid_request/);
  await assert.rejects(f.call({ ...request, sourceUrn: f.protectedUrn }), /deployment_managed/);
  assert.deepEqual(await readFile(f.path), original);
  assert.throws(() => ingestionPolicies({ [f.actor.key]: [{ ...f.protectedPolicy, sourceSettingsManaged: true }] }), /invalid_ingestion_policy/);
});

test("protected configuration rejects world-readable file and symlink", async (t) => {
  const f = await fixture(t); await chmod(f.path, 0o644);
  await assert.rejects(createSourceSettingsStore(f.path, () => {}), /not_protected/);
  await chmod(f.path, 0o600); const link = `${f.path}.link`; await symlink(f.path, link);
  await assert.rejects(createSourceSettingsStore(link, () => {}));
});
