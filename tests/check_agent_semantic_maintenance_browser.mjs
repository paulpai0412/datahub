/** Existing synthetic browser pattern: React card → parent MFE → fake public
 * DataHub API/CAS. No provider, login, real metadata, deployment or SQL. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { semanticCatalogFixture, catalogEvidence } from "./fixtures/semantic-catalog-fixture.mjs";
import { sourceUrn, datasetUrn } from "./fixtures/semantic-fixture.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)), web = `${root}extensions/datahub-agent/pi-web`;
const require = createRequire(`${web}/package.json`), { build } = require("esbuild"), { chromium } = require("playwright");
const evidence = process.argv[2] ?? `${root}.local/evidence/semantic-maintenance-workflow-local-20261003/browser`;
const style = "body{margin:0;font:14px/1.5 system-ui;background:#f5f7fa;color:#172b4d}:root{--text:#172b4d;--text-muted:#455468}button,input{font:inherit}button:focus-visible,input:focus-visible{outline:3px solid #1471eb;outline-offset:2px}iframe{width:100%;height:100dvh;border:0;display:block}";
const html = (body) => `<!doctype html><html lang=zh-Hant><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Maintenance — synthetic</title><style>${style}</style>${body}</html>`;
let f, plan, incrementalPlan, frameOrigin, parentOrigin, parentAsset, browser;
const checks = [], errors = [];
// Actual AppShell + MessageView + right-panel provider. Only Next navigation
// and the public HTTP dependencies are synthetic; no substitute review shell.
const card = await build({ absWorkingDir: web, write: false, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@": web, tailwindcss: `${web}/node_modules/tailwindcss/index.css` }, loader: { ".ttf": "dataurl" }, define: { "process.env.NEXT_PUBLIC_DATAHUB_EMBED": '"true"', "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "fixture-navigation", setup(b) {
    b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", resolveDir: web, contents: `import{useState,useEffect,useMemo}from'react';
      export function useSearchParams(){const[s,set]=useState(location.search);useEffect(()=>{const f=()=>set(location.search);addEventListener('popstate',f);return()=>removeEventListener('popstate',f)},[]);return useMemo(()=>new URLSearchParams(s),[s])}
      export function useRouter(){return useMemo(()=>({replace(u){history.replaceState(null,'',u);dispatchEvent(new PopStateEvent('popstate'))},push(u){history.pushState(null,'',u);dispatchEvent(new PopStateEvent('popstate'))},refresh(){}}),[])}` }));
  }}],
  stdin: { loader: "tsx", resolveDir: web, contents: "import{createRoot}from'react-dom/client';import{AppShell}from'./components/AppShell';import{I18nProvider}from'./hooks/useI18n';import'./app/globals.css';import'./app/datahub.css';createRoot(document.getElementById('root')).render(<I18nProvider><AppShell/></I18nProvider>);" }, outfile: "/fixture/app.js" });
const frameServer = createServer((req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.url.startsWith("/api/")) {
    const path = new URL(req.url, "http://fixture").pathname;
    const info = { id: f.sessionId, path: "/fixture/session.jsonl", cwd: "/fixture", name: "Synthetic review only", created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", messageCount: 2, firstMessage: "Synthetic review" };
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    let body = {};
    if (path === "/api/sessions") body = { sessions: [info] };
    else if (path === `/api/sessions/${f.sessionId}`) body = { sessionId: f.sessionId, filePath: info.path, totalActiveMs: 0, tree: [], leafId: null, toolNames: [], context: { messages: [
      { role: "assistant", content: [{ type: "toolCall", toolCallId: "fixture-call", toolName: "datahub_semantic", input: { action: plan.action ?? "read_maintenance" } }], provider: "fixture", model: "fixture", api: "fixture", usage, stopReason: "toolUse", timestamp: 1 },
      { role: "toolResult", toolCallId: "fixture-call", toolName: "datahub_semantic", content: [{ type: "text", text: "Synthetic review only" }], details: plan, isError: false, timestamp: 2 }
    ], entryIds: ["assistant", "result"], oldestEntryId: null, hasMore: false, thinkingLevel: "high", model: null } };
    else if (path.endsWith("/state")) body = { running: false };
    else if (path === "/api/agent/running") body = { sessionListVersion: 1, runningSessionIds: [] };
    else if (path === "/api/home") body = { home: "/fixture" };
    else if (path === "/api/models") body = { models: [], modelList: [], defaultModel: null };
    else if (path === "/api/project-trust") body = { trusted: false };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body));
  } else if (req.url === "/card.js") { res.setHeader("content-type", "application/javascript"); res.end(card.outputFiles.find(file => file.path.endsWith(".js")).contents); }
  else if (req.url === "/card.css") { res.setHeader("content-type", "text/css"); res.end(card.outputFiles.find(file => file.path.endsWith(".css")).contents); }
  else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html('<link rel="stylesheet" href="/card.css"><main id="root"></main><script src="/card.js"></script>')); }
});
const parentServer = createServer(async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.url === "/host" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    try { const result = await f.call(JSON.parse(raw)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result)); }
    catch (error) { res.writeHead(error.status ?? 409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
  } else if (req.url === "/host.js") { res.setHeader("content-type", "application/javascript"); res.end(parentAsset.outputFiles[0].contents); }
  else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html(`<main id="host"><iframe title="Pi workspace" src="${frameOrigin}/?session=${f.sessionId}"></iframe></main><script src="/host.js"></script>`)); }
});
async function pending(input) {
  f.writes.pending = { requestId: randomUUID(), sessionId: f.sessionId, ...input };
  return f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
}
async function seed() {
  f = semanticCatalogFixture(); f.writes.recordHistoryLimits.ekopAgentRun = 2147483647;
  const draft = await pending({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] });
  const rootRef = { maintenanceRunUrn: draft.maintenanceRunUrn };
  const proposal = await f.definitionRequest({ kind: "tag", operation: "create", name: "Fixture whole-plan classification", description: "Synthetic only, exact human batch confirmation" });
  const { action: _definitionAction, ...definition } = proposal;
  const staged = await pending({ ...definition, action: "prepare_maintenance", responseMode: "incremental", ...rootRef });
  const tag = staged.items[0].definition.urn;
  const request = await f.request([{ kind: "tag", operation: "add", value: tag, ...catalogEvidence }]);
  const { action: _assetAction, ...asset } = request;
  incrementalPlan = await pending({ ...asset, action: "prepare_maintenance", responseMode: "incremental", ...rootRef });
  plan = await pending({ action: "seal_maintenance", ...rootRef });
  return tag;
}
try {
  await mkdir(evidence, { recursive: true });
  frameServer.listen(0, "127.0.0.1"); parentServer.listen(0, "127.0.0.1");
  await Promise.all([once(frameServer, "listening"), once(parentServer, "listening")]);
  frameOrigin = `http://127.0.0.1:${frameServer.address().port}`; parentOrigin = `http://127.0.0.1:${parentServer.address().port}`;
  parentAsset = await build({ write: false, bundle: true, platform: "browser", format: "iife", stdin: { resolveDir: `${root}extensions/datahub-agent/mfe`,
    contents: `import {installSemanticBridge} from './semantic.js';installSemanticBridge({container:document.getElementById('host'),frame:document.querySelector('iframe'),origin:${JSON.stringify(frameOrigin)},send:async(request,signal)=>{const response=await fetch('/host',{method:'POST',body:JSON.stringify(request),headers:{'content-type':'application/json'},signal});return response.json();}});` } });
  browser = await chromium.launch({ headless: true }); const context = await browser.newContext();
  await context.route("**/*", (route) => [frameOrigin, parentOrigin].some((origin) => route.request().url().startsWith(origin + "/")) ? route.continue() : route.abort());
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [390, 1440]) {
    const tag = await seed(); plan = incrementalPlan;
    await page.setViewportSize({ width, height: 900 }); await page.goto(parentOrigin);
    const frame = page.frameLocator("iframe");
    await frame.getByText("本次新增／修訂摘要，不是完整計畫；可信面板仍會讀齊所有項目與差異。", { exact: true }).waitFor();
    await frame.getByText("本次 1 個項目（全部 2）", { exact: true }).waitFor();
    assert.equal(f.writes.targetWrites, 0);
    await page.screenshot({ path: `${evidence}/incremental-card-${width}.png`, fullPage: true });
    await frame.getByRole("button", { name: "在 Host 核對整批計畫／原生結果" }).click();
    const dialog = page.getByRole("region", { name: "整批語義維護計畫" });
    await dialog.getByText("已讀齊原生計畫；未確認不會建立／套用。", { exact: true }).waitFor();
    assert.equal(f.writes.targetWrites, 0);
    await dialog.locator("fieldset").first().getByText("精確前後差異、階層／關聯／值與證據", { exact: true }).click();
    await dialog.getByText("Synthetic only, exact human batch confirmation", { exact: false }).first().waitFor();
    const checksBoxes = dialog.locator("input[data-item-id]");
    await checksBoxes.nth(0).uncheck(); assert.equal(await checksBoxes.nth(1).isChecked(), false);
    await checksBoxes.nth(1).check(); assert.equal(await checksBoxes.nth(0).isChecked(), true);
    assert.equal(await dialog.getByRole("button", { name: "確認整批並依序建立／套用" }).isDisabled(), true);
    await page.screenshot({ path: `${evidence}/plan-${width}.png`, fullPage: true });
    assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    const ack = dialog.getByLabel("我已核對整批差異與證據", { exact: false });
    await ack.check();
    await checksBoxes.nth(0).uncheck(); assert.equal(await ack.isChecked(), false);
    assert.equal(await dialog.getByRole("button", { name: "確認整批並依序建立／套用" }).isDisabled(), true);
    await checksBoxes.nth(1).check(); await ack.check();
    await dialog.getByLabel("顯示項目類型").selectOption("definition");
    assert.equal(await ack.isChecked(), true); assert.equal(await checksBoxes.nth(1).isChecked(), true);
    await dialog.getByLabel("顯示項目類型").selectOption("all");
    assert.equal(await dialog.locator("pre").count(), 0, "review uses structured user-readable values, not JSON dumps");
    await dialog.getByRole("button", { name: "確認整批並依序建立／套用" }).click();
    await dialog.getByText(/本次已核對 2；缺口／阻擋 0/).waitFor();
    assert.equal(f.writes.targetWrites, 2);
    assert(f.state.definitions[tag].tagProperties);
    assert(f.state.dataset.globalTags.value.tags.some((entry) => entry.tag === tag));
    assert.equal(await dialog.getByRole("button", { name: "繼續尚未派送項目（不再確認／不重送）" }).isDisabled(), true);
    await page.screenshot({ path: `${evidence}/verified-${width}.png`, fullPage: true });
    await dialog.getByRole("button", { name: "關閉／停止後續執行" }).click(); await dialog.waitFor({ state: "detached" });
    const next = await pending({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] });
    const update = await f.definitionRequest({ kind: "tag", operation: "update", urn: tag, version: "1", description: "Synthetic changed second-round definition content" });
    const { action: _updateAction, ...updateBody } = update;
    await pending({ ...updateBody, action: "prepare_maintenance", maintenanceRunUrn: next.maintenanceRunUrn });
    const keep = await f.request([{ kind: "tag", operation: "add", value: tag, ...catalogEvidence }]);
    const { action: _keepAction, ...keepBody } = keep;
    await pending({ ...keepBody, action: "prepare_maintenance", maintenanceRunUrn: next.maintenanceRunUrn });
    plan = await pending({ action: "seal_maintenance", maintenanceRunUrn: next.maintenanceRunUrn });
    await page.goto(parentOrigin);
    await frame.getByRole("button", { name: "在 Host 核對整批計畫／原生結果" }).click();
    await dialog.getByText("已讀齊原生計畫；未確認不會建立／套用。", { exact: true }).waitFor();
    await dialog.locator("fieldset").first().getByText("精確前後差異、階層／關聯／值與證據", { exact: true }).click();
    await dialog.getByText(/本案新建定義更新：原初始成功/).waitFor({ state: "attached" });
    await dialog.getByText("證據與限制", { exact: true }).first().click();
    await dialog.getByText(/本案新建定義更新：原初始成功/).waitFor();
    assert.equal(f.writes.targetWrites, 2);
    assert.equal(await dialog.getByRole("button", { name: "確認整批並依序建立／套用" }).isDisabled(), true);
    assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: `${evidence}/owned-update-${width}.png`, fullPage: true });
    await dialog.getByLabel("我已核對整批差異與證據", { exact: false }).check();
    await dialog.getByRole("button", { name: "確認整批並依序建立／套用" }).click();
    await dialog.getByText(/本次已核對 2；缺口／阻擋 0/).waitFor();
    assert.equal(f.writes.targetWrites, 3);
    assert.equal(f.state.definitions[tag].tagProperties.value.description, "Synthetic changed second-round definition content");
    await page.screenshot({ path: `${evidence}/owned-update-verified-${width}.png`, fullPage: true });
    await dialog.getByRole("button", { name: "關閉／停止後續執行" }).click(); await dialog.waitFor({ state: "detached" });
    const partial = await pending({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn, f.assets.chart] });
    const inspected = await f.inspect(f.assets.chart);
    await pending({ action: "prepare_maintenance", maintenanceRunUrn: partial.maintenanceRunUrn, contract: "catalog/1",
      sourceUrn, assetUrn: f.assets.chart, snapshotDigest: inspected.snapshotDigest,
      gap: { code: "UNRESOLVED_OPERATION", reason: "Synthetic historical UNKNOWN deliberately skipped",
        operation: { action: "prepare_maintenance", maintenanceRunUrn: next.maintenanceRunUrn } } });
    const independent = await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence }]);
    const { action: _independentAction, ...independentBody } = independent;
    await pending({ ...independentBody, action: "prepare_maintenance", maintenanceRunUrn: partial.maintenanceRunUrn });
    plan = await pending({ action: "seal_maintenance", maintenanceRunUrn: partial.maintenanceRunUrn });
    await page.goto(parentOrigin);
    await frame.getByRole("button", { name: "在 Host 核對整批計畫／原生結果" }).click();
    await dialog.getByText("已讀齊原生計畫；未確認不會建立／套用。", { exact: true }).waitFor();
    await dialog.getByText(/本輪 1 項歷史未知操作暫緩、不派送/).waitFor();
    await dialog.getByText(/暫緩未知操作：Synthetic historical UNKNOWN/).waitFor();
    await dialog.getByText("原未知操作的定位（不重播）", { exact: true }).click();
    await dialog.getByText(next.maintenanceRunUrn, { exact: true }).last().waitFor({ state: "attached" });
    assert.equal(f.writes.targetWrites, 3);
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: `${evidence}/deferred-${width}.png`, fullPage: true });
    await dialog.getByLabel("我已核對整批差異與證據", { exact: false }).check();
    await dialog.getByRole("button", { name: "確認整批並依序建立／套用" }).click();
    await dialog.getByText(/本次已核對 1；缺口／阻擋 1/).waitFor();
    assert.equal(f.writes.targetWrites, 4, "only the independent item was dispatched");
    assert(f.state.dataset.globalTags.value.tags.some(entry => entry.tag === "urn:li:tag:Reviewed"));
    await dialog.getByText(/暫緩未知操作：Synthetic historical UNKNOWN/).waitFor();
    await dialog.getByRole("button", { name: "關閉／停止後續執行" }).click(); await dialog.waitFor({ state: "detached" });
    checks.push({ width, incrementalCardNotFullPlan: true, parentReadsFullPlanFromDeltaLocator: true, singlePlanConsentPerRound: true, orderedDefinitionAndApplication: true, ownedDefinitionSecondRound: true,
      explicitDeferredVisible: true, independentPartialPlanExecuted: true, deferredTargetNotDispatched: true, targetWrites: 4, overflow: false });
  }
  // Long plan: 140 native fixture definitions + one application + one gap.
  // Nothing is published. Exercise actual AppShell resize/expand/search/close.
  f = semanticCatalogFixture(); f.writes.recordHistoryLimits.ekopAgentRun = 2147483647;
  const long = await pending({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn, f.assets.chart] });
  for (let index = 0; index < 140; index++) {
    const proposal = await f.definitionRequest({ kind: "tag", operation: "create", name: `Synthetic label ${index}`, description: "Synthetic literal <img src=x onerror=alert(1)>; no HTML execution" });
    const { action: _action, ...body } = proposal;
    await pending({ ...body, action: "prepare_maintenance", maintenanceRunUrn: long.maintenanceRunUrn });
  }
  const application = await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence }]);
  const { action: _application, ...body } = application;
  await pending({ ...body, action: "prepare_maintenance", maintenanceRunUrn: long.maintenanceRunUrn });
  const missing = await f.inspect(f.assets.chart);
  await pending({ action: "prepare_maintenance", maintenanceRunUrn: long.maintenanceRunUrn, contract: "catalog/1", sourceUrn,
    assetUrn: f.assets.chart, snapshotDigest: missing.snapshotDigest, gap: { code: "INSUFFICIENT_EVIDENCE", reason: "Synthetic only; missing business evidence" } });
  plan = await pending({ action: "seal_maintenance", maintenanceRunUrn: long.maintenanceRunUrn });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(parentOrigin);
    const frame = page.frameLocator("iframe");
    await frame.getByRole("button", { name: "在 Host 核對整批計畫／原生結果" }).click();
    const panel = page.getByRole("region", { name: "整批語義維護計畫" });
    await panel.getByText("已讀齊原生計畫；未確認不會建立／套用。", { exact: true }).waitFor();
    assert.equal(await panel.locator("input[data-item-id]").count(), 142);
    const approve = panel.getByRole("button", { name: "確認整批並依序建立／套用" });
    const ack = panel.getByLabel("我已核對整批差異與證據", { exact: false });
    for (const control of [approve, ack]) { const rect = await control.boundingBox(); assert(rect.y >= 0 && rect.y + rect.height <= 900, "acknowledgement and action remain visible at initial scroll"); }
    assert.equal(await ack.isChecked(), false); assert.equal(await approve.isDisabled(), true);
    await panel.locator("fieldset").first().getByText("精確前後差異、階層／關聯／值與證據", { exact: true }).click();
    await panel.getByText("Synthetic literal <img src=x onerror=alert(1)>; no HTML execution", { exact: true }).first().waitFor();
    assert.equal(await panel.locator("img").count(), 0); assert.equal(await panel.locator("pre").count(), 0);
    await page.screenshot({ path: `${evidence}/long-readable-${width}.png`, fullPage: true });
    const selection = await panel.locator("input[data-item-id]").evaluateAll(nodes => nodes.map(n => n.checked));
    await panel.getByLabel("搜尋資產、定義或欄位").fill("Synthetic label 139");
    assert.equal(await panel.locator("fieldset:visible").count(), 1);
    assert.deepEqual(await panel.locator("input[data-item-id]").evaluateAll(nodes => nodes.map(n => n.checked)), selection);
    await panel.getByLabel("搜尋資產、定義或欄位").fill("");
    await panel.getByLabel("顯示項目類型").selectOption("gap"); assert.equal(await panel.locator("fieldset:visible").count(), 1);
    await panel.getByLabel("顯示項目類型").selectOption("all");
    await panel.getByRole("region", { name: "維護建議清單" }).evaluate(el => { el.scrollTop = el.scrollHeight; });
    for (const control of [approve, ack]) { const rect = await control.boundingBox(); assert(rect.y >= 0 && rect.y + rect.height <= 900); }
    await frame.getByRole("button", { name: "放大", exact: true }).click();
    await frame.getByRole("button", { name: "還原", exact: true }).click();
    assert.equal(f.writes.targetWrites, 0); assert.equal(await ack.isChecked(), false);
    if (width === 1440) {
      await frame.locator("body").evaluate(() => location.reload());
      await panel.waitFor({ state: "detached" });
      await frame.getByRole("button", { name: "在 Host 核對整批計畫／原生結果" }).waitFor();
      assert.equal(f.writes.targetWrites, 0, "iframe navigation removes the parent-owned review and never executes");
      await frame.getByRole("button", { name: "在 Host 核對整批計畫／原生結果" }).click();
      await panel.getByText("已讀齊原生計畫；未確認不會建立／套用。", { exact: true }).waitFor();
      assert.equal(await ack.isChecked(), false, "reopen never restores acknowledgement");
    }
    await frame.getByRole("button", { name: "關閉審核面板", exact: true }).click(); await panel.waitFor({ state: "detached" });
    await frame.getByRole("button", { name: "在 Host 核對整批計畫／原生結果" }).waitFor();
    assert.equal(await frame.getByRole("button", { name: "在 Host 核對整批計畫／原生結果" }).evaluate(el => el === document.activeElement), true);
    checks.push({ width, actualAppShell: true, longPlanItems: 142, fixedAcknowledgementAndAction: true, humanReadableNoJSON: true,
      literalHTMLSafe: true, searchAndFilterPreserveSelection: true, expandRestore: true, closeRestoresFocus: true, targetWrites: 0 });
  }
  assert.deepEqual(errors, []);
  await writeFile(`${evidence}/receipt.json`, JSON.stringify({ synthetic: true, realMetadataWrites: 0, checks, errors }, null, 2));
  console.log(JSON.stringify({ synthetic: true, evidence, checks }));
} finally {
  await browser?.close(); frameServer.closeAllConnections(); parentServer.closeAllConnections();
  await Promise.all([new Promise((resolve) => frameServer.close(resolve)), new Promise((resolve) => parentServer.close(resolve))]);
}
