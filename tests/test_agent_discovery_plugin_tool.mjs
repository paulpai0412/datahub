/** RPC framing / browser bridge unit regressions, NOT model or live acceptance.
 * Real metadata and rendering are checked separately with captured Host outputs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import extension from "../extensions/datahub-agent/pi-web/lib/datahub-etl-extension.ts";
import { installDiscoveryBridge } from "../extensions/datahub-agent/mfe/discovery.js";

function registered() {
  let tool;
  extension({ on() {}, registerTool(value) { tool = value; } });
  return tool;
}

for (const [name, params, format] of [
  ["list plugins", { action: "list_plugins" }, "dataflow-discovery.plugins/1"],
  ["new plugin", { action: "analyze_workspace", sourceId: "approved", selection: "api.json", pluginId: "openapi-operations", pluginConfig: { serviceId: "orders" } }, "dataflow-discovery.plugin-preview/1"],
  ["default legacy", { action: "analyze_workspace", sourceId: "approved", selection: "job.py" }, "datahub-etl.preview/3"],
  ["explicit legacy", { action: "analyze_workspace", sourceId: "approved", selection: "job.py", pluginId: "legacy-static", pluginConfig: {} }, "datahub-etl.preview/3"],
]) test(`datahub_etl preserves native RPC intent: ${name}`, async () => {
  const tool = registered();
  const value = await tool.execute("call", params, undefined, undefined, { mode: "rpc", ui: {
    async input(title, placeholder) {
      assert.equal(title, "DataHub discovery request");
      const { requestId, ...request } = JSON.parse(placeholder);
      assert.match(requestId, /^[a-f0-9-]{36}$/);
      assert.deepEqual(request, params);
      return JSON.stringify({ requestId, format, publicationAuthorized: false });
    },
  } });
  assert.equal(value.details.format, format);
  assert.equal(value.details.publicationAuthorized, false);
});

test("new plugin cannot silently receive an old preview or request import", async () => {
  const tool = registered();
  const params = { action: "analyze_workspace", sourceId: "approved", selection: "api.json", pluginId: "openapi-operations", pluginConfig: { serviceId: "orders" } };
  const ctx = { mode: "rpc", ui: { async input(_title, text) {
    return JSON.stringify({ requestId: JSON.parse(text).requestId, format: "datahub-etl.preview/3", publicationAuthorized: false });
  } } };
  await assert.rejects(tool.execute("call", params, undefined, undefined, ctx), /invalid_etl_host_response/);
  await assert.rejects(tool.execute("call", { ...params, action: "import_workspace" }, undefined, undefined, ctx), /source-only previews/);
});

test("existing MFE Discovery channel admits listing and preserves plugin selection", async () => {
  const original = globalThis.window;
  let listener;
  globalThis.window = { addEventListener(_name, handler) { listener = handler; }, removeEventListener() {} };
  const frame = { contentWindow: {} };
  const sent = [], replies = [];
  const dispose = installDiscoveryBridge({ frame, origin: "https://isolated.example", async send(request) { sent.push(request); return { publicationAuthorized: false }; } });
  try {
    for (const request of [{ action: "list_plugins" }, { action: "analyze_workspace", pluginId: "openapi-operations", pluginConfig: { serviceId: "orders" }, sourceId: "approved", selection: "api.json" },
      // Relay framing only: full capsule authorization is checked by the Host.
      { action: "plugin_development_verify", candidate: { files: { "plugin.py": "# source\n".repeat(2000) } } }]) {
      await listener({ source: frame.contentWindow, origin: "https://isolated.example", data: { type: "datahub-discovery", body: JSON.stringify(request) }, ports: [{ postMessage(value) { replies.push(JSON.parse(value)); }, close() {} }] });
      assert.deepEqual(sent.at(-1), request);
      assert.equal(replies.at(-1).publicationAuthorized, false);
    }
  } finally { dispose(); globalThis.window = original; }
});
