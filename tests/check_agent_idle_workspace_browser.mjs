// Candidate public MFE + real BrowserGrants with disposable HTTP identity/iframe.
// No DataHub, provider, credentials, native metadata or deployed MFE is used.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { BrowserGrants } from "../extensions/datahub-agent/integration/browser-grants.mjs";
const { chromium } = createRequire(new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url))("playwright");
const B = resolve(process.argv[2]);
let now = 0, login = true, actor = { tenant: "fixture", urn: "urn:li:corpuser:fixture", key: "a".repeat(48) };
const grants = new BrowserGrants({ clock: () => now }), requests = [], contexts = [];
let bootstrapCount = 0, navigationCount = 0, origin;
const server = createServer(async (req, res) => {
  const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  try {
    const url = new URL(req.url, origin);
    if (req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(url.pathname);
      if (url.pathname === "/agent/bootstrap") {
        bootstrapCount++; if (!login) return json(401, { error: "authentication_required" });
        const g = grants.issue(actor);
        return json(200, { grantId: g.grantId, revokeToken: g.revokeToken,
          launchUrl: `http://${actor.key}.localhost:${server.address().port}/bootstrap#${g.ticket}` });
      }
      if (url.pathname === "/agent/heartbeat") {
        if (!login) { grants.release(body.grantId, body.revokeToken, true); return json(401, { error: "authentication_required" }); }
        grants.renew(body.grantId, actor, body.revokeToken); return json(200, { ok: true });
      }
      if (url.pathname === "/agent/revoke") { grants.release(body.grantId, body.revokeToken); return json(200, { ok: true }); }
      if (url.pathname === "/agent/exchange") {
        const key = req.headers.host.split(".")[0]; const exchanged = grants.exchange(body.ticket, key);
        return json(200, { key: exchanged.actor.key }); // No session material exposed.
      }
      throw Error("unexpected tool/model operation");
    }
    if (url.pathname === "/") {
      navigationCount++; res.writeHead(200, { "content-type": "text/html" });
      return res.end('<!doctype html><meta charset="utf-8"><div id="workspace" style="height:80vh"></div><script src="/mfe/remoteEntry.js"></script><script>datahubAgentMFE.get("./mount").then(f=>window.stopWorkspace=f().mount(document.getElementById("workspace")))</script>');
    }
    if (url.pathname === "/bootstrap") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end('<!doctype html><meta charset="utf-8"><p role="status">Connecting fixture…</p><script>(async()=>{const ticket=location.hash.slice(1);history.replaceState(null,"","/bootstrap");const r=await fetch("/agent/exchange",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticket})});if(!r.ok)throw Error();const v=await r.json();document.querySelector("p").textContent="Fixture workspace ready "+v.key})()</script>');
    }
    if (["/mfe/remoteEntry.js", "/mfe/89.js"].includes(url.pathname)) {
      res.writeHead(200, { "content-type": "application/javascript" }); return res.end(await readFile(resolve(B, "mfe-candidate", url.pathname.split("/").at(-1))));
    }
    res.writeHead(404); res.end();
  } catch { json(401, { error: "authentication_required" }); }
});
let browser;
const result = { status: "NOT_VERIFIED", synthetic: true, deployedEntrypoint: false, modelRequests: 0, nativeWrites: 0, cases: [] };
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); origin = `http://localhost:${server.address().port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  for (const width of [1440, 390]) {
    login = true; actor = { ...actor, key: "a".repeat(48) };
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" }); contexts.push(context);
    const page = await context.newPage(), errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(origin); const frame = () => page.frameLocator('iframe[title="DataHub Agent"]');
    await frame().getByText(`Fixture workspace ready ${actor.key}`, { exact: true }).waitFor();
    const nav = navigationCount, issued = bootstrapCount, oldLaunch = await page.locator('iframe').getAttribute('src');
    now += 90001; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(old => { const f = document.querySelector('iframe[title="DataHub Agent"]'); return f?.src.includes('/bootstrap#') && f.src !== old; }, oldLaunch);
    await frame().getByText(`Fixture workspace ready ${actor.key}`, { exact: true }).waitFor();
    assert.equal(bootstrapCount, issued + 1); assert.equal(navigationCount, nav, "no full page refresh");
    const restored = await page.locator('#workspace').evaluate(e => ({ iframes: e.querySelectorAll('iframe').length, navs: e.querySelectorAll('nav').length }));
    assert.deepEqual(restored, { iframes: 1, navs: 1 }, "no stale bridge registry DOM duplicates");
    await page.screenshot({ path: resolve(B, `browser-recovered-${width}.png`) });
    login = false; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const retry = page.getByRole('button', { name: '重新連線 Agent', exact: true }); await retry.waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    const stopped = bootstrapCount; await page.evaluate(() => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); });
    assert.equal(bootstrapCount, stopped, "no login retry loop");
    assert((await retry.boundingBox()).height >= 44, "touch recovery control");
    await page.screenshot({ path: resolve(B, `browser-login-required-${width}.png`) });
    login = true; actor = { ...actor, key: "b".repeat(48) }; await retry.click();
    await frame().getByText(`Fixture workspace ready ${actor.key}`, { exact: true }).waitFor();
    assert.equal(await page.locator('iframe').count(), 1); assert.equal(navigationCount, nav);
    await page.evaluate(() => window.stopWorkspace()); assert.equal(await page.locator('#workspace').locator('iframe').count(), 0);
    assert.deepEqual(errors, []); result.cases.push({ width, expiredLeaseRecovered: true, loginDenialStopped: true, explicitRetryNewActor: true, noPageRefresh: true, cleanup: true });
    await context.close();
  }
  assert(requests.every(path => ['/agent/bootstrap','/agent/heartbeat','/agent/revoke','/agent/exchange'].includes(path)));
  result.status = 'SYNTHETIC_BROWSER_IDLE_RECOVERY_PASS';
} catch (e) { result.status = 'FAIL'; result.error = e.message; process.exitCode = 1; }
finally {
  for (const c of contexts) await c.close().catch(() => {}); if (browser) await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); result.ownedResourcesClosed = true;
  await writeFile(resolve(B, 'browser-result.json'), JSON.stringify(result,null,2)+'\n', { flag: 'wx' }); console.log(JSON.stringify(result));
}
