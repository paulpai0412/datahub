// Product SDK history projection with actual Host ACL and synthetic API only.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { semanticCatalogFixture } from "./fixtures/semantic-catalog-fixture.mjs";
import { sourceUrn, datasetUrn } from "./fixtures/semantic-fixture.mjs";
const { createJiti } = createRequire(new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url))("jiti");

test("history is paginated, immutable, current-ACL-bound and never resumes or fills missing locators", async () => {
  const f = semanticCatalogFixture(), entries = [], handlers = {}, requests = [];
  const { default: register } = await createJiti(import.meta.url).import("../extensions/datahub-agent/pi-web/lib/datahub-semantic-extension.ts");
  let tool;
  register({ on(n, h) { handlers[n] = h; }, registerTool(t) { tool = t; }, appendEntry(type, data) { assert.equal(type, "datahub-semantic.foreground-lifecycle/1"); assert.equal(data.diagnosticOnly, true); }, sendMessage() { throw Error("read must not continue"); } });
  const ctx = { mode: "rpc", sessionManager: { getSessionId: () => f.sessionId, getBranch: () => entries },
    abort() { throw Error("read is not a write"); }, ui: { notify() {}, async input(_title, body) {
      const input = JSON.parse(body); requests.push(input);
      try { return JSON.stringify(await f.call(input)); }
      catch (error) { return JSON.stringify({ error: error.message }); }
    } } };
  const execute = async q => {
    try { const result = await tool.execute("history-call", q, undefined, undefined, ctx);
      handlers.tool_execution_end({ toolName: "datahub_semantic", toolCallId: "history-call", isError: false }); return result; }
    catch (error) { handlers.tool_execution_end({ toolName: "datahub_semantic", toolCallId: "history-call", isError: true }); throw error; }
  };
  const query = { action: "read_operation_history", contract: "catalog/1", sourceUrn, assetUrn: datasetUrn };
  const before = f.writes.recordWrites;
  const empty = (await execute(query)).details;
  assert.equal(empty.locatorCoverage, "NO_RECORDED_LOCATOR"); assert.equal(empty.totalOperations, 0);
  assert.equal(empty.publicationAuthorized, false);
  for (let i = 0; i < 23; i++) entries.push({ type: "custom", customType: "datahub-semantic.intent/1", id: `record-${i}`, data: {
    sessionId: f.sessionId, sourceUrn, assetUrn: datasetUrn, fieldPath: null, action: "prepare_maintenance", requestId: randomUUID(),
    reconciliation: { maintenanceRunUrn: `urn:li:dataProcessInstance:semantic-${f.context.actor.key}-${randomUUID()}` },
    dispatchIntentOnly: true, retryAllowed: false,
  } });
  // Missing requestId stays missing; original Root is never substituted.
  delete entries[22].data.requestId;
  const saved = structuredClone(entries);
  const first = (await execute(query)).details;
  assert.equal(first.operations.length, 20); assert.equal(first.nextOffset, 20);
  await assert.rejects(execute({ ...query, offset: 20 }), /SAME historyDigest/);
  const last = (await execute({ ...query, offset: 20, historyDigest: first.historyDigest })).details;
  assert.equal(last.operations.length, 3); assert.equal(last.nextOffset, null);
  assert.equal(last.operations[2].operation.requestId, undefined);
  assert.equal(last.operations[2].fieldLocatorRecorded, true);
  assert.deepEqual(entries, saved); assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
  entries.push({ ...entries[0], id: "new-record" });
  await assert.rejects(execute({ ...query, offset: 20, historyDigest: first.historyDigest }), /semantic_operation_history_changed/);
  f.state.denied.add(datasetUrn);
  await assert.rejects(execute(query), /forbidden|authorized|permission/);
  assert.equal(requests.at(-1).action, "inspect_asset", "every page rechecks actual Host visibility");
  assert.equal(requests.at(-1).offset, undefined); assert.equal(requests.at(-1).historyDigest, undefined);
  assert.equal(f.writes.recordWrites, before);
});
