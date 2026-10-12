// Real pinned SDK registry lifecycle; isolated HOME resources, no prompt or network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
const { sdkToolsForSelection } = await createJiti(import.meta.url, {
  tsconfigPaths: true,
}).import("./rpc-manager.ts");

test("semantic tool transports definition-link intents and accepts KEEP cycle results without weakening identity checks", async () => {
  const { default: register } = await createJiti(import.meta.url).import("./datahub-semantic-extension.ts");
  let tool;
  register({ on() {}, appendEntry() {}, registerTool(value) { tool = value; } });
  const calls = [];
  let invalid = false;
  const ctx = { mode: "rpc", abort() {}, sessionManager: { getSessionId: () => "fixture-session" }, ui: {
    notify() {},
    async input(_title, raw) {
      const body = JSON.parse(raw);
      calls.push(body);
      return JSON.stringify({ format: "datahub-semantic.managed-cycle/1", publicationAuthorized: false,
        action: body.action, requestId: invalid ? "another-request" : body.requestId });
    },
  } };
  for (const action of ["link_managed_definition", "prepare_managed"]) {
    const result = await tool.execute("fixture", { action, cycleRunUrn: "parent", cycleTaskUrn: "task",
      ...(action === "link_managed_definition" ? { runUrn: "child", decisionId: "definition-decision" } : {}) }, undefined, undefined, ctx);
    assert.equal(result.details.format, "datahub-semantic.managed-cycle/1");
    assert.equal(calls.at(-1).sessionId, "fixture-session");
  }
  invalid = true;
  const rejected = await tool.execute("fixture", { action: "prepare_managed" }, undefined, undefined, ctx);
  assert.equal(rejected.details.error, "invalid_semantic_host_response");
  assert.equal(rejected.details.retryAllowed, false);
  assert.equal(rejected.details.requestId, calls.at(-1).requestId);
});

test("explicit definition item selection requires model-supplied Root proof before intent; SDK never substitutes a URI", async () => {
  const { default: register } = await createJiti(import.meta.url).import("./datahub-semantic-extension.ts");
  let tool; const calls = [], entries = [];
  register({ on() {}, appendEntry(...args) { entries.push(args); }, registerTool(t) { tool = t; } });
  const ref = { definitionItemId: "00000000-0000-4000-8000-000000000003" };
  const params = { action: "prepare_maintenance", maintenanceRunUrn: "urn:li:dataProcessInstance:semantic-fixture-root", contract: "catalog/1",
    sourceUrn: "fixture-source", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)", snapshotDigest: "a".repeat(64),
    candidates: [{ kind: "domain", operation: "set", values: ["urn:li:domain:Human", ref], reason: "Explicit selection", evidenceIds: ["asset:identity"] }] };
  const ctx = { mode: "rpc", abort() {}, sessionManager: { getSessionId: () => "fixture-session" }, ui: { notify() {}, async input(_title, raw) {
    const q = JSON.parse(raw); calls.push(q); return JSON.stringify({ format: "datahub-semantic.maintenance/1", action: q.action,
      requestId: q.requestId, maintenanceRunUrn: q.maintenanceRunUrn, publicationAuthorized: false, state: "DRAFT", readOnly: false, runVersion: "255", totalItems: 1 });
  } } };
  await assert.rejects(tool.execute("missing-version", params, undefined, undefined, ctx), /semantic_maintenance_reference_version_required/);
  assert.equal(calls.length, 0); assert.equal(entries.length, 0);
  await tool.execute("explicit-proof", { ...params, version: "253" }, undefined, undefined, ctx);
  assert.equal(calls[0].version, "253"); assert.deepEqual(calls[0].candidates[0].values, ["urn:li:domain:Human", ref]);
});

test("asset-scoped maintenance read preserves explicit proof and whole input without arming authority", async () => {
  const { default: register } = await createJiti(import.meta.url).import("./datahub-semantic-extension.ts");
  let tool;
  const events = {}, entries = [], messages = [], calls = [];
  register({ on(name, handler) { events[name] = handler; }, appendEntry(...args) { entries.push(args); },
    sendMessage(...args) { messages.push(args); }, registerTool(value) { tool = value; } });
  const preparedRequest = { contract: "catalog/1", candidates: [{ kind: "description", value: "Historical proposal, not authority" }] };
  const params = { action: "read_maintenance", maintenanceRunUrn: "urn:li:dataProcessInstance:semantic-fixture-root",
    assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)", version: "251", offset: 1 };
  const ctx = { mode: "rpc", sessionManager: { getSessionId: () => "fixture-session" }, ui: {
    async input(_title, raw) {
      const request = JSON.parse(raw); calls.push(request);
      return JSON.stringify({ format: "datahub-semantic.maintenance/1", action: request.action, requestId: request.requestId,
        publicationAuthorized: false, maintenanceRunUrn: request.maintenanceRunUrn, runVersion: request.version,
        state: "DRAFT", readOnly: false, totalItems: 124, items: [{ id: "fixture-pending", preparedRequest }], nextOffset: null,
        assetView: { assetUrn: request.assetUrn, itemCount: 2, completeInputs: true, semanticCompletenessClaimed: false } });
    },
  } };
  const result = await tool.execute("scoped-read", params, undefined, undefined, ctx);
  assert.deepEqual(result.details.items[0].preparedRequest, preparedRequest);
  assert.deepEqual(Object.fromEntries(Object.entries(calls[0]).filter(([k]) => k !== "requestId")), params);
  await events.agent_end({ messages: [] }, ctx);
  assert.equal(messages.length, 0, "reads cannot arm foreground or choose/write a revision");
  assert.equal(entries.some(([type]) => type === "datahub-semantic.intent/1"), false);
});

test("semantic SDK admits whole-asset candidates but retains both byte caps", async () => {
  const { default: register } = await createJiti(import.meta.url).import("./datahub-semantic-extension.ts");
  let tool;
  register({ on() {}, appendEntry() {}, registerTool(value) { tool = value; } });
  assert.equal(tool.parameters.properties.candidates.maxItems, 1024);
  let calls = 0, oversizedResponse = false;
  const ctx = { mode: "rpc", abort() {}, sessionManager: { getSessionId: () => "fixture-session" }, ui: {
    notify() {},
    async input(_title, raw) {
      calls++;
      const request = JSON.parse(raw);
      assert.equal(request.candidates.length, 25);
      assert.equal(request.responseMode, "receipt");
      return JSON.stringify({ format: "datahub-semantic.review/1", publicationAuthorized: false,
        action: request.action, requestId: request.requestId,
        padding: "x".repeat(oversizedResponse ? 524288 : 48171) });
    },
  } };
  const params = { action: "prepare_managed", candidates: Array.from({ length: 25 }, (_, i) => ({ kind: "description",
    fieldPath: `field_${i}`, operation: "set", value: "Pinned text", reason: "Evidence", evidenceIds: ["id"] })) };
  await tool.execute("fixture", params, undefined, undefined, ctx);
  await assert.rejects(tool.execute("fixture", { ...params, candidates: Array(1024).fill(params.candidates[0]) },
    undefined, undefined, ctx), { message: "semantic_request_too_large" });
  assert.equal(calls, 1, "oversized request never crosses Host UI boundary");
  oversizedResponse = true;
  const oversized = await tool.execute("fixture", params, undefined, undefined, ctx);
  assert.equal(oversized.details.error, "invalid_semantic_host_response");
  assert.equal(oversized.details.retryAllowed, false);
  assert(Buffer.byteLength(JSON.stringify(oversized.details)) < 2048);
});

test("SDK never infers pre-write rejection from a bare format error or missing reconciliation", async () => {
  const { default: register } = await createJiti(import.meta.url).import("./datahub-semantic-extension.ts");
  let tool;
  register({ on() {}, appendEntry() {}, registerTool(value) { tool = value; } });
  let uncertain = false, aborts = 0;
  const ctx = { mode: "rpc", abort() { aborts++; }, sessionManager: { getSessionId: () => "fixture-session" }, ui: {
    notify() {},
    async input() { return JSON.stringify({ error: "invalid_semantic_maintenance_request",
      ...(uncertain ? { reconciliation: { requestId: "unconfirmed", retryAllowed: false } } : {}) }); },
  } };
  const params = { action: "start_maintenance", sourceUrn: "fixture-source", contract: "catalog/1" };
  const bare = await tool.execute("fixture", params, undefined, undefined, ctx);
  assert.equal(bare.details.error, "invalid_semantic_maintenance_request");
  assert.equal(bare.details.correctionAllowed, undefined); assert.equal(bare.details.retryAllowed, false);
  assert.equal(aborts, 1);
  uncertain = true;
  const result = await tool.execute("fixture", params, undefined, undefined, ctx);
  assert.equal(result.details.retryAllowed, false);
  assert.match(result.details.note, /Preparation is unconfirmed/); assert.equal(aborts, 2);
});

test("exact saved-child recovery is session-bound, journaled and never arms foreground continuation", async () => {
  const { default: register } = await createJiti(import.meta.url).import("./datahub-semantic-extension.ts");
  let tool, aborts = 0, calls = 0, lost = false;
  const entries = [], handlers = {};
  register({ on(name, handler) { handlers[name] = handler; }, appendEntry(type, data) { entries.push({ type, data }); },
    registerTool(value) { tool = value; }, sendMessage() { throw Error("recovery must not arm continuation"); } });
  const params = { action: "recover_maintenance", maintenanceRunUrn: "root", itemId: "known-child",
    version: "219", childVersion: "2", planDigest: "a".repeat(64) };
  const ctx = { mode: "rpc", abort() { aborts++; }, sessionManager: { getSessionId: () => "original-session" }, ui: {
    notify() {}, async input(_title, raw) {
      calls++;
      const body = JSON.parse(raw); assert.equal(body.sessionId, "original-session"); assert.equal(body.itemId, "known-child");
      return lost ? undefined : JSON.stringify({ format: "datahub-semantic.maintenance/1", action: body.action,
        requestId: body.requestId, publicationAuthorized: false, state: "DRAFT", readOnly: false, totalItems: 110,
        maintenanceRunUrn: "root", recoveredItemId: "known-child" });
    },
  } };
  const result = await tool.execute("fixture", params, undefined, undefined, ctx);
  assert.equal(result.details.recoveredItemId, params.itemId);
  assert.equal(entries[0].type, "datahub-semantic.intent/1");
  assert.equal(entries[0].data.reconciliation.itemId, params.itemId);
  await handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
  assert.equal(calls, 1); assert.equal(aborts, 0);
  lost = true;
  const unknown = await tool.execute("fixture", params, undefined, undefined, ctx);
  assert.equal(unknown.details.retryAllowed, false); assert.equal(unknown.details.reconciliation.itemId, params.itemId);
  assert.equal(aborts, 1); assert.equal(calls, 2);
});

for (const selected of [
  ["datahub_catalog", "datahub_semantic"],
  ["datahub_catalog", "datahub_sql", "datahub_grafana"],
]) {
  test(`SDK keeps ${selected.join("+")} exact after late registration and explicit activation`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "datahub-sdk-policy-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    let late;
    const tool = (name) => ({
      name,
      label: name,
      description: "unit fixture; never executed",
      parameters: Type.Object({}),
      async execute() {
        throw new Error("test must never execute a tool");
      },
    });
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          (pi) => {
            for (const name of selected) pi.registerTool(tool(name));
            late = () => {
              pi.registerTool(tool("mcp"));
              pi.setActiveTools([...selected, "mcp", "bash"]);
            };
          },
        ],
      },
    });
    const model = services.modelRuntime.getModel("openai", "gpt-4o-mini");
    assert(
      model,
      "pinned SDK catalog fixture exists; no model request is made",
    );
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(root),
      model,
      tools: sdkToolsForSelection(selected),
    });
    t.after(() => session.dispose());
    await session.bindExtensions({ mode: "rpc" });
    session.setActiveToolsByName(selected);
    assert.deepEqual(session.getActiveToolNames().sort(), [...selected].sort());
    late();
    assert.deepEqual(session.getActiveToolNames().sort(), [...selected].sort());
    assert.deepEqual(
      session
        .getAllTools()
        .map((t) => t.name)
        .sort(),
      [...selected].sort(),
    );
    await session.reload();
    late();
    assert.deepEqual(session.getActiveToolNames().sort(), [...selected].sort());
  });
}
