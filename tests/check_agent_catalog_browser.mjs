/** Synthetic browser/Host seam, not live DataHub/model/ACL acceptance. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { catalogFixture, datasetUrn } from "./fixtures/catalog-fixture.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const web = `${root}extensions/datahub-agent/pi-web`;
const require = createRequire(`${web}/package.json`);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const evidence =
  process.argv[2] ?? `${root}.local/evidence/catalog-explorer/local`;
const fixture = catalogFixture();
fixture.state.records.get(datasetUrn).editableProperties.description =
  '<img src=x onerror="window.exploited=true">';
const initial = await fixture.run();
const asset = await build({
  absWorkingDir: web,
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  outdir: "/unused",
  stdin: {
    loader: "tsx",
    resolveDir: web,
    contents: `
import {createRoot} from 'react-dom/client'; import React,{useState} from 'react';
import {CatalogContext,DataHubCatalogCards,DataHubCatalogDetail} from './components/DataHubCatalog';
import styles from './components/DataHubCatalog.module.css';
function Test(){const [selection,setSelection]=useState(null);const [draft,setDraft]=useState('原始草稿');const [value,setValue]=useState(null);
React.useEffect(()=>{fetch('/initial').then(r=>r.json()).then(setValue)},[]);
return <CatalogContext.Provider value={setSelection}><div className="datahub-workbench" style={{position:'relative',height:'100dvh',display:'flex',containerType:'inline-size'}}>
<main style={{width:'100%',overflow:'auto',padding:12,boxSizing:'border-box'}}><p id="message">Synthetic Catalog component/bridge — not live DataHub</p><DataHubCatalogCards value={value} pending={!value}/><label>Composer<input value={draft} onChange={e=>setDraft(e.target.value)}/></label></main>
{selection&&<div id="file-panel" className={'right-panel-container right-panel-open '+styles.panel}><div className={styles.slot}><DataHubCatalogDetail key={JSON.stringify(selection)} selection={selection} onClose={()=>{setSelection(null);setTimeout(()=>document.querySelector('main button').focus(),0)}} onQuote={text=>{setDraft(d=>d+text);setSelection(null)}}/></div><div>Existing Files content</div></div>}
</div></CatalogContext.Provider>};createRoot(document.getElementById('root')).render(<Test/>);`,
  },
});
const bridge = await readFile(
  `${root}extensions/datahub-agent/mfe/catalog.js`,
  "utf8",
);
const js = asset.outputFiles.find((f) => f.path.endsWith(".js")).contents;
const css = asset.outputFiles.find((f) => f.path.endsWith(".css")).contents;
const globals = await readFile(`${web}/app/globals.css`, "utf8");
const theme = await readFile(`${web}/app/datahub.css`, "utf8");
const server = createServer(async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.url === "/") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{border:0;width:100%;height:100dvh;display:block}</style><iframe title="Agent" src="/frame"></iframe><script type=module>import {installCatalogBridge} from '/bridge.js'; const frame=document.querySelector('iframe'); installCatalogBridge({frame,origin:location.origin,send:async(request,signal)=>{const r=await fetch('/query',{method:'POST',body:JSON.stringify(request),signal});return r.json()}})</script>`,
    );
  } else if (req.url === "/frame") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0}*{box-sizing:border-box}</style><link rel=stylesheet href=/globals.css><link rel=stylesheet href=/theme.css><link rel=stylesheet href=/app.css><div id=root></div><script src=/app.js></script>',
    );
  } else if (req.url === "/bridge.js") {
    res.setHeader("content-type", "application/javascript");
    res.end(bridge);
  } else if (req.url === "/app.js") {
    res.setHeader("content-type", "application/javascript");
    res.end(js);
  } else if (req.url === "/app.css") {
    res.setHeader("content-type", "text/css");
    res.end(css);
  } else if (req.url === "/globals.css") {
    res.setHeader("content-type", "text/css");
    res.end(globals);
  } else if (req.url === "/theme.css") {
    res.setHeader("content-type", "text/css");
    res.end(theme);
  } else if (req.url === "/initial") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(initial));
  } else if (req.url === "/query") {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      const value = await fixture.run(request);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    } catch (e) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});
let browser;
try {
  await mkdir(evidence, { recursive: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", (route) =>
    route
      .request()
      .url()
      .startsWith(origin + "/")
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const checks = [];
  for (const [width, containerWidth] of [
    [390, 390],
    [768, 768],
    [1280, 1280],
    [1440, 1440],
    [1440, 390],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    await page.locator("iframe").evaluate((node, size) => {
      node.style.width = `${size}px`;
    }, containerWidth);
    const frame = page.frameLocator("iframe");
    await frame
      .getByRole("button", { name: "查看詳情", exact: true })
      .waitFor();
    const before = await frame.locator("#message").boundingBox();
    await frame.getByRole("button", { name: "查看詳情", exact: true }).click();
    await frame.getByRole("heading", { name: "關於此資產" }).waitFor();
    assert.deepEqual(
      await frame.locator("#message").boundingBox(),
      before,
      "overlay must not move messages",
    );
    assert.equal(
      await frame.locator("main").evaluate((node) => node.inert),
      containerWidth < 1024,
    );
    assert.equal(
      await frame
        .locator('#file-panel [aria-label="DataHub 資產詳情"]')
        .getAttribute("role"),
      containerWidth < 1024 ? "dialog" : "complementary",
    );
    assert.ok(
      !(await frame.locator("#file-panel").innerText()).includes(
        "Existing Files content",
      ),
    );
    if (containerWidth < 640)
      assert.equal(
        (await frame.locator("#file-panel").boundingBox()).width,
        containerWidth,
        "small container must receive a full-width sheet",
      );
    assert.equal(
      await frame.locator("#file-panel script,#file-panel img").count(),
      0,
    );
    assert.equal(
      await frame.getByRole("tablist").getAttribute("aria-orientation"),
      "vertical",
    );
    await frame.getByRole("tab", { name: "欄位", exact: true }).click();
    await frame.getByRole("button", { name: "order_id", exact: true }).click();
    assert.match(
      await frame.locator("#file-panel").innerText(),
      /Reviewed field/,
    );
    await frame
      .getByRole("button", { name: "返回欄位清單", exact: false })
      .click();
    await frame.getByRole("tab", { name: "屬性", exact: true }).click();
    assert.match(await frame.locator("#file-panel").innerText(), /USD/);
    assert.ok(
      !(await frame.locator("#file-panel").innerText()).includes('"unit":'),
    );
    assert.ok(
      !(await frame.locator("#file-panel").innerText()).includes(
        "DO_NOT_EXPOSE",
      ),
    );
    await frame.getByRole("tab", { name: "血緣", exact: true }).click();
    await frame.getByRole("button", { name: "Summary", exact: true }).waitFor();
    await frame.getByRole("button", { name: "Summary", exact: true }).click();
    await frame.getByRole("heading", { name: "關於此資產" }).waitFor();
    assert.match(
      await frame.locator("#file-panel").innerText(),
      /Synthetic target/,
    );
    await frame
      .getByRole("button", { name: "返回上一層", exact: true })
      .click();
    await frame.getByRole("button", { name: "Summary", exact: true }).waitFor();
    await frame.getByRole("button", { name: "關係檢視", exact: true }).click();
    await page.screenshot({
      path: `${evidence}/catalog-${width}-${containerWidth}.png`,
      fullPage: true,
    });
    const actualFrame = page.frames().find((f) => f.url().endsWith("/frame"));
    assert.ok(
      await actualFrame.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await frame.getByRole("button", { name: "關閉詳情" }).focus();
    await page.keyboard.press("Escape");
    await frame.locator("#file-panel").waitFor({ state: "detached" });
    assert.equal(
      await frame.getByRole("textbox", { name: "Composer" }).inputValue(),
      "原始草稿",
    );
    assert.equal(
      await frame.locator("main").evaluate((node) => node.inert),
      false,
    );
    checks.push({
      width,
      containerWidth,
      cardDetail: true,
      readonlyProperties: true,
      verticalTabs: true,
      navigation: true,
      noRawJson: true,
      noMessageShift: true,
      modalBackgroundInert: true,
    });
  }
  // Fresh actor permission failure on opening a historical card must never show its stale payload as current.
  fixture.state.denied.add(datasetUrn);
  const frame = page.frameLocator("iframe");
  await frame.getByRole("button", { name: "查看詳情", exact: true }).click();
  await frame
    .getByText("無法取得此資產，或目前身分沒有讀取權限。", { exact: true })
    .waitFor();
  assert.ok(
    !(await frame.locator("#file-panel").innerText()).includes(
      "Reviewed field",
    ),
  );
  fixture.state.denied.clear();
  assert.deepEqual(errors, []);
  await writeFile(
    `${evidence}/result.json`,
    JSON.stringify(
      {
        scope:
          "synthetic component + MessageChannel + nativeCatalog fixture; not live acceptance",
        checks,
        deniedHistoricalRead: true,
        runtimeErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: ${checks.length} viewport component/bridge checks, safe denied history; not live DataHub acceptance`,
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
