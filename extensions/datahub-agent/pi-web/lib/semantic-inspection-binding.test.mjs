import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const digest = "a".repeat(64), vocabularyDigest = "b".repeat(64), mode = "native_field_lineage/1";

async function fixture() {
  const { default: register } = await createJiti(import.meta.url).import("./datahub-semantic-extension.ts");
  const handlers = {}, requests = []; let tool, drift = false, abortCount = 0;
  register({ on(n, f) { handlers[n] = f; }, registerTool(t) { tool = t; }, appendEntry() {}, sendMessage() { throw Error("no new continuation"); } });
  const ctx = { mode: "rpc", sessionManager: { getSessionId: () => "session" }, abort() { abortCount++; }, ui: { notify() {}, async input(_title, body) {
    const q = JSON.parse(body); requests.push(q);
    if (drift && q.action === "prepare_maintenance") return JSON.stringify({ error: "semantic_snapshot_conflict" });
    return JSON.stringify({ action: q.action, requestId: q.requestId, publicationAuthorized: false,
      format: q.action === "prepare_maintenance" ? "datahub-semantic.maintenance/1" : "datahub-semantic.preview/1",
      state: "DRAFT", readOnly: false, totalItems: 1, assetUrn: q.assetUrn, evidenceMode: q.evidenceMode,
      offset: q.offset ?? 0, nextOffset: q.action === "inspect_asset" && !q.offset ? 20 : null,
      snapshotDigest: q.action === "search_vocabulary" ? vocabularyDigest : digest });
  } } };
  const base = { contract: "catalog/1", sourceUrn: "source", assetUrn: "asset", evidenceMode: mode };
  return { handlers, requests, base, execute: p => tool.execute("fixture", p, undefined, undefined, ctx), setDrift() { drift = true; }, get abortCount() { return abortCount; } };
}

test("proposal may use already observed evidence before all pages; vocabulary cannot replace its bound snapshot", async () => {
  const f = await fixture();
  await f.execute({ ...f.base, action: "inspect_asset" });
  await f.execute({ ...f.base, action: "prepare_maintenance", maintenanceRunUrn: "root" });
  assert.equal(f.requests.at(-1).snapshotDigest, digest);
  assert.equal(f.requests.length, 2);
  await f.execute({ contract: "catalog/1", sourceUrn: "source", assetUrn: "asset", action: "search_vocabulary", kind: "term", query: "Person" });
  await f.execute({ ...f.base, action: "inspect_asset", offset: 20 });
  assert.equal(f.requests.at(-1).snapshotDigest, digest);
  await assert.rejects(f.execute({ ...f.base, action: "prepare_maintenance", maintenanceRunUrn: "root", snapshotDigest: vocabularyDigest }), /semantic_inspection_binding_mismatch/);
  assert.equal(f.requests.length, 4);
  await f.execute({ ...f.base, action: "prepare_maintenance", maintenanceRunUrn: "root" });
  assert.equal(f.requests.at(-1).snapshotDigest, digest);
  assert.equal(f.requests.at(-1).evidenceMode, mode);
  assert.equal(f.requests.at(-1).sessionId, "session");
});

test("implicit binding is exact source, asset, field, mode and current accepted prompt; Host drift is never refreshed or retried", async () => {
  const f = await fixture();
  await f.execute({ ...f.base, action: "inspect_asset" });
  await f.execute({ ...f.base, action: "inspect_asset", offset: 20 });
  for (const changed of [{ sourceUrn: "other" }, { assetUrn: "other" }, { fieldPath: "field" }, { evidenceMode: undefined }])
    await assert.rejects(f.execute({ ...f.base, ...changed, action: "prepare_maintenance", maintenanceRunUrn: "root" }), /semantic_inspection_required/);
  assert.equal(f.requests.length, 2);
  f.setDrift();
  const stopped = await f.execute({ ...f.base, action: "prepare_maintenance", maintenanceRunUrn: "root" });
  assert.equal(stopped.details.error, "semantic_snapshot_conflict");
  assert.equal(stopped.details.retryAllowed, false); assert.equal(stopped.details.correctionAllowed, undefined);
  assert.equal(f.abortCount, 1, "a write failure without exact pre-write evidence stops the same prompt");
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests.at(-1).snapshotDigest, digest);
  await f.handlers.input({ source: "interactive" });
  await assert.rejects(f.execute({ ...f.base, action: "prepare_maintenance", maintenanceRunUrn: "root" }), /semantic_inspection_required/);
  assert.equal(f.requests.length, 3);
});
