/** Local-only browser integration: production React/MFE/Host, synthetic native
 * API/session boundary. Two loopback servers; no deployed service or credentials. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function checkSemanticBatchBrowser(createFixture) {
  const root = fileURLToPath(new URL("../../", import.meta.url)), web = `${root}extensions/datahub-agent/pi-web`;
  const require = createRequire(`${web}/package.json`), { build } = require("esbuild"), { chromium } = require("playwright");
  await mkdir(`${root}.local/evidence`, { recursive: true });
  const evidence = await mkdtemp(`${root}.local/evidence/semantic-batch-browser-`);
  const card = await build({ absWorkingDir: web, write: false, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    stdin: { loader: "tsx", resolveDir: web, contents: `import {createRoot} from 'react-dom/client';
      import {DataHubSemanticManagedCycle,isManagedCycle} from './components/DataHubSemanticManagedCycle';
      fetch('/fixture.json').then(r=>r.json()).then(result=>{if(!isManagedCycle(result))throw Error('invalid cycle');
        createRoot(document.getElementById('root')).render(<DataHubSemanticManagedCycle result={result}/>);});` } });
  const html = (body) => `<!doctype html><html lang=zh-Hant><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px/1.5 system-ui}iframe{border:0;width:100%;height:100dvh}button:focus-visible,input:focus-visible{outline:3px solid #1471eb}</style>${body}</html>`;
  let f, cycle, asset, browser, page, frameOrigin, parentOrigin, condition, dispatches = 0, release, committed, commitReady;
  const errors = [], checks = [], approvalRequests = [];
  const frameServer = createServer((req, res) => {
    if (req.url === "/fixture.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(cycle)); }
    else if (req.url === "/card.js") { res.setHeader("content-type", "application/javascript"); res.end(card.outputFiles[0].contents); }
    else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html('<main id="root"></main><script src="/card.js"></script>')); }
  });
  const parentServer = createServer(async (req, res) => {
    if (req.url === "/host" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      try {
        const request = JSON.parse(raw); if (request.action === "approve_review") { dispatches++; approvalRequests.push(request); }
        const result = await f.call(request);
        if (condition === "STOP" && request.action === "approve_review") {
          const held = new Promise((resolve) => { release = resolve; }); committed(); await held;
        }
        if (condition === "LOST_ACK" && request.action === "approve_review") { res.destroy(); return; }
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
      } catch (error) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
    } else if (req.url === "/host.js") { res.setHeader("content-type", "application/javascript"); res.end(asset.outputFiles[0].contents); }
    else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html(`<main id="host"><iframe title="Agent workspace" src="${frameOrigin}"></iframe></main><script src="/host.js"></script>`)); }
  });
  try {
    frameServer.listen(0, "127.0.0.1"); parentServer.listen(0, "127.0.0.1");
    await Promise.all([once(frameServer, "listening"), once(parentServer, "listening")]);
    frameOrigin = `http://127.0.0.1:${frameServer.address().port}`; parentOrigin = `http://127.0.0.1:${parentServer.address().port}`;
    asset = await build({ write: false, bundle: true, platform: "browser", format: "iife", stdin: { resolveDir: `${root}extensions/datahub-agent/mfe`, contents: `import {installSemanticBridge} from './semantic.js';
      installSemanticBridge({container:document.getElementById('host'),frame:document.querySelector('iframe'),origin:${JSON.stringify(frameOrigin)},
      send:async(request,signal)=>{if(request.action==='approve_review')window.batchApprovalIntents=(window.batchApprovalIntents??0)+1;const response=await fetch('/host',{method:'POST',body:JSON.stringify(request),headers:{'content-type':'application/json'},signal});return response.json();}});` } });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route("**/*", (route) => [parentOrigin, frameOrigin].some((origin) => route.request().url().startsWith(origin + "/")) ? route.continue() : route.abort());
    page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
    for (const scenario of [{ width: 390, condition: "SUCCESS" }, { width: 1440, condition: "SUCCESS" }, { width: 390, condition: "LOST_ACK" }, { width: 390, condition: "STOP" }]) {
      condition = scenario.condition; dispatches = 0; approvalRequests.length = 0; f = await createFixture();
      commitReady = new Promise((resolve) => { committed = resolve; });
      cycle = await f.call({ action: "read_managed_cycle", cycleRunUrn: f.cycleRunUrn, requestId: randomUUID() });
      await page.setViewportSize({ width: scenario.width, height: 900 }); await page.goto(parentOrigin);
      const frame = page.frameLocator("iframe"), open = frame.getByRole("button", { name: "在 Host 開啟批次審核", exact: true });
      await open.focus(); await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "代管批次真人審核" });
      await dialog.getByText("已載入 3 筆原生提案，預設未選取任何項目。", { exact: true }).waitFor();
      const approve = dialog.getByRole("button", { name: "確認選取提案並循序發布", exact: true });
      assert.equal(await approve.isDisabled(), true);
      const choices = dialog.locator("fieldset input[type=checkbox]"); assert.equal(await choices.count(), 3);
      for (let index = 0; index < 3; index++) assert.equal(await choices.nth(index).isChecked(), false);
      await choices.nth(0).check();
      const ack = dialog.locator('[data-batch-acknowledgement="true"]'); await ack.check();
      await choices.nth(1).check(); assert.equal(await ack.isChecked(), false); assert.equal(await approve.isDisabled(), true);
      await ack.check(); assert.equal(f.writes.targetWrites, 0);
      await dialog.locator("summary").first().click();
      assert.ok(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(await dialog.locator("script,img").count(), 0);
      await page.screenshot({ path: `${evidence}/${condition}-${scenario.width}-selection.png`, fullPage: true });
      await approve.click();
      if (condition === "STOP") {
        await commitReady;
        await dialog.getByRole("button", { name: "停止後續（不回滾目前操作）", exact: true }).click();
        release();
      }
      if (condition === "SUCCESS") await dialog.getByText(/^選取的 2 筆均已初始成功並讀回/).waitFor();
      else await dialog.getByText(/^已停止；未送出共 1 筆/).waitFor();
      assert.equal(f.writes.targetWrites, condition === "SUCCESS" ? 2 : 1);
      const approvalIntents = await page.evaluate(() => window.batchApprovalIntents);
      assert.equal(approvalIntents, condition === "SUCCESS" ? 2 : 1, "application must not replay after a lost ACK");
      if (condition === "LOST_ACK") {
        // Chromium may repeat the identical POST after a connection reset. The
        // same-version native CAS rejects it: no next item or second target write.
        assert.equal(new Set(approvalRequests.map((request) => JSON.stringify(request))).size, 1);
      } else assert.equal(dispatches, condition === "SUCCESS" ? 2 : 1);
      assert.equal(await approve.isDisabled(), true);
      assert.equal(await dialog.getByRole("button", { name: "重新讀取待審清單" }).isDisabled(), true);
      await page.screenshot({ path: `${evidence}/${condition}-${scenario.width}-result.png`, fullPage: true });
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
      await frame.getByText(/^Host 審核視窗已關閉/).waitFor();
      const child = page.frames().find((item) => item.url().startsWith(frameOrigin));
      const denied = await child.evaluate(async (cycleRunUrn) => new Promise((resolve) => {
        const channel = new MessageChannel(); channel.port1.onmessage = (event) => { channel.port1.close(); resolve(JSON.parse(event.data)); };
        window.parent.postMessage({ type: "datahub-semantic-batch-review", body: JSON.stringify({ cycleRunUrn, selected: ["forged"], verdict: "APPROVE" }) }, "*", [channel.port2]);
      }), f.cycleRunUrn);
      assert.equal(denied.error, "semantic_request_failed");
      assert.equal(f.writes.targetWrites, condition === "SUCCESS" ? 2 : 1);
      await page.reload(); await frame.getByRole("button", { name: "在 Host 開啟批次審核" }).click();
      await dialog.getByText(`已載入 ${condition === "SUCCESS" ? 1 : 2} 筆原生提案，預設未選取任何項目。`, { exact: true }).waitFor();
      assert.equal(f.writes.targetWrites, condition === "SUCCESS" ? 2 : 1, "reload/read cannot replay the initial write or auto-select remaining items");
      await page.keyboard.press("Escape");
      checks.push({ ...scenario, approvalIntents, transportRequests: dispatches, nativeTargetWrites: f.writes.targetWrites, selectionResetAcknowledgement: true, stoppedWithoutReplay: true, iframeVerdictRejected: true });
    }
    assert.deepEqual(errors, []);
    await writeFile(`${evidence}/result.json`, JSON.stringify({ status: "PASS_SYNTHETIC_BROWSER_HOST_RECORD_LOOP", checks, errors, liveDatahubCalls: 0, deployments: 0 }, null, 2));
    console.log(`Batch browser evidence: ${evidence}`);
  } catch (error) {
    await writeFile(`${evidence}/failure.json`, JSON.stringify({ condition, error: error.message, errors, html: await page?.content() }, null, 2));
    throw error;
  } finally {
    release?.();
    await browser?.close();
    for (const server of [parentServer, frameServer]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }
}
