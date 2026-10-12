// Actual pinned SDK tool batches; isolated HOME/synthetic model + Host, no network/native effects.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const { default: register } = await createJiti(import.meta.url).import("./datahub-semantic-extension.ts");
const sdkPackage = JSON.parse(await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url)));
const rootUrn = "urn:li:dataProcessInstance:semantic-fixture-root";
const assetUrn = "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)";

for (const resetWhileAwaiting of [false, true]) test(`new input cannot inherit own-ACK proof (reset during reply: ${resetWhileAwaiting})`, async () => {
  let tool, version = "251", release, dispatched, aborts = 0;
  const replyBarrier = new Promise(resolve => { release = resolve; }), dispatchBarrier = new Promise(resolve => { dispatched = resolve; });
  const handlers = {}, requests = [];
  register({ on(n, f) { handlers[n] = f; }, appendEntry() {}, registerTool(t) { tool = t; } });
  const ctx = { mode: "rpc", abort() { aborts++; }, sessionManager: { getSessionId: () => "same-session" }, ui: { notify() {}, async input(_title, raw) {
    const q = JSON.parse(raw); requests.push(q);
    if (q.action === "inspect_asset") return JSON.stringify({ format: "datahub-semantic.preview/1", publicationAuthorized: false,
      action: q.action, requestId: q.requestId, assetUrn, snapshotDigest: "a".repeat(64), offset: 0, nextOffset: null });
    if (q.action === "revise_maintenance") {
      if (q.version !== version) return JSON.stringify({ error: "semantic_maintenance_plan_changed" });
      version = "253";
      if (resetWhileAwaiting) { dispatched(); await replyBarrier; }
    }
    return JSON.stringify({ format: "datahub-semantic.maintenance/1", action: q.action, requestId: q.requestId,
      maintenanceRunUrn: rootUrn, sourceUrn: "fixture-source", publicationAuthorized: false, state: "DRAFT", readOnly: false,
      runVersion: version, totalItems: 2, totalRecordedItems: 3, foregroundPreparation: true });
  } } };
  const mutate = { action: "revise_maintenance", contract: "catalog/1", assetUrn, version: "251", itemId: "00000000-0000-4000-8000-000000000001",
    childVersion: "3", planDigest: "b".repeat(64), candidates: [{ kind: "description", operation: "set", value: "Whole fixture", reason: "Evidence", evidenceIds: ["asset:identity"] }] };
  await tool.execute("bind", { action: "continue_maintenance", maintenanceRunUrn: rootUrn }, undefined, undefined, ctx);
  await tool.execute("inspect", { action: "inspect_asset", contract: "catalog/1", assetUrn }, undefined, undefined, ctx);
  const first = tool.execute("first", mutate, undefined, undefined, ctx);
  if (resetWhileAwaiting) await dispatchBarrier;
  else {
    await first; const before = requests.length;
    await assert.rejects(tool.execute("self-old", mutate, undefined, undefined, ctx), /semantic_maintenance_self_stale_input/);
    assert.equal(requests.length, before);
  }
  await handlers.input({ source: "user" });
  await tool.execute("history", { action: "read_maintenance", maintenanceRunUrn: rootUrn }, undefined, undefined, ctx);
  await tool.execute("new-bind", { action: "continue_maintenance", maintenanceRunUrn: rootUrn }, undefined, undefined, ctx);
  if (resetWhileAwaiting) { release(); await first; }
  await tool.execute("new-inspect", { action: "inspect_asset", contract: "catalog/1", assetUrn }, undefined, undefined, ctx);
  const stopped = await tool.execute("external-old", mutate, undefined, undefined, ctx);
  assert.equal(stopped.details.error, "semantic_maintenance_plan_changed");
  assert.equal(stopped.details.retryAllowed, false); assert.equal(stopped.details.correctionAllowed, undefined);
  assert.equal(aborts, 1);
  assert.equal(requests.at(-1).version, "251", "not filled from history or prior prompt ACK");
  assert.equal(requests.filter(q => q.action === "revise_maintenance").length, 2, "Host is still responsible for non-owned drift");
});

for (const scenario of ["own-ack-correction", "own-ack-item-ref-correction", "external-drift-stop", "read-cannot-certify-own-mutation"]) {
  test(`pinned Root CAS batch: ${scenario}`, async t => {
    assert.equal(sdkPackage.version, "0.85.1");
    const root = await mkdtemp(join(tmpdir(), "semantic-self-stale-")), agentDir = join(root, "agent"); await mkdir(agentDir);
    t.after(() => rm(root, { recursive: true, force: true }));
    const requests = []; let session, version = "251", writes = 0, state = "DRAFT", followups = 0;
    const revision = (item, v) => ({ action: "revise_maintenance", contract: "catalog/1", assetUrn,
      itemId: `00000000-0000-4000-8000-00000000000${item}`, version: v, childVersion: "3", planDigest: "b".repeat(64),
      candidates: [scenario === "own-ack-item-ref-correction"
        ? { kind: "domain", operation: "add", value: { definitionItemId: "00000000-0000-4000-8000-000000000003" }, reason: "Fixture evidence", evidenceIds: ["asset:identity"] }
        : { kind: "description", operation: "set", value: `Whole item ${item}`, reason: "Fixture evidence", evidenceIds: ["asset:identity"] }] });
    const services = await createAgentSessionServices({ cwd: root, agentDir,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [pi => { register(pi); pi.registerProvider("self-stale-fixture", {
          api: "self-stale-fixture-api", apiKey: "offline-only", baseUrl: "http://invalid.invalid",
          models: [{ id: "fixture", name: "Offline", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model, context) {
            const stream = createAssistantMessageEventStream(); queueMicrotask(() => {
              const last = context.messages.at(-1), text = last?.content?.[0]?.text ?? "";
              const value = last?.role === "toolResult" && !last.isError ? JSON.parse(text) : undefined;
              let args;
              if (text.startsWith("同一前景準備尚未完成")) { followups++; args = [{ action: "seal_maintenance", maintenanceRunUrn: rootUrn }]; }
              else if (last?.role === "user") args = [{ action: "continue_maintenance", maintenanceRunUrn: rootUrn }];
              else if (value?.action === "continue_maintenance") args = [{ action: "inspect_asset", contract: "catalog/1", assetUrn }];
              else if (value?.action === "inspect_asset") args = scenario === "read-cannot-certify-own-mutation"
                ? [{ action: "read_maintenance", maintenanceRunUrn: rootUrn }]
                : [revision(1, "251"), revision(2, scenario === "external-drift-stop" ? "253" : "251")];
              else if (last?.isError) {
                assert.match(text, /semantic_maintenance_self_stale_input/);
                args = [{ action: "read_maintenance", maintenanceRunUrn: rootUrn }];
              } else if (value?.action === "read_maintenance") args = [revision(2, scenario === "read-cannot-certify-own-mutation" ? "251" : value.runVersion)];
              const content = args ? args.map((arguments_, i) => ({ type: "toolCall", id: `fixture-${context.messages.length}-${i}`, name: "datahub_semantic", arguments: arguments_ })) : [{ type: "text", text: "Normal model finish." }];
              const m = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
                stopReason: args ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
              stream.push({ type: "start", partial: m }); stream.push({ type: "done", reason: m.stopReason, message: m }); stream.end();
            }); return stream;
          },
        }); }] } });
    const model = services.modelRuntime.getModel("self-stale-fixture", "fixture");
    ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root), model, tools: ["datahub_semantic"] }));
    t.after(() => session.dispose()); session.setActiveToolsByName(["datahub_semantic"]);
    await session.bindExtensions({ mode: "rpc", uiContext: { notify() {}, async input(_title, raw) {
      const q = JSON.parse(raw); requests.push(q);
      if (q.action === "inspect_asset") return JSON.stringify({ format: "datahub-semantic.preview/1", publicationAuthorized: false,
        action: q.action, requestId: q.requestId, assetUrn, snapshotDigest: "a".repeat(64), offset: 0, nextOffset: null });
      if (scenario === "read-cannot-certify-own-mutation" && q.action === "read_maintenance") version = "253";
      if (q.action === "revise_maintenance") {
        if (scenario === "external-drift-stop" && writes === 1) version = "255";
        if (q.version !== version) return JSON.stringify({ error: "semantic_maintenance_plan_changed",
          reconciliation: { requestId: q.requestId, maintenanceRunUrn: rootUrn, retryAllowed: false } });
        assert.equal(q.snapshotDigest, "a".repeat(64)); writes++; version = String(BigInt(version) + 2n);
      }
      if (q.action === "seal_maintenance") state = "READY";
      return JSON.stringify({ format: "datahub-semantic.maintenance/1", publicationAuthorized: false, action: q.action,
        requestId: q.requestId, maintenanceRunUrn: rootUrn, sourceUrn: "fixture-source", state, readOnly: false,
        runVersion: version, totalItems: 2, totalRecordedItems: 2 + writes,
        ...(q.action === "revise_maintenance" ? { preparedItemId: q.requestId, revisedItemId: q.itemId } : {}),
        ...(q.action === "continue_maintenance" ? { foregroundPreparation: true } : {}) });
    } } });
    await session.prompt("Prepare existing plan"); assert(session.isIdle); assert.equal(session.pendingMessageCount, 0);
    const events = session.sessionManager.getEntries().filter(x => x.type === "custom" && x.customType === "datahub-semantic.foreground-lifecycle/1").map(x => x.data);
    if (scenario.startsWith("own-ack")) {
      if (scenario === "own-ack-item-ref-correction") for (const q of requests.filter(q => q.action === "revise_maintenance"))
        assert.deepEqual(q.candidates[0].value, { definitionItemId: "00000000-0000-4000-8000-000000000003" }, "SDK forwards explicit selection, never resolves/guesses a URI");
      assert.equal(state, "READY", JSON.stringify({ writes, followups, requests: requests.slice(0, 12).map(q => ({ action: q.action, version: q.version })), events: events.slice(-8) })); assert.equal(writes, 2); assert.equal(followups, 1);
      assert.deepEqual(requests.filter(q => q.action === "revise_maintenance").map(q => q.version), ["251", "253"]);
      assert.equal(requests.filter(q => q.action === "read_maintenance").length, 1, "model explicitly reads, SDK never refreshes");
      assert(events.some(x => x.phase === "known-input-correction")); assert(!events.some(x => x.phase === "host-error-stop"));
      assert.equal(session.sessionManager.getEntries().filter(x => x.customType === "datahub-semantic.intent/1" && x.data.action === "revise_maintenance").length, 2, "rejected stale input has no intent/dispatch");
    } else {
      assert.equal(state, "DRAFT"); assert.equal(followups, 0);
      assert.equal(writes, scenario === "external-drift-stop" ? 1 : 0);
      assert(events.some(x => x.phase === "host-error-stop" && x.error === "semantic_maintenance_plan_changed"));
      assert(!events.some(x => x.phase === "known-input-correction"));
      assert(!requests.some(q => q.action === "seal_maintenance"));
    }
    assert(!requests.some(q => /approve|publish/.test(q.action)));
  });
}
