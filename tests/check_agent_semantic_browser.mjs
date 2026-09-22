/** Local synthetic component smoke only; no DataHub login, provider call or deployment. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { semanticFixture, semanticCheckpointFixture, datasetUrn } from "./fixtures/semantic-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const web = `${root}extensions/datahub-agent/pi-web`;
const evidence = process.argv[2] ?? `${root}.local/evidence/semantic-steward/s2-checkpoint-runtime`;
const require = createRequire(`${web}/package.json`);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const checkpoint = await semanticCheckpointFixture().run();
const f = semanticFixture();
f.state.dataset.datasetProperties.value.description = '<img src="x" onerror="window.exploited=true">';
const inspected = await f.run();
const preview = await f.run({ action: "preview", snapshotDigest: inspected.snapshotDigest, candidates: [{
  kind: "description", value: "<script>window.exploited=true</script>",
  reason: "Synthetic evidence, not a real business definition", evidenceIds: ["dataset:source-description"],
}] });
const definition = await f.run({ action: "preview_definition", snapshotDigest: inspected.snapshotDigest,
  definition: { kind: "tag", name: "Reviewed", description: '<img src=x onerror="window.exploited=true">' },
  reason: "Synthetic definition proposal, not native publication", evidenceIds: ["dataset:source-description"] });
const selectedField = await f.run({ fieldPath: "order_id" });
f.state.impactRows = [datasetUrn, "urn:li:dataset:PRIVATE"].map((urn) => ({ type: "TaggedWith", direction: "INCOMING", entity: { urn } }));
const impact = await f.run({ action: "inspect_impact", kind: "tag", referenceUrn: "urn:li:tag:Existing" });
const asset = await build({
  absWorkingDir: web, write: false, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  stdin: { contents: `import { createRoot } from 'react-dom/client';
    import { DataHubSemanticPreview, isSemanticPreview } from './components/DataHubSemanticPreview';
    fetch('/fixture.json').then(r=>r.json()).then(value=>{
      if(!isSemanticPreview(value)) throw Error('invalid fixture');
      createRoot(document.getElementById('root')).render(<DataHubSemanticPreview preview={value}/>);
    });`, loader: "tsx", resolveDir: web },
});
const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Semantic component smoke — synthetic</title><style>
:root{--bg-panel:#fff;--text:#172b4d;--border:#d9e2ec}body{margin:0;background:#f5f7fa;font:14px/1.5 system-ui,sans-serif}main{max-width:850px;margin:16px auto;padding:8px}summary{cursor:pointer}summary:focus-visible{outline:2px solid #1471eb}th,td{padding:6px;text-align:left;vertical-align:top}dd{margin-left:16px}
</style><main id="root"></main><script src="/app.js"></script></html>`;
let served = preview;
const server = createServer((req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.url === "/fixture.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(served)); }
  else if (req.url === "/app.js") { res.setHeader("content-type", "application/javascript"); res.end(asset.outputFiles[0].contents); }
  else if (req.url === "/") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); }
  else { res.writeHead(404); res.end(); }
});
let browser;
try {
  await mkdir(evidence, { recursive: true });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  // No external network, credentials, existing browser profile or live service.
  await context.route("**/*", (route) => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  const checks = [];
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    await page.getByRole("heading", { name: "語義維護 · 差異預覽" }).waitFor();
    assert.match(await page.locator("body").innerText(), /唯讀・尚未核准／發布/);
    assert.match(await page.locator("body").innerText(), /不會自動覆寫/);
    assert.equal(await page.locator("section button").count(), 0);
    const summary = page.getByText("查看依據（位置已核對，意義仍待審）", { exact: true });
    await summary.focus(); await page.keyboard.press("Enter");
    assert.equal(await summary.evaluate((node) => node.parentElement.open), true);
    assert.equal(await page.evaluate(() => window.exploited), undefined);
    assert.equal(await page.locator("section script,section img").count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no page-level horizontal overflow");
    await page.screenshot({ path: `${evidence}/preview-${width}.png`, fullPage: true });
    checks.push({ width, protectedBeforeAfter: true, markupEscaped: true, keyboardDisclosure: true, noPageOverflow: true });
  }
  const text = await page.locator("section").innerText();
  await page.reload(); await page.getByRole("heading", { name: "語義維護 · 差異預覽" }).waitFor();
  await page.getByText("查看依據（位置已核對，意義仍待審）", { exact: true }).click();
  assert.equal(await page.locator("section").innerText(), text, "serialized fixture readback, not native Pi session acceptance");
  served = inspected;
  await page.setViewportSize({ width: 390, height: 900 }); await page.reload();
  await page.getByRole("heading", { name: "語義維護 · Catalog 盤點" }).waitFor();
  assert.equal(await page.getByRole("columnheader").count(), 4);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${evidence}/inventory-390.png`, fullPage: true });
  served = definition;
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.reload();
    await page.getByRole("heading", { name: "語義維護 · 新定義提案" }).waitFor();
    assert.match(await page.locator("body").innerText(), /找到同名詞彙/);
    const draft = page.getByText("原生格式草稿（尚未驗證可建立）", { exact: true });
    await draft.focus(); await page.keyboard.press("Enter");
    assert.equal(await draft.evaluate((node) => node.parentElement.open), true);
    await page.getByText("重用候選（1）", { exact: true }).click();
    assert.match(await page.locator("body").innerText(), /未完成共用定義影響分析/);
    assert.equal(await page.locator("section button,section script,section img").count(), 0);
    assert.equal(await page.evaluate(() => window.exploited), undefined);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${evidence}/definition-${width}.png`, fullPage: true });
    checks.push({ width, definitionProposal: true, reuseConflict: true, keyboardDisclosure: true, markupEscaped: true, noPageOverflow: true });
  }
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    served = selectedField; await page.reload();
    const field = page.getByText("選定欄位屬性：order_id", { exact: true });
    await field.focus(); await page.keyboard.press("Enter");
    assert.match(await page.locator("body").innerText(), /原生 schemaField 身分尚未確認/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${evidence}/field-${width}.png`, fullPage: true });
    served = impact; await page.reload();
    await page.getByRole("heading", { name: "語義維護 · 共用定義影響" }).waitFor();
    const text = await page.locator("body").innerText();
    assert.match(text, /不是全域修改授權/); assert.doesNotMatch(text, /PRIVATE/);
    assert.equal(await page.locator("section button,section script,section img").count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${evidence}/impact-${width}.png`, fullPage: true });
    checks.push({ width, fieldProperties: true, sharedImpact: true, unapprovedIdentifiersRedacted: true, noPageOverflow: true });
  }
  served = checkpoint;
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.reload();
    await page.getByRole("heading", { name: "語義維護 · Catalog 盤點" }).waitFor();
    const text = await page.locator("body").innerText();
    assert.match(text, /僅指該次成功 Run/); assert.match(text, /Checkpoint 時間/);
    assert.match(text, /尚未核准／發布/); assert.equal(await page.locator("section button").count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${evidence}/checkpoint-${width}.png`, fullPage: true });
    checks.push({ width, checkpointRunScope: true, noPublicationAuthority: true, noPageOverflow: true });
  }
  assert.deepEqual(errors, []);
  const result = { status: "passed", scope: "Synthetic React component only; not deployed Composer/model/DataHub E2E", checks, runtimeErrors: errors, metadataWrites: 0 };
  await writeFile(`${evidence}/browser-result.json`, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
