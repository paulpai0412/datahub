/** Browser component/MessageView verification against the actual isolated Host
 * report. No generated metadata, live identity/model, Next build or deployment.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
const [reportPath, evidence] = process.argv.slice(2);
if (!reportPath || !evidence) throw new Error("Supply Host report path and new evidence directory");
const root = fileURLToPath(new URL("../", import.meta.url));
const web = join(root, "extensions/datahub-agent/pi-web");
const require = createRequire(join(web, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const { createJiti } = require("jiti");
const jiti = createJiti(join(web, "package.json"), { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { isPluginPreview } = await jiti.import(join(web, "lib/discovery-plugin-preview.ts"));
const raw = await readFile(reportPath);
const report = JSON.parse(raw);
assert.equal(report.status, "PASS");
assert.equal(isPluginPreview(report.api), true);
assert.equal(isPluginPreview(report.cases.etl), false);
// Unit-only malformed variants: never fed back to Host or called real outputs.
for (const change of [
  value => { value.publicationAuthorized = true; },
  value => { value.result.graph.nodes.find(node => node.kind === "port").owner = "node_" + "0".repeat(64); },
  value => { value.result.graph.nodes[0].evidence[0].fileSha256 = "0".repeat(64); },
  value => { value.result.graph.coverage = []; },
]) {
  const value = structuredClone(report.api); change(value); assert.equal(isPluginPreview(value), false);
}
const asset = await build({ absWorkingDir: web, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", outdir: "/unused",
  // Same presentation-only define as Dockerfile.pi-web/Next; no process shim.
  define: { "process.env.NEXT_PUBLIC_DATAHUB_EMBED": '"true"' },
  stdin: { loader: "tsx", resolveDir: web, contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {MessageView} from './components/MessageView';import {I18nProvider} from './hooks/useI18n';
function Check(){const [selected,setSelected]=useState('api');const value=window.flowCases[selected];
const message={role:'assistant',content:[{type:'toolCall',toolCallId:'captured-result',toolName:'datahub_etl',input:{action:'analyze_workspace'}}]};
const results=new Map([['captured-result',{role:'toolResult',toolCallId:'captured-result',toolName:'datahub_etl',content:[{type:'text',text:JSON.stringify(value)}],details:value,isError:false}]]);
return <I18nProvider><p>Captured real-source Host results — component verification, not a live model session.</p><label>驗證案例<select aria-label="驗證案例" value={selected} onChange={e=>setSelected(e.target.value)}><option value="api">OpenAPI</option><option value="etl">Original ETL</option><option value="summary">Summary</option></select></label><MessageView key={selected} message={message} toolResults={results}/></I18nProvider>};
createRoot(document.getElementById('root')).render(<Check/>);` } });
await mkdir(evidence); // Do not overwrite a previous run.
let browser, page;
const errors = [];
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", route => route.abort()); // UI replay needs no network.
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.setContent('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--bg:#fff;--bg-panel:#fafafa;--bg-subtle:#f5f5f5;--text:#222;--text-muted:#555;--text-dim:#666;--border:#bbb;--accent:#2563eb;--font-mono:monospace}body{margin:0;padding:12px;font-family:system-ui}*{box-sizing:border-box}</style><div id="root"></div>');
  await page.evaluate(value => { window.flowCases = value; }, { api: report.api, ...report.cases });
  for (const css of asset.outputFiles.filter(file => file.path.endsWith(".css"))) await page.addStyleTag({ content: css.text });
  await page.addScriptTag({ content: asset.outputFiles.find(file => file.path.endsWith(".js")).text });
  const checks = [];
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByLabel("驗證案例").selectOption("api");
    const preview = page.getByRole("region", { name: "Discovery 插件預覽", exact: true });
    await preview.waitFor();
    assert.equal(await preview.getByRole("article", { name: "request:application/json", exact: true }).count(), 1);
    assert.equal(await preview.getByRole("article", { name: "response:200:application/json", exact: true }).count(), 1);
    assert.match(await preview.innerText(), /沒有已宣告關係/);
    await preview.getByLabel("資產／程序").focus();
    assert.equal(await preview.getByLabel("資產／程序").evaluate(node => node === document.activeElement), true);
    // Use the first actual evidence disclosure, then inspect real source bytes' binding.
    await preview.locator("summary").filter({ hasText: "來源證據" }).first().click();
    assert.match(await preview.innerText(), /api\.json:1/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `page overflow at ${width}`);
    await page.screenshot({ path: join(evidence, `plugin-${width}.png`), fullPage: true });
    checks.push(`plugin ports, evidence, keyboard focus, no overflow at ${width}`);
    for (const [key, count] of [["etl", 37], ["summary", 8]]) {
      await page.getByLabel("驗證案例").selectOption(key);
      const legacy = page.getByRole("region", { name: "datahub_etl 分析預覽", exact: true });
      await legacy.waitFor();
      assert.match(await legacy.innerText(), new RegExp(`觀測到的目標 schema 欄位\\s*${count}`));
      assert.equal(await page.getByRole("region", { name: "Discovery 插件預覽", exact: true }).count(), 0);
      checks.push(`${key}: unchanged legacy renderer at ${width}`);
    }
  }
  assert.deepEqual(errors, []);
  const result = { status: "PASS", scope: "actual_host_result_messageview_browser_replay", reportSha256: createHash("sha256").update(raw).digest("hex"),
    browser: browser.version(), checks, guardChecks: 6, modelVerified: false, authenticatedSessionVerified: false, freshCatalog: false, deployed: false };
  await writeFile(join(evidence, "report.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(join(evidence, "failure.json"), JSON.stringify({ error: String(error), browserErrors: errors,
    body: page ? await page.locator("body").innerText() : null }, null, 2) + "\n", { flag: "wx" });
  throw error;
} finally { await browser?.close(); }
