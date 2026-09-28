// Real Chromium CHIPS + product gateway/history opener. Synthetic identity and
// exported document: this is not a deployed real-session acceptance receipt.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createAgentGateway } from "../extensions/datahub-agent/integration/gateway.mjs";
import { isValidWebSessionToken } from "../extensions/datahub-agent/pi-web/lib/web-auth.ts";
const require = createRequire(new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url));
const { chromium } = require("playwright");
const { build } = require("esbuild");
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../extensions/datahub-agent/pi-web/lib/session-history.ts", import.meta.url))],
  bundle: true, write: false, platform: "browser", format: "esm",
});
const script = compiled.outputFiles[0].text;
const actor = { tenant: "fixture", urn: "urn:li:corpuser:alice", key: "a".repeat(48) };
const password = "fixture-session-history-password-not-a-credential";
const path = "/api/sessions/00000000-0000-4000-8000-000000000020/export?inline=1";
let exportStatus = 200, exportReads = 0, gatewayOrigin;
const runtime = createServer((request, response) => {
  assert(isValidWebSessionToken(request.headers.cookie?.replace(/^pi_web_session=/, ""), password));
  if (request.url === "/session-history.js") {
    response.writeHead(200, { "content-type": "application/javascript" });
    response.end(script);return;
  }
  if (request.url === path) {
    exportReads++;
    response.writeHead(exportStatus, { "content-type": exportStatus === 200 ? "text/html; charset=utf-8" : "application/json" });
    response.end(exportStatus === 200
      ? '<!doctype html><title>Full tree</title><h1>Private full history</h1><button id="branch">Branch</button><p id="selected"></p><script>document.querySelector("#branch").onclick=()=>document.querySelector("#selected").textContent="Branch selected";</script>'
      : '{"error":"authentication_required"}');return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html><button id="old">Original navigation</button><button id="fixed">Full history</button><script type="module">
    import { openSessionHistory } from '/session-history.js';
    document.querySelector('#old').onclick=()=>window.open('${path}','_blank','noopener,noreferrer');
    document.querySelector('#fixed').onclick=()=>openSessionHistory('00000000-0000-4000-8000-000000000020');
  </script>`);
});
const parent = createServer((_req, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html><iframe title="Agent" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals"></iframe><script>
    (async()=>{const r=await fetch('${gatewayOrigin}/agent/bootstrap',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}'});const grant=await r.json();document.querySelector('iframe').src=grant.launchUrl;})();
  </script>`);
});
let gateway, browser;
try {
  for (const server of [runtime, parent]) { server.listen(0, "127.0.0.1");await once(server, "listening"); }
  gateway = await createAgentGateway({
    gatewayOrigin: "http://localhost:0", datahubOrigin: `http://localhost:${parent.address().port}`,
    mfeDirectory: fileURLToPath(new URL("../extensions/datahub-agent/mfe/dist/", import.meta.url)),
    verifyIdentity: async () => actor,
    runtimeForActor: async () => ({ origin: `http://127.0.0.1:${runtime.address().port}`, password }),
  });
  gateway.listen(0, "127.0.0.1");await once(gateway, "listening");
  gatewayOrigin = `http://localhost:${gateway.address().port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext();
  await context.route("**/*", route => {
    const host = new URL(route.request().url()).hostname;
    return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" ? route.continue() : route.abort();
  });
  const page = await context.newPage();await page.goto(`http://localhost:${parent.address().port}`);
  const frame = page.frameLocator('iframe[title="Agent"]');await frame.getByText("Full history", { exact: true }).waitFor();
  const oldOpened = context.waitForEvent("page");await frame.getByText("Original navigation", { exact: true }).click();
  const old = await oldOpened;await old.waitForLoadState("domcontentloaded");
  assert.equal(await old.locator("body").innerText(), '{"error":"authentication_required"}');
  assert.equal(exportReads, 0, "missing partition cookie must never reach runtime");await old.close();
  const opened = context.waitForEvent("page");await frame.getByText("Full history", { exact: true }).click();
  const view = await opened;await view.getByRole("heading", { name: "Private full history" }).waitFor();
  assert.equal(exportReads, 1);assert.equal(await view.evaluate(() => window.opener), null);
  // document.open inherits the caller URL; CDP's cached page.url can still
  // report about:blank. Check the actual document, not that stale projection.
  const actualUrl = new URL(await view.evaluate(() => location.href));
  assert.equal(actualUrl.origin, `http://${actor.key}.localhost:${gateway.address().port}`);
  assert.equal(actualUrl.pathname, "/");
  assert.equal(actualUrl.search, "", "viewer URL contains no session token or grant");
  await view.getByRole("button", { name: "Branch", exact: true }).click();
  await view.getByText("Branch selected", { exact: true }).waitFor();
  assert.equal(await frame.getByText("Full history", { exact: true }).count(), 1);
  await view.close();
  exportStatus = 401;
  const deniedOpened = context.waitForEvent("page");await frame.getByText("Full history", { exact: true }).click();
  const denied = await deniedOpened;await denied.getByText("Full history: HTTP 401", { exact: true }).waitFor();
  assert.equal(exportReads, 2);assert.equal(await denied.getByRole("heading").count(), 0);await denied.close();
  const fresh = await browser.newContext();
  const anonymous = await fresh.newPage();
  const response = await anonymous.goto(`http://${actor.key}.localhost:${gateway.address().port}${path}`);
  assert.equal(response.status(), 401);assert.equal(exportReads, 2);
  await fresh.close();
  console.log("PASS original CHIPS navigation 401; authenticated export renders interactive tree; opener detached; failures/anonymous remain denied");
} finally {
  await browser?.close();
  for (const server of [gateway, parent, runtime]) if (server) await new Promise(resolve => { server.close(resolve);server.closeAllConnections(); });
}
