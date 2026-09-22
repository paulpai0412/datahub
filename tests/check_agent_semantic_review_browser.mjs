/** Synthetic cross-origin React card → real MFE → real semantic Host/records
 * with the existing fake public DataHub boundary. No login/provider/deployment. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { semanticPublicationFixture } from "./fixtures/semantic-publication-fixture.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const web = `${root}extensions/datahub-agent/pi-web`;
const evidence = process.argv[2] ?? `${root}.local/evidence/semantic-steward/s3`;
const require = createRequire(`${web}/package.json`);
const { build } = require("esbuild"), { chromium } = require("playwright");
const card = await build({ absWorkingDir: web, write: false, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  stdin: { loader: "tsx", resolveDir: web, contents: `import {createRoot} from 'react-dom/client';
    import {DataHubSemanticReview,isSemanticReview} from './components/DataHubSemanticReview';
    fetch('/fixture.json').then(r=>r.json()).then(value=>{if(!isSemanticReview(value))throw Error('invalid review fixture');
      createRoot(document.getElementById('root')).render(<DataHubSemanticReview review={value}/>);});` } });
let f, prepared, parentOrigin, frameOrigin, browser, page, phase = "setup";
const errors = [], checks = [];
const style = "body{margin:0;font:14px/1.5 system-ui;background:#f5f7fa;color:#172b4d}:root{--text:#172b4d;--text-muted:#455468}button{cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid #1471eb;outline-offset:2px}button:disabled{cursor:not-allowed}iframe{width:100%;height:100dvh;border:0;display:block}";
const html = (body) => `<!doctype html><html lang=zh-Hant><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Semantic review — synthetic</title><style>${style}</style>${body}</html>`;
const frameServer = createServer((req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.url === "/fixture.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(prepared)); }
  else if (req.url === "/card.js") { res.setHeader("content-type", "application/javascript"); res.end(card.outputFiles[0].contents); }
  else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html('<main id="root"></main><script src="/card.js"></script>')); }
});
let parentAsset;
const parentServer = createServer(async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.url === "/host" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    try { const result = await f.call(JSON.parse(raw)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result)); }
    catch (error) { res.writeHead(error.status ?? 409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
  } else if (req.url === "/host.js") { res.setHeader("content-type", "application/javascript"); res.end(parentAsset.outputFiles[0].contents); }
  else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html(`<main id="host"><iframe title="Pi workspace" src="${frameOrigin}"></iframe></main><script src="/host.js"></script>`)); }
});
try {
  await mkdir(evidence, { recursive: true });
  frameServer.listen(0, "127.0.0.1"); parentServer.listen(0, "127.0.0.1");
  await Promise.all([once(frameServer, "listening"), once(parentServer, "listening")]);
  frameOrigin = `http://127.0.0.1:${frameServer.address().port}`;
  parentOrigin = `http://127.0.0.1:${parentServer.address().port}`;
  parentAsset = await build({ write: false, bundle: true, platform: "browser", format: "iife",
    stdin: { resolveDir: `${root}extensions/datahub-agent/mfe`, contents: `import {installSemanticBridge} from './semantic.js';
      installSemanticBridge({container:document.getElementById('host'),frame:document.querySelector('iframe'),origin:${JSON.stringify(frameOrigin)},
        send:async(request,signal)=>{const response=await fetch('/host',{method:'POST',body:JSON.stringify(request),headers:{'content-type':'application/json'},signal});return response.json();}});` } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", (route) => [frameOrigin, parentOrigin].some((origin) => route.request().url().startsWith(origin + "/")) ? route.continue() : route.abort());
  page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [390, 1440]) {
    phase = `prepare-${width}`;
    f = semanticPublicationFixture();
    f.state.dataset.datasetProperties.value.description = '<img src=x onerror="window.exploited=true">';
    const human = structuredClone(f.state.dataset.editableSchemaMetadata.value.editableSchemaFieldInfo[0]);
    prepared = await f.prepare([
      { kind: "tag", value: "urn:li:tag:Reviewed", reason: "Fixture evidence", evidenceIds: ["dataset:source-description"] },
      { kind: "description", fieldPath: "[version=2.0].[type=struct].net.amount", value: '<script>window.exploited=true</script>', reason: "Synthetic only", evidenceIds: ["dataset:source-description"] },
    ]);
    await page.setViewportSize({ width, height: 900 }); await page.goto(parentOrigin);
    const workspace = page.frameLocator("iframe");
    const open = workspace.getByRole("button", { name: "Review / Approve", exact: true }); await open.waitFor();
    await page.screenshot({ path: `${evidence}/review-card-${width}.png`, fullPage: true });
    phase = `select-${width}`;
    await open.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "語義提案審核" }); await dialog.waitFor();
    await dialog.getByRole("checkbox", { name: "選取 tag 資料集或定義" }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Approve 並發布", exact: true }).isDisabled(), true);
    await dialog.getByRole("checkbox", { name: "選取 tag 資料集或定義" }).uncheck();
    await dialog.getByRole("button", { name: "儲存選取版本" }).click();
    await page.waitForFunction(() => document.querySelectorAll("dialog fieldset").length === 1);
    assert.equal(f.writes.submissions, 0);
    await dialog.locator("summary").first().focus(); await page.keyboard.press("Enter");
    assert.equal(await dialog.locator("details").first().evaluate((node) => node.open), true);
    assert.equal(await page.evaluate(() => window.exploited), undefined);
    assert.equal(await dialog.locator("script,img").count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth));
    await page.screenshot({ path: `${evidence}/review-panel-${width}.png`, fullPage: true });
    phase = `approve-${width}`;
    await dialog.getByRole("checkbox", { name: "我已核對差異與證據，確認核准這個版本。" }).check();
    await dialog.getByRole("button", { name: "Approve 並發布", exact: true }).click();
    await dialog.getByText(/^狀態：ATTEMPTED/).waitFor();
    assert.equal(f.writes.submissions, 1); assert.equal(f.writes.targetWrites, 1);
    assert.deepEqual(f.state.dataset.editableSchemaMetadata.value.editableSchemaFieldInfo[0], human);
    assert.equal(f.state.dataset.globalTags.value.tags.length, 1);
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
    phase = `reload-${width}`;
    await page.reload();
    await workspace.getByText("狀態：REJECT · 快照已變更", { exact: true }).waitFor();
    await workspace.getByRole("button", { name: "開啟明細與稽核記錄" }).click();
    await dialog.getByRole("button", { name: "檢視此版本" }).click();
    await dialog.getByText(/^狀態：ATTEMPTED/).waitFor();
    assert.match(await dialog.innerText(), /VERIFIED_CURRENT_VALUES/);
    assert.match(await dialog.innerText(), /MATCHED_CLAIMED_ATTEMPT/);
    assert.equal(await dialog.getByRole("button", { name: "Approve 並發布", exact: true }).isDisabled(), true);
    await page.screenshot({ path: `${evidence}/review-reload-${width}.png`, fullPage: true });
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
    phase = `forged-verdict-${width}`;
    const frame = page.frames().find((frame) => frame.url().startsWith(frameOrigin));
    const denied = await frame.evaluate(async (reference) => new Promise((resolve) => {
      const channel = new MessageChannel(); channel.port1.onmessage = (event) => { channel.port1.close(); resolve(JSON.parse(event.data)); };
      window.parent.postMessage({ type: "datahub-semantic", body: JSON.stringify({ action: "approve_review", ...reference, verdict: "APPROVE" }) }, "*", [channel.port2]);
    }), prepared.reviewRef);
    assert.equal(denied.error, "semantic_request_failed"); assert.equal(f.writes.submissions, 1);
    checks.push({ width, realParentBridge: true, keyboardReview: true, perItemSelection: true, trustedApproval: true,
      populatedHumanValuesPreserved: true, persistedReload: true, forgedIframeVerdictDenied: true, markupEscaped: true, noOverflow: true,
      simulatedTargetSubmissions: f.writes.submissions });
  }
  assert.deepEqual(errors, []);
  const result = { status: "PASS_SYNTHETIC_BROWSER_HOST_RECORD_LOOP", scope: "Production React/MFE/Host against fake DataHub and native-session boundaries; not deployed authentication/model/native-Catalog proof", checks, runtimeErrors: errors, liveDatahubCalls: 0, deployments: 0 };
  await writeFile(`${evidence}/browser-review-result.json`, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(`${evidence}/browser-review-failure-${Date.now()}.json`, JSON.stringify({ phase, error: error.message, runtimeErrors: errors, html: await page?.content() }, null, 2));
  throw error;
} finally {
  await browser?.close();
  for (const server of [parentServer, frameServer]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
