/** Actual SettingsPanel/React -> parent MFE -> Host; native DataHub and config
 * are isolated fixtures. No live services, auth files, model or native writes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sourceSettingsFixture } from "./fixtures/source-settings-fixture.mjs";
import { nativeSemanticCatalog } from "../extensions/datahub-agent/integration/native-semantic-catalog.mjs";
import { compileSemanticPublication } from "../extensions/datahub-agent/integration/semantic-publication.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), web = `${root}extensions/datahub-agent/pi-web`;
const require = createRequire(`${web}/package.json`), { build } = require("esbuild"), { chromium } = require("playwright");
const evidence = await mkdtemp(`${root}.local/evidence/source-settings-browser-`);
const card = await build({ absWorkingDir: web, write: false, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outdir: "/synthetic", define: { "process.env.NEXT_PUBLIC_DATAHUB_EMBED": '"true"' },
  stdin: { loader: "tsx", resolveDir: web, contents: `import {createRoot} from 'react-dom/client'; import {I18nProvider} from './hooks/useI18n'; import {SettingsPanel} from './components/SettingsPanel';
    createRoot(document.getElementById('root')).render(<I18nProvider><SettingsPanel cwd={null} sessionId={null} initialSection="sources" onClose={()=>{}} onSessionReloaded={()=>{}} quoteSelectionEnabled={false} onQuoteSelectionChange={()=>{}} /></I18nProvider>);` } });
const js = card.outputFiles.find((f) => f.path.endsWith(".js")).contents, css = card.outputFiles.find((f) => f.path.endsWith(".css"))?.contents ?? "";
const globals = (await readFile(`${web}/app/globals.css`, "utf8")).replace(/^@import.*$/gm, "");
const settingsCss = await readFile(`${web}/app/settings.css`), datahubCss = await readFile(`${web}/app/datahub.css`);
const fonts = new Map(await Promise.all(["Mulish-Regular.ttf", "Mulish-SemiBold.ttf"].map(async (name) => ["/fonts/" + name, await readFile(`${web}/app/fonts/${name}`)])));
const html = (body) => `<!doctype html><html lang=zh-Hant data-datahub=true><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px/1.5 system-ui}iframe{border:0;width:100%;height:100dvh}</style>${body}</html>`;
let fixture, asset, browser, page, frameOrigin, parentOrigin, saveIntents = 0;
const errors = [], checks = [], fixtureDirs = [];
const frameServer = createServer((req, res) => {
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("content-security-policy", `frame-ancestors ${parentOrigin}`);
  if (req.url === "/card.js") { res.setHeader("content-type", "application/javascript"); res.end(js); }
  else if (req.url === "/card.css") { res.setHeader("content-type", "text/css"); res.end(css); }
  else if (req.url === "/globals.css") { res.setHeader("content-type", "text/css"); res.end(globals); }
  else if (req.url === "/settings.css") { res.setHeader("content-type", "text/css"); res.end(settingsCss); }
  else if (req.url === "/datahub.css") { res.setHeader("content-type", "text/css"); res.end(datahubCss); }
  else if (fonts.has(req.url)) { res.setHeader("content-type", "font/ttf"); res.end(fonts.get(req.url)); }
  else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html('<link rel="stylesheet" href="/globals.css"><link rel="stylesheet" href="/settings.css"><link rel="stylesheet" href="/datahub.css"><link rel="stylesheet" href="/card.css"><main id="root"></main><script src="/card.js"></script>')); }
});
const parentServer = createServer(async (req, res) => {
  if (req.url === "/host" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    try { const request = JSON.parse(raw); if (request.action === "save") saveIntents++;
      const result = await fixture.call(request); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(error.status ?? 409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
  } else if (req.url === "/host.js") { res.setHeader("content-type", "application/javascript"); res.end(asset.outputFiles[0].contents); }
  else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html(`<main id="host"><iframe title="Agent workspace" referrerpolicy="no-referrer" src="${frameOrigin}"></iframe></main><script src="/host.js"></script>`)); }
});
try {
  frameServer.listen(0, "127.0.0.1"); parentServer.listen(0, "127.0.0.1");
  await Promise.all([once(frameServer, "listening"), once(parentServer, "listening")]);
  frameOrigin = `http://127.0.0.1:${frameServer.address().port}`; parentOrigin = `http://127.0.0.1:${parentServer.address().port}`;
  asset = await build({ write: false, bundle: true, platform: "browser", format: "iife", stdin: { resolveDir: `${root}extensions/datahub-agent/mfe`, contents: `import {installSourceSettingsBridge} from './source-settings.js';
    installSourceSettingsBridge({container:document.getElementById('host'),frame:document.querySelector('iframe'),origin:${JSON.stringify(frameOrigin)},
      send:async(request,signal)=>{const r=await fetch('/host',{method:'POST',body:JSON.stringify(request),headers:{'content-type':'application/json'},signal});return r.json();}});` } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "zh-TW" });
  await context.route("**/*", (route) => [parentOrigin, frameOrigin].some((o) => route.request().url().startsWith(o + "/")) ? route.continue() : route.abort());
  page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [1440, 390]) {
    fixture = await sourceSettingsFixture(); fixtureDirs.push(fixture.dir); saveIntents = 0;
    await page.setViewportSize({ width, height: 950 }); await page.goto(parentOrigin);
    const frame = page.frameLocator("iframe"), source = frame.getByRole("button", { name: /AdventureWorks <script>/ });
    await source.click();
    await frame.getByText("91個可讀Dataset · 91個欄位").waitFor();
    assert.equal(await frame.locator("script:not([src])").count(), 0);
    assert.equal(await frame.getByRole("button", { name: "檢查差異並保存" }).isDisabled(), true);
    await frame.getByLabel("啟用模型metadata傳送與提案預覽").check();
    await frame.getByRole("button", { name: "選取全部已匯入資產" }).click();
    await frame.getByRole("button", { name: "檢查差異並保存" }).click();
    const dialog = page.getByRole("dialog", { name: "確認Pi Agent使用來源" });
    await dialog.waitFor(); assert.equal(saveIntents, 0);
    assert.equal(await dialog.getByRole("button", { name: "確認並保存" }).isDisabled(), true);
    assert.equal(await dialog.locator("li").count(), 91);
    assert.equal(await dialog.locator("script,img").count(), 0);
    assert(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth));
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
    await frame.getByText("已取消，沒有保存。", { exact: true }).waitFor(); assert.equal(saveIntents, 0);
    await frame.getByRole("button", { name: "檢查差異並保存" }).click(); await dialog.waitFor();
    await dialog.getByRole("checkbox").check();
    await page.screenshot({ path: `${evidence}/confirm-${width}.png`, fullPage: true });
    await dialog.getByRole("button", { name: "確認並保存" }).click();
    await frame.getByText(/^Host已保存並立即套用/).waitFor(); assert.equal(saveIntents, 1);
    const config = JSON.parse(await readFile(fixture.path, "utf8")), policy = config.ingestionSourcesByActor[fixture.actor.key].find((s) => s.urn === fixture.urn);
    assert.equal(policy.taskDatasets.length, 91); assert.equal(policy.ingestionExecutionApproved, false); assert.equal(policy.semanticPublicationApproved, false);
    await page.reload(); await source.click();
    await frame.getByText("91個可讀Dataset · 91個欄位").waitFor();
    assert.equal(await frame.getByLabel("啟用模型metadata傳送與提案預覽").isChecked(), true);
    assert.equal(await frame.locator('fieldset input[type="checkbox"]:checked').count(), 92);
    const child = page.frames().find((f) => f.url().startsWith(frameOrigin));
    assert(await child.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await child.evaluate(() => document.referrer), "");
    const denied = await child.evaluate(() => new Promise((resolve) => { const c = new MessageChannel(); c.port1.onmessage = (e) => { c.port1.close(); resolve(JSON.parse(e.data)); }; window.parent.postMessage({ type: "datahub-source-settings", body: JSON.stringify({ action: "save", enabled: true }) }, "*", [c.port2]); }));
    assert.equal(denied.error, "source_settings_request_failed"); assert.equal(saveIntents, 1);
    await page.screenshot({ path: `${evidence}/saved-${width}.png`, fullPage: true });
    await frame.getByLabel("允許建立審核提案與人工核准後發布").check();
    await frame.getByLabel("允許提案新增共用定義").check();
    await frame.getByLabel("允許提案修改共用定義").check();
    await frame.getByRole("button", { name: "檢查差異並保存" }).click(); await dialog.waitFor();
    assert.equal(saveIntents, 1);
    await dialog.getByText(/審核提案／人工核准發布：關 → 開/).waitFor();
    await dialog.getByText(/共用定義新增：關 → 開/).waitFor();
    assert(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth));
    await dialog.getByRole("checkbox").check(); await dialog.getByRole("button", { name: "確認並保存" }).click();
    await frame.getByText(/^Host已保存並立即套用/).waitFor(); assert.equal(saveIntents, 2);
    const ctx = { ...fixture.context, sources: fixture.applied.get(fixture.actor.key), frontendOrigin: "http://fixture.invalid", fetchImpl: fixture.fetchImpl };
    const inspected = await nativeSemanticCatalog({ contract: "catalog/1", action: "inspect_asset", requestId: "22222222-2222-4222-8222-222222222222", sourceUrn: fixture.urn, assetUrn: fixture.datasets[0] }, ctx);
    const compiled = await compileSemanticPublication({ contract: "catalog/1", action: "preview", requestId: "22222222-2222-4222-8222-222222222222", sourceUrn: fixture.urn, assetUrn: fixture.datasets[0], snapshotDigest: inspected.snapshotDigest,
      candidates: [{ kind: "description", operation: "set", fieldPath: "id", value: "Fixture field label", reason: "Fixture only", evidenceIds: ["field:0:path"] }] }, ctx);
    assert.equal(compiled.purpose, "SEMANTIC");
    await page.reload(); await source.click(); await frame.getByText("91個可讀Dataset · 91個欄位").waitFor();
    for (const label of ["允許建立審核提案與人工核准後發布", "允許提案新增共用定義", "允許提案修改共用定義"]) assert(await frame.getByLabel(label).isChecked());
    assert.equal(await frame.getByRole("combobox", { name: "發布Agent身分" }).inputValue(), fixture.agentUrn);
    await page.screenshot({ path: `${evidence}/publication-${width}.png`, fullPage: true });
    assert(await page.frames().find((f) => f.url().startsWith(frameOrigin)).evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await frame.getByLabel(fixture.datasets[0], { exact: false }).uncheck();
    await frame.getByRole("button", { name: "檢查差異並保存" }).click(); await dialog.waitFor();
    await dialog.getByText("移除的1個Dataset", { exact: true }).click();
    assert.equal(await dialog.locator("details li").count(), 1);
    await dialog.getByRole("checkbox").check(); await dialog.getByRole("button", { name: "確認並保存" }).click();
    await frame.getByText(/^Host已保存並立即套用/).waitFor(); assert.equal(saveIntents, 3);
    await frame.getByLabel("啟用模型metadata傳送與提案預覽").uncheck();
    for (const label of ["允許建立審核提案與人工核准後發布", "允許提案新增共用定義", "允許提案修改共用定義"]) assert.equal(await frame.getByLabel(label).isChecked(), false);
    await frame.getByRole("button", { name: "檢查差異並保存" }).click(); await dialog.waitFor();
    await dialog.getByRole("checkbox").check(); await dialog.getByRole("button", { name: "確認並保存" }).click();
    await frame.getByText(/已停用此來源的語義工具存取/).waitFor(); assert.equal(saveIntents, 4);
    await assert.rejects(nativeSemanticCatalog({ contract: "catalog/1", action: "list_assets", requestId: "55555555-5555-4555-8555-555555555555", sourceUrn: fixture.urn, offset: 0 },
      { ...fixture.context, sources: fixture.applied.get(fixture.actor.key), frontendOrigin: "http://fixture.invalid", fetchImpl: fixture.fetchImpl }), /not_configured/);
    await page.reload(); await source.click(); await frame.getByText("91個可讀Dataset · 91個欄位").waitFor();
    assert.equal(await frame.getByLabel("啟用模型metadata傳送與提案預覽").isChecked(), false);
    assert.equal(await frame.locator('fieldset input[type="checkbox"]:checked').count(), 90);
    fixture.setPrivileges(false);
    await frame.getByRole("button", { name: "重新讀取來源" }).click();
    await frame.getByText(/^需要DataHub「管理政策」/).waitFor(); assert.equal(saveIntents, 4);
    checks.push({ width, cancelNoSave: true, saveRequiresParentConsent: true, savedDatasetScopes: 91, publicationCompilerRecovered: true, separateDefinitionGrants: true, publicationReloadPreserved: true, disablingMetadataRevokesPublication: true, reloadPreserved: true, exactRemovalDiff: true, partialScopePreserved: 90, disableBlocksSemanticReader: true, disabledReloadPreserved: true, scriptTextNotExecuted: true, iframeSaveRejected: true, revocationRejected: true, noOverflow: true });
  }
  assert.deepEqual(errors, []);
  await writeFile(`${evidence}/receipt.json`, JSON.stringify({ status: "PASS_ISOLATED_SETTINGS_REACT_MFE_HOST", checks, errors, liveDatahubCalls: 0, deployments: 0, modelMessages: 0 }, null, 2));
  console.log(evidence);
} catch (error) {
  await writeFile(`${evidence}/failure.json`, JSON.stringify({ error: error.message, errors, saveIntents }, null, 2)); throw error;
} finally {
  await browser?.close();
  for (const server of [frameServer, parentServer]) { server.closeAllConnections(); if (server.listening) await new Promise((resolve) => server.close(resolve)); }
  for (const dir of fixtureDirs) await rm(dir, { recursive: true, force: true });
}
