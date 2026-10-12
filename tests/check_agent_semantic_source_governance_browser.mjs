/** Parent MFE on an owned loopback page with a synthetic public Host API.
 * No production session, model, consent or native target effects. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { semanticCatalogFixture, catalogEvidence } from "./fixtures/semantic-catalog-fixture.mjs";
import { sourceUrn, datasetUrn, envelope } from "./fixtures/semantic-fixture.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${root}extensions/datahub-agent/pi-web/package.json`);
const { build } = require("esbuild"), { chromium } = require("playwright");
const evidence = process.argv[2] ?? `${root}.local/evidence/semantic-source-governance-browser`;
const f = semanticCatalogFixture(), calls = [], errors = [], checks = [];
let browser, server, asset;
async function write(input) {
  f.writes.pending = { requestId: randomUUID(), sessionId: f.sessionId, ...input };
  return f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
}
async function stage(reference, proposal) {
  const { action: _action, ...body } = proposal;
  return write({ ...body, action: "prepare_maintenance", ...reference });
}
try {
  await mkdir(evidence, { recursive: true });
  // Same short-name existing definition stays in the other hierarchy.
  f.state.definitions["urn:li:glossaryNode:OtherSource"] = { glossaryNodeInfo: envelope({ name: "Other Source Only", definition: "Specific to another Source; not automatically inherited" }) };
  f.state.definitions["urn:li:glossaryTerm:Order"].glossaryTermInfo.value.parentNode = "urn:li:glossaryNode:OtherSource";
  const draft = await write({ action: "start_maintenance", sourceUrn, focus: "glossary", assetUrns: [datasetUrn] });
  const reference = { maintenanceRunUrn: draft.maintenanceRunUrn };
  const grouped = await stage(reference, await f.definitionRequest({ kind: "node", operation: "create", name: "Current Source <literal> Concepts", description: "Synthetic Source-specific governance proposal" }));
  const terms = await stage(reference, await f.definitionRequest({ kind: "term", operation: "create", name: "Order", description: "Exact Source-supported proposal; not inherited from the other grouping", parentUrn: grouped.items[0].definition.urn }));
  await stage(reference, await f.request([{ kind: "term", operation: "add", value: terms.items[1].definition.urn, ...catalogEvidence }]));
  const ready = await write({ action: "seal_maintenance", ...reference });
  const journalBefore = JSON.stringify([...f.journal]), writesBefore = f.writes.recordWrites;
  asset = await build({ bundle: true, write: false, format: "iife", platform: "browser", stdin: { resolveDir: `${root}extensions/datahub-agent/mfe`, contents:
    `import {semanticMaintenancePanel} from './semantic-maintenance-review.js';
     semanticMaintenancePanel({container:document.getElementById('host'),reference:${JSON.stringify(reference)},signal:new AbortController().signal,
       send:async(q,signal)=>{const r=await fetch('/host',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(q),signal});return r.json();}});` } });
  server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.url === "/host" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      try {
        const input = JSON.parse(raw); calls.push(input.action);
        assert(["read_maintenance", "read_review", "read_review_detail"].includes(input.action), "owned browser is read-only");
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify(await f.call(input)));
      } catch (error) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
    } else if (req.url === "/app.js") { res.setHeader("content-type", "application/javascript"); res.end(asset.outputFiles[0].contents); }
    else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end("<!doctype html><html lang=zh-Hant><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><style>body{margin:0;font:14px system-ui}</style><main id=host></main><script src=/app.js></script>"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(origin);
    const dialog = page.getByRole("dialog", { name: "整批語義維護計畫" });
    await dialog.locator("header p").first().filter({ hasText: "僅詞彙與群組" }).waitFor();
    assert.equal(await dialog.locator("fieldset").count(), ready.totalItems);
    const item = dialog.locator("fieldset").filter({ has: page.getByLabel("選取計畫項目 詞彙 · Order", { exact: true }) });
    await item.getByText("精確前後差異、階層／關聯／值與證據", { exact: true }).click();
    await item.getByText("完整歸屬：Current Source <literal> Concepts → Order", { exact: true }).waitFor();
    assert.equal(await item.locator("literal").count(), 0, "metadata rendered as text, not HTML");
    await item.getByText("群組與祖先的定義及原生定位", { exact: true }).click();
    await item.getByText("Synthetic Source-specific governance proposal", { exact: true }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "確認整批並依序建立／套用", exact: true }).isDisabled(), true);
    assert.equal(await dialog.locator("[data-plan-acknowledgement]").isChecked(), false);
    const geometry = await dialog.evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth,
      contentWidth: node.querySelector('[aria-label="維護建議清單"]').clientWidth,
      contentScroll: node.querySelector('[aria-label="維護建議清單"]').scrollWidth }));
    assert(geometry.scrollWidth <= geometry.width + 1); assert(geometry.contentScroll <= geometry.contentWidth + 1);
    await page.screenshot({ path: `${evidence}/source-${width}.png` });
    checks.push({ width, focusVisible: true, fullPathVisible: true, ancestorDescriptionVisible: true, metadataIsText: true, confirmWithoutAck: false, geometry });
  }
  assert.equal(f.writes.recordWrites, writesBefore); assert.equal(f.writes.targetWrites, 0);
  assert.equal(JSON.stringify([...f.journal]), journalBefore);
  assert.deepEqual(errors, []);
  await writeFile(`${evidence}/result.json`, JSON.stringify({ status: "SYNTHETIC_PARENT_SOURCE_GOVERNANCE_VERIFIED", checks, reads: calls.length,
    targetWrites: 0, browserErrors: errors, productionEntrypointVerified: false }, null, 2));
  console.log(JSON.stringify({ status: "PASS", checks: checks.length, nativeTargetWrites: 0, evidence }));
} finally {
  if (browser) await browser.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
}
