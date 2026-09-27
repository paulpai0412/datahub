// Real local HTTP transport with synthetic identity/handler. No Docker/model.
import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentGateway } from "../extensions/datahub-agent/integration/gateway.mjs";

function post(port, path, data) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port, path, method: "POST", headers: {
      host: `localhost:${port}`, origin: "http://localhost:9002", "content-type": "application/json", cookie: "PLAY_SESSION=synthetic" } }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, data: JSON.parse(text) }));
    });
    outgoing.on("error", reject); outgoing.end(JSON.stringify(data));
  });
}

test("Discovery transports a large source capsule and aborts its Host context on disconnect", { timeout: 10000 }, async t => {
  const root = await mkdtemp("/tmp/discovery-gateway-test-");
  await mkdir(join(root, "_next/static"), { recursive: true });
  await writeFile(join(root, "index.html"), "<p>synthetic shell</p>");
  t.after(() => rm(root, { recursive: true }));
  const reached = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const server = await createAgentGateway({ gatewayOrigin: "http://localhost:0", datahubOrigin: "http://localhost:9002",
    browserAssetsDirectory: root, mfeDirectory: fileURLToPath(new URL("../extensions/datahub-agent/mfe/dist/", import.meta.url)), verifyIdentity: async () => ({ tenant: "fixture", urn: "urn:li:corpuser:test", key: "a".repeat(48) }),
    runtimeForActor: async () => { throw new Error("runtime must not be requested"); },
    async discoveryRequest(text, context) {
      assert(Buffer.byteLength(text) > 16384);
      assert(context.signal instanceof AbortSignal);
      reached.resolve();
      await new Promise(resolve => context.signal.addEventListener("abort", resolve, { once: true }));
      cancelled.resolve();
      return { publicationAuthorized: false };
    } });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  const boot = await post(port, "/agent/bootstrap", {});
  assert.equal(boot.status, 200);
  const client = request({ hostname: "127.0.0.1", port, path: "/agent/discovery", method: "POST", headers: {
    host: `localhost:${port}`, origin: "http://localhost:9002", "content-type": "application/json", cookie: "PLAY_SESSION=synthetic" } });
  client.on("error", () => {});
  client.end(JSON.stringify({ grantId: boot.data.grantId, revokeToken: boot.data.revokeToken,
    request: JSON.stringify({ action: "plugin_development_verify", padding: "x".repeat(20000) }) }));
  await reached.promise;
  client.destroy();
  await cancelled.promise;
});
