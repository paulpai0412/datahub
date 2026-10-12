import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { installSemanticBridge } from "../extensions/datahub-agent/mfe/semantic.js";

const base = { maintenanceRunUrn: "urn:li:dataProcessInstance:fixture-only", rect: { left: 20, top: 80, width: 500, height: 600 }, visible: true };
for (const [name, input] of [
  ["selection", { ...base, selection: "AA==" }],
  ["approval", { ...base, approved: true }],
  ["publication action", { ...base, action: "approve_maintenance" }],
  ["HTML payload", { ...base, html: "<input checked>" }],
  ["zero geometry", { ...base, rect: { ...base.rect, width: 0 } }],
  ["non-finite geometry", { ...base, rect: { ...base.rect, height: null } }],
  ["out-of-bounds geometry", { ...base, rect: { ...base.rect, top: 20001 } }],
  ["missing visibility", { maintenanceRunUrn: base.maintenanceRunUrn, rect: base.rect }],
]) test(`workspace presentation rejects iframe ${name}; no Host request or consent`, async t => {
  const old = globalThis.window; globalThis.window = new EventTarget();
  const frame = { contentWindow: {} }, origin = "http://fixture.invalid";
  let calls = 0;
  const stop = installSemanticBridge({ frame, origin, container: {}, send: async () => { calls++; throw Error("must_not_dispatch"); } });
  const channel = new MessageChannel();
  t.after(() => { stop(); channel.port1.close(); channel.port2.close(); globalThis.window = old; });
  const received = once(channel.port1, "message");
  window.dispatchEvent(Object.assign(new Event("message"), { source: frame.contentWindow, origin,
    data: { type: "datahub-semantic-maintenance-portal", body: JSON.stringify(input) }, ports: [channel.port2] }));
  assert.equal(JSON.parse((await received)[0]).error, "semantic_request_failed");
  assert.equal(calls, 0);
});
