/** Real parent loader/UI with a held synthetic read. No deployed API, model,
 * credentials or native target effects. Guards complete-plan consent throughout. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { semanticCatalogFixture, catalogEvidence } from "./fixtures/semantic-catalog-fixture.mjs";
import { sourceUrn, datasetUrn } from "./fixtures/semantic-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${root}extensions/datahub-agent/pi-web/package.json`);
const { build } = require("esbuild"), { chromium } = require("playwright");
const evidence = process.argv[2] ?? `${root}.local/evidence/semantic-maintenance-loading-browser`;
let f, plan, held, release, browser, page, asset, drift = false, heldReady, calls;
const checks = [], errors = [];
async function pending(input) {
  f.writes.pending = { requestId: randomUUID(), sessionId: f.sessionId, ...input };
  return f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
}
async function seed() {
  f = semanticCatalogFixture(); calls = []; drift = false;
  const draft = await pending({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] });
  const reference = { maintenanceRunUrn: draft.maintenanceRunUrn };
  const { action: _def, ...definition } = await f.definitionRequest({ kind: "tag", operation: "create", name: "Loading fixture <literal>", description: "Synthetic progressive difference" });
  const staged = await pending({ ...definition, action: "prepare_maintenance", ...reference });
  const { action: _asset, ...application } = await f.request([{ kind: "tag", operation: "add", value: staged.items[0].definition.urn, ...catalogEvidence }]);
  await pending({ ...application, action: "prepare_maintenance", ...reference });
  plan = await pending({ action: "seal_maintenance", ...reference });
  heldReady = new Promise(resolve => { held = resolve; });
}
const server = createServer(async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.url === "/host" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    try {
      const q = JSON.parse(raw); calls.push(q.action);
      assert(["read_maintenance", "read_review", "read_review_detail"].includes(q.action), "no consent/mutation during loading test");
      if (q.action === "read_review" && q.decisionId === plan.items[1].id && !release) {
        const gate = new Promise(resolve => { release = resolve; }); held(); await gate;
      }
      const result = await f.call(q);
      if (drift && q.action === "read_maintenance" && calls.filter(x => x === "read_maintenance").length === 2)
        result.runVersion = String(Number(result.runVersion) + 1);
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
  } else if (req.url === "/closed") { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>Owned closed test</title>"); }
  else if (req.url === "/app.js") { res.setHeader("content-type", "application/javascript"); res.end(asset.outputFiles[0].contents); }
  else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(`<!doctype html><html lang=zh-Hant><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px system-ui}</style><main id=host></main><script src=/app.js></script>`); }
});
try {
  await mkdir(evidence, { recursive: true });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
  page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
  for (const scenario of [{ width: 390, mode: "success" }, { width: 1440, mode: "success" }, { width: 1440, mode: "drift" }, { width: 1440, mode: "close" }]) {
    release = undefined; await seed(); drift = scenario.mode === "drift";
    const bytesBefore = JSON.stringify([...f.journal]);
    asset = await build({ bundle: true, write: false, format: "iife", platform: "browser", stdin: {
      resolveDir: `${root}extensions/datahub-agent/mfe`, contents: `import {semanticMaintenancePanel} from './semantic-maintenance-review.js';
        semanticMaintenancePanel({container:document.getElementById('host'),reference:${JSON.stringify({ maintenanceRunUrn: plan.maintenanceRunUrn })},signal:new AbortController().signal,
          send:async(q,signal)=>{const r=await fetch('/host',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(q),signal});return r.json();}});` } });
    await page.setViewportSize({ width: scenario.width, height: 900 }); await page.goto(origin);
    await heldReady; // First complete review was validated before the held second read.
    const dialog = page.getByRole("dialog", { name: "整批語義維護計畫" });
    const approve = dialog.getByRole("button", { name: "確認整批並依序建立／套用", exact: true });
    assert.equal(await approve.isDisabled(), true);
    await dialog.locator("footer p").first().filter({ hasText: /已讀取差異 1／2 項/ }).waitFor({ timeout: 3000 });
    const preview = dialog.locator("[data-semantic-loading-item]");
    assert.equal(await preview.count(), 1, "first validated diff visible before complete plan");
    assert.equal(await dialog.locator("input").count(), 1, "search only, no consent or item selection during partial loading");
    await preview.getByText("精確前後差異、階層／關聯／值與證據", { exact: true }).click();
    await preview.getByText("Synthetic progressive difference", { exact: false }).first().waitFor();
    assert.equal(await dialog.locator("img,script").count(), 0);
    assert(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth));
    await page.screenshot({ path: `${evidence}/${scenario.mode}-${scenario.width}-loading.png` });
    if (scenario.mode === "close") {
      await dialog.getByRole("button", { name: "關閉／停止後續執行", exact: true }).click();
      await dialog.waitFor({ state: "detached", timeout: 3000 });
      const count = calls.length; release();
      await page.goto(origin + "/closed"); // Own navigation lets the cancelled response settle.
      assert.equal(calls.length, count, "close must not drain remaining read requests");
    } else {
      release();
      if (drift) {
        await dialog.getByText(/只讀核對未確認：semantic_maintenance_plan_changed/).waitFor();
        assert.equal(await approve.isDisabled(), true);
        assert.equal(await dialog.locator("[data-plan-acknowledgement]").count(), 0);
      } else {
        await dialog.getByText("已讀齊原生計畫；未確認不會建立／套用。", { exact: true }).waitFor();
        assert.equal(await dialog.locator("fieldset").count(), 2);
        assert.equal(await dialog.locator("[data-semantic-loading-item]").count(), 0);
        assert.equal(await approve.isDisabled(), true);
        await dialog.getByLabel("我已核對整批差異與證據", { exact: false }).check();
        assert.equal(await approve.isDisabled(), false, "only complete same-version plan enables native confirmation");
      }
      await page.screenshot({ path: `${evidence}/${scenario.mode}-${scenario.width}-finished.png` });
      await dialog.getByRole("button", { name: "關閉／停止後續執行", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
    }
    assert.equal(f.writes.targetWrites, 0);
    assert.equal(JSON.stringify([...f.journal]), bytesBefore);
    checks.push({ ...scenario, readonlyProgressiveDiff: true, noEarlyConsent: true, noWrites: true });
  }
  assert.deepEqual(errors, []);
  await writeFile(`${evidence}/result.json`, JSON.stringify({ synthetic: true, checks, liveCalls: 0, errors }, null, 2));
  console.log(JSON.stringify({ synthetic: true, checks }));
} catch (e) {
  if (page) await page.screenshot({ path: `${evidence}/failure.png` });
  await writeFile(`${evidence}/failure.json`, JSON.stringify({ error: e.message, calls, errors }, null, 2));
  throw e;
} finally {
  release?.(); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
