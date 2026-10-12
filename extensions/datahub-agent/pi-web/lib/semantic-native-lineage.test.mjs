import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

test("pinned SDK transports explicit lineage mode in the original session, without consent or automatic continuation", async () => {
  const { default: register } = await createJiti(import.meta.url).import("./datahub-semantic-extension.ts");
  let tool;
  const handlers = {}, calls = [];
  register({ on(name, handler) { handlers[name] = handler; }, registerTool(value) { tool = value; }, appendEntry() {},
    sendMessage() { throw Error("read/prepare must not arm a new foreground continuation"); } });
  assert.equal(tool.parameters.properties.evidenceMode.const, "native_field_lineage/1");
  const ctx = { mode: "rpc", sessionManager: { getSessionId: () => "original-session" }, abort() {}, ui: {
    notify() {}, async input(_title, raw) {
      const request = JSON.parse(raw); calls.push(request);
      assert.equal(request.evidenceMode, "native_field_lineage/1");
      assert.equal(request.snapshotDigest, "a".repeat(64));
      return JSON.stringify({ action: request.action, requestId: request.requestId, publicationAuthorized: false,
        format: request.action === "inspect_asset" ? "datahub-semantic.preview/1" : "datahub-semantic.maintenance/1",
        ...(request.action === "inspect_asset" ? { assetUrn: request.assetUrn, evidenceMode: request.evidenceMode,
          snapshotDigest: request.snapshotDigest, offset: 0, nextOffset: null } : {}),
        state: "DRAFT", readOnly: false, totalItems: 1 });
    },
  } };
  for (const action of ["inspect_asset", "prepare_maintenance"]) {
    await tool.execute("fixture", { action, contract: "catalog/1", sourceUrn: "source", assetUrn: "asset",
      maintenanceRunUrn: action === "prepare_maintenance" ? "root" : undefined,
      evidenceMode: "native_field_lineage/1", snapshotDigest: "a".repeat(64) }, undefined, undefined, ctx);
  }
  assert.equal(calls[0].sessionId, undefined);
  assert.equal(calls[1].sessionId, "original-session");
  await handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
  assert.equal(calls.length, 2);
});
