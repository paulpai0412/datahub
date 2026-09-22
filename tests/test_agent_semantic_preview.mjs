import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { semanticFixture, semanticCheckpointFixture, datasetUrn } from "./fixtures/semantic-fixture.mjs";

const require = createRequire(new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url));
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const exports = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../extensions/datahub-agent/pi-web/components/DataHubSemanticPreview.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require, TextEncoder });
const { isSemanticPreview, DataHubSemanticPreview } = exports;

test("real React component renders Host inventory and restored tool detail, with honest paging", async () => {
  const f = semanticFixture();
  f.state.dataset.schemaMetadata.value.fields = Array.from({ length: 22 }, (_, i) => ({ fieldPath: `field_${i}` }));
  const result = await f.run();
  assert.equal(isSemanticPreview(result), true);
  const restored = JSON.parse(JSON.stringify(result));
  assert.equal(isSemanticPreview(restored), true);
  const html = renderToStaticMarkup(React.createElement(DataHubSemanticPreview, { preview: restored }));
  assert.match(html, /尚未核准／發布/);
  assert.match(html, /還有下一頁/);
  assert.match(html, /非完整 ingestion 清單/);
  assert.match(html, /scope="col"/);
  assert.match(html, /Human maintained fixture definition/);
});

test("checkpoint scope card is restricted to the named Run and cannot be forged by setting complete=true", async () => {
  const result = await semanticCheckpointFixture().run();
  assert.equal(isSemanticPreview(result), true);
  const html = renderToStaticMarkup(React.createElement(DataHubSemanticPreview, { preview: result }));
  assert.match(html, /僅指該次成功 Run/); assert.match(html, /Checkpoint 時間/);
  assert.match(html, /尚未核准／發布/); assert.doesNotMatch(html, /<button/);
  for (const change of [{ inventory: undefined }, { inventory: { ...result.scope.inventory, digest: "bad" } },
    { inventory: { ...result.scope.inventory, datasetCount: 9 } }, { ingestionMembershipVerified: false },
    { inventory: { ...result.scope.inventory, timestampMillis: 9000000000000000 } }]) {
    assert.equal(isSemanticPreview({ ...result, scope: { ...result.scope, ...change } }), false);
  }
});

test("preview retains protected before/after and renders external markup only as text", async () => {
  const f = semanticFixture();
  f.state.dataset.datasetProperties.value.description = '<img src="x" onerror="window.exploited=true">';
  const snapshot = await f.run();
  const preview = await f.run({ action: "preview", snapshotDigest: snapshot.snapshotDigest, candidates: [{ kind: "description", value: "<script>window.exploited=true</script>", reason: "Fixture only", evidenceIds: ["dataset:source-description"] }] });
  assert.equal(isSemanticPreview(preview), true);
  const html = renderToStaticMarkup(React.createElement(DataHubSemanticPreview, { preview }));
  assert.match(html, /不會自動覆寫/);
  assert.match(html, /Human maintained fixture definition/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|<img|<button/);
});

test("malformed, forged-publication, unscoped and inconsistent pages do not receive a preview card", async () => {
  const result = await semanticFixture().run();
  for (const change of [
    { publicationAuthorized: true }, { scope: { ...result.scope, completeSourceInventory: true } },
    { scope: { ...result.scope, datasetUrns: [] } }, { fields: [{ fieldPath: "x" }] },
    { nextOffset: 300 }, { totalFields: 0 }, { source: { name: {} } },
    { snapshotDigest: "wrong" }, { note: "x".repeat(48000) },
  ]) assert.equal(isSemanticPreview({ ...result, ...change }), false);
  assert.equal(isSemanticPreview(null), false);
  assert.equal(isSemanticPreview({ ...result, action: "preview", changes: [{ kind: "description" }] }), false);
});

test("definition card keeps creation and shared impact unapproved, escapes native/model text and rejects malformed restores", async () => {
  const f = semanticFixture();
  const snapshot = await f.run();
  const preview = await f.run({ action: "preview_definition", snapshotDigest: snapshot.snapshotDigest,
    definition: { kind: "tag", name: "Reviewed", description: '<img src=x onerror="window.exploited=true">' },
    reason: "Fixture only", evidenceIds: ["dataset:source-description"] });
  assert.equal(isSemanticPreview(JSON.parse(JSON.stringify(preview))), true);
  const html = renderToStaticMarkup(React.createElement(DataHubSemanticPreview, { preview }));
  assert.match(html, /新定義提案/);
  assert.match(html, /找到同名詞彙/);
  assert.match(html, /尚未驗證可建立/);
  assert.match(html, /未完成共用定義影響分析/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|<button/);
  for (const change of [
    { operation: "APPROVED" }, { businessMeaningVerified: true }, { existingDefinitionsMayNotBeUpdated: false },
    { value: "wrong" }, { evidence: [] }, { blockers: [null] },
    { duplicateCheck: { ...preview.definition.duplicateCheck, duplicateAbsenceVerified: true } },
    { duplicateCheck: { ...preview.definition.duplicateCheck, definitions: [{}] } },
  ]) assert.equal(isSemanticPreview({ ...preview, definition: { ...preview.definition, ...change } }), false);
  assert.equal(isSemanticPreview({ ...preview, membership: { ...preview.membership, datasetUrn: "other" } }), false);
});

test("field property inspection and shared impact cards keep native observations bounded and unapproved", async () => {
  const f = semanticFixture();
  const field = await f.run({ fieldPath: "order_id" });
  assert.equal(isSemanticPreview(field), true);
  const fieldHtml = renderToStaticMarkup(React.createElement(DataHubSemanticPreview, { preview: field }));
  assert.match(fieldHtml, /選定欄位屬性：order_id/);
  assert.match(fieldHtml, /身分尚未確認/);
  assert.equal(isSemanticPreview({ ...field, selectedField: { properties: "bad" } }), false);
  f.state.impactRows = [datasetUrn, "urn:li:dataset:PRIVATE"].map((urn) => ({ type: "TaggedWith", direction: "INCOMING", entity: { urn } }));
  const impact = await f.run({ action: "inspect_impact", kind: "tag", referenceUrn: "urn:li:tag:Existing" });
  assert.equal(isSemanticPreview(impact), true);
  const html = renderToStaticMarkup(React.createElement(DataHubSemanticPreview, { preview: impact }));
  assert.match(html, /共用定義影響/);
  assert.match(html, /不是全域修改授權/);
  assert.match(html, /未揭露其識別/);
  assert.doesNotMatch(html, /PRIVATE|<button/);
  for (const change of [{ sharedDefinitionUpdateAuthorized: true }, { sharedDefinitionImpactVerified: true }, { references: [{}] }]) {
    assert.equal(isSemanticPreview({ ...impact, impact: { ...impact.impact, ...change } }), false);
  }
});
