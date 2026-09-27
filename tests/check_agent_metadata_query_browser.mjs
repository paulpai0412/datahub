// Complete local tool -> React Host bridge -> MFE -> metadata query Host ->
// dynamic dashboard -> sibling portal. Synthetic identity/source/Grafana only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createMetadataQueryHost } from "../extensions/datahub-agent/integration/metadata-query.mjs";
import {
  createQuerySource,
  queryBindings,
} from "../extensions/datahub-agent/integration/query-source.mjs";
import { buildQueryDashboard } from "../extensions/datahub-agent/integration/query-grafana.mjs";
import {
  actor,
  binding,
  metadata,
  plan,
  chart,
  context,
  grafana,
} from "./fixtures/query-fixture.mjs";
const root = resolve("extensions/datahub-agent/pi-web"),
  require = createRequire(join(root, "package.json"));
const { build } = require("esbuild"),
  { chromium } = require("playwright"),
  { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { default: sqlRegister } = await jiti.import(
  join(root, "lib/datahub-sql-extension.ts"),
);
const { default: grafanaRegister } = await jiti.import(
  join(root, "lib/datahub-grafana-extension.ts"),
);
let sqlTool, grafanaTool;
sqlRegister({
  registerTool(t) {
    sqlTool = t;
  },
});
grafanaRegister({
  registerTool(t) {
    grafanaTool = t;
  },
});
const dir = await mkdtemp(join(tmpdir(), "datahub-query-browser-"));
let browser,
  server,
  allowed = true,
  sourceCalls = 0,
  writes = 0;
const dashboards = new Map(),
  compiler = createQuerySource(),
  errors = [];
const host = createMetadataQueryHost({
  bindings: queryBindings([binding]),
  readMetadata: async () => {
    if (!allowed) throw Error("synthetic_metadata_revoked");
    return { snapshots: structuredClone(metadata), visible: async () => true };
  },
  source: {
    ...compiler,
    execute: async (p, m, b, c) => {
      sourceCalls++;
      const compiled = await compiler.compile(p, m, b, c);
      const measure = compiled.columns[1].name;
      return {
        columns: compiled.columns,
        sql: compiled.sql,
        rows: [
          {
            region: "NORTH_FIXTURE",
            [measure]: measure === "orders" ? "1" : "15.000000",
          },
          {
            region: "SOUTH_FIXTURE",
            [measure]: measure === "orders" ? "1" : "40.000000",
          },
        ],
        truncated: false,
        observedAt: "2026-09-26T00:00:00Z",
      };
    },
  },
  grafana,
  publishDashboard: async (args) => {
    writes++;
    dashboards.set(args.uid, buildQueryDashboard({ ...args, config: grafana }));
    return { dashboardUid: args.uid };
  },
  verifyIdentity: async () => actor,
});
const source = `import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';
import{DataHubHostBridge}from'./components/DataHubIngestionBridge';import{DataHubSqlCard}from'./components/DataHubSqlCard';import{DataHubGrafanaMessage,DataHubGrafanaPanel}from'./components/DataHubGrafanaPanel';import{GrafanaContext}from'./lib/grafana-context';import styles from'./components/DataHubGrafanaPanel.module.css';
function Shell(){const [request,setRequest]=useState(null),[receipt,setReceipt]=useState(null),[embed,setEmbed]=useState(null),[opened,setOpened]=useState(false),[expanded,setExpanded]=useState(false);useEffect(()=>{window.rpc=(title,placeholder)=>new Promise(resolve=>{window.rpcResolve=resolve;setRequest({id:crypto.randomUUID(),method:'input',title,placeholder});});window.showReceipt=setReceipt;window.showEmbed=x=>{setOpened(false);setEmbed(x);};},[]);return <GrafanaContext.Provider value={()=>setOpened(true)}><div style={{display:'flex',height:'100vh'}}><main style={{flex:1,overflow:'auto'}}><h2>合成查詢接線測試（非真資料）</h2>{receipt&&<DataHubSqlCard value={receipt} pending={false}/>}<DataHubGrafanaMessage value={embed} pending={false}/></main>{opened&&embed&&<aside id="file-panel" className={[styles.workspace,expanded?styles.expanded:''].join(' ')}><div className={styles.slot}><DataHubGrafanaPanel embed={embed} expanded={expanded} onExpandAction={()=>setExpanded(v=>!v)} onCloseAction={()=>setOpened(false)}/></div></aside>}{request&&<DataHubHostBridge request={request} onRespond={(_r,response)=>{setRequest(null);window.rpcResolve(response.value);}}/>}</div></GrafanaContext.Provider>};createRoot(document.getElementById('root')).render(<Shell/>);`;
try {
  await build({
    stdin: {
      contents: source,
      resolveDir: root,
      sourcefile: "query-fixture.tsx",
      loader: "tsx",
    },
    bundle: true,
    outfile: join(dir, "app.js"),
    alias: { "@": root },
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
    logLevel: "silent",
  });
  const grafanaBridge = await readFile(
      "extensions/datahub-agent/mfe/grafana.js",
      "utf8",
    ),
    sqlBridge = await readFile("extensions/datahub-agent/mfe/sql.js", "utf8");
  server = createServer(async (req, res) => {
    try {
      res.setHeader("cache-control", "no-store");
      if (["/sql", "/sql-result", "/grafana"].includes(req.url)) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const result = await (req.url === "/sql"
          ? host.execute(body, context)
          : req.url === "/sql-result"
            ? host.readResult(body, context)
            : host.request(body, context));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
        return;
      }
      if (req.url === "/grafana.js" || req.url === "/sql.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(req.url === "/grafana.js" ? grafanaBridge : sqlBridge);
        return;
      }
      if (req.url === "/app.js" || req.url === "/app.css") {
        res.setHeader(
          "content-type",
          req.url.endsWith("css") ? "text/css" : "text/javascript",
        );
        res.end(await readFile(join(dir, req.url.slice(1))));
        return;
      }
      if (req.url === "/pi") {
        res.end(
          '<!doctype html><head><link rel="stylesheet" href="/app.css"><style>body{margin:0;--bg:white;--bg-panel:#fafafa;--text:#111;--text-muted:#555;--border:#ccc;--accent:blue}button{min-height:36px}#file-panel{width:55%;height:100%;flex-shrink:0;background:white}</style></head><body><div id="root"></div><script src="/app.js"></script></body>',
        );
        return;
      }
      const port = server.address().port;
      res.end(
        `<!doctype html><style>body{margin:0}#pi{position:absolute;inset:40px 0 0;width:100%;height:calc(100% - 40px);border:0}</style><div id="host"><header>Trusted MFE fixture (no model / real source)</header><iframe id="pi" title="Pi fixture" src="http://actor.localhost:${port}/pi"></iframe></div><script type="module">import{installGrafanaBridge}from'/grafana.js';import{installSqlBridge}from'/sql.js';const frame=document.getElementById('pi');const send=async(path,input,signal)=>{const r=await fetch(path,{method:'POST',body:JSON.stringify(input),signal});return r.json()};installSqlBridge({frame,origin:'http://actor.localhost:${port}',execute:(x,s)=>send('/sql',x,s),readResult:(x,s)=>send('/sql-result',x,s)});installGrafanaBridge({container:document.getElementById('host'),frame,origin:'http://actor.localhost:${port}',grafanaOrigin:'http://localhost:3000',send:(x,s)=>send('/grafana',x,s)});</script>`,
      );
    } catch (e) {
      res
        .writeHead(403, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            error: /^query_[a-z_]+$/.test(e.message)
              ? e.message
              : "query_metadata_denied",
          }),
        );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  let frameLoads = 0;
  await page.route("http://localhost:3000/**", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get("theme"), "light");
    const dashboard = dashboards.get(url.pathname.slice(3));
    assert.ok(dashboard);
    frameLoads++;
    const rows = await host.read(url.searchParams.get("var-display"), {
      assertGrant() {},
      viewerLogin: "alice",
      orgId: "org-2",
    });
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body style="background:white;color:#111"><h1>SYNTHETIC_GRAFANA: ${dashboard.panels[0].type}</h1><button onclick="document.querySelector('p').textContent='Filtered synthetic rows'">Fixture filter</button><p>${JSON.stringify(rows)}</p></body>`,
    });
  });
  await page.goto(`http://localhost:${server.address().port}/`);
  const frame = await (
    await page.locator("#pi").elementHandle()
  ).contentFrame();
  await frame.waitForFunction(() => typeof window.rpc === "function");
  const toolContext = {
    mode: "rpc",
    ui: {
      input: (title, body) =>
        frame.evaluate(({ title, body }) => window.rpc(title, body), {
          title,
          body,
        }),
    },
  };
  const r = await sqlTool.execute(
    "browser",
    { plan, chart },
    undefined,
    undefined,
    toolContext,
  );
  assert.equal(r.details.state, "AVAILABLE");
  await frame.evaluate((x) => window.showReceipt(x), r.details);
  const g = await grafanaTool.execute(
    "browser",
    { resultRef: r.details.resultRef },
    undefined,
    undefined,
    toolContext,
  );
  await frame.evaluate((x) => window.showEmbed(x), g.details);
  const pi = page.frameLocator("#pi");
  assert.equal(frameLoads, 0);
  await pi.getByRole("button", { name: "查看產生的 SQL（不重執行）" }).click();
  await pi
    .getByLabel("產生的唯讀 SQL")
    .filter({ hasText: "LEFT OUTER JOIN" })
    .waitFor();
  assert.equal(sourceCalls, 1);
  await pi.getByRole("button", { name: "開啟儀表板" }).click();
  const portal = page.locator('iframe[title="Grafana 動態查詢儀表板"]');
  await portal.waitFor({ state: "visible" });
  assert.equal(
    new URL(await portal.getAttribute("src")).searchParams.get("theme"),
    "light",
  );
  assert.equal(await portal.evaluate((el) => el.parentElement.id), "host");
  const nested = page.frameLocator('iframe[title="Grafana 動態查詢儀表板"]');
  await nested.getByText("SYNTHETIC_GRAFANA: barchart").waitFor();
  await nested.getByRole("button", { name: "Fixture filter" }).click();
  await nested.getByText("Filtered synthetic rows").waitFor();
  await pi.getByRole("button", { name: "關閉", exact: true }).click();
  await portal.waitFor({ state: "detached" });
  const second = structuredClone(plan);
  second.select[1] = { field: null, aggregate: "count", as: "orders" };
  second.filters = [];
  second.orderBy = [{ field: "orders", direction: "desc" }];
  const r2 = await sqlTool.execute(
    "browser2",
    {
      plan: second,
      chart: { title: "不同查詢：各區訂單數", type: "stat", y: ["orders"] },
    },
    undefined,
    undefined,
    toolContext,
  );
  await frame.evaluate((x) => window.showReceipt(x), r2.details);
  const g2 = await grafanaTool.execute(
    "browser2",
    { resultRef: r2.details.resultRef },
    undefined,
    undefined,
    toolContext,
  );
  assert.notEqual(g2.details.dashboardUid, g.details.dashboardUid);
  await frame.evaluate((x) => window.showEmbed(x), g2.details);
  await pi.getByRole("button", { name: "開啟儀表板" }).click();
  await portal.waitFor({ state: "visible" });
  await nested.getByText("SYNTHETIC_GRAFANA: stat").waitFor();
  assert.equal(sourceCalls, 2);
  assert.equal(writes, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  // MFE positioning is delivered across frames on the next animation tick.
  await page.waitForFunction(() => {
    const r = document
      .querySelector('iframe[title="Grafana 動態查詢儀表板"]')
      ?.getBoundingClientRect();
    return r && r.width >= 380 && r.x >= 0 && r.right <= 391;
  });
  const bounds = await portal.boundingBox();
  assert.ok(
    bounds.width >= 380 && bounds.x >= 0 && bounds.x + bounds.width <= 391,
    JSON.stringify(bounds),
  );
  if (process.env.QUERY_EVIDENCE_DIR) {
    await mkdir(process.env.QUERY_EVIDENCE_DIR, {
      recursive: true,
      mode: 0o700,
    });
    const file = join(
      process.env.QUERY_EVIDENCE_DIR,
      "dynamic-light-synthetic.png",
    );
    await page.screenshot({ path: file });
    await chmod(file, 0o600);
  }
  await pi.getByRole("button", { name: "關閉", exact: true }).click();
  await portal.waitFor({ state: "detached" });
  allowed = false;
  await pi.getByRole("button", { name: "開啟儀表板" }).click();
  await pi.getByRole("status").filter({ hasText: "顯示權限失效" }).waitFor();
  assert.equal(await portal.count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      scope: "LOCAL_TOOLS_REACT_MFE_HOST_WITH_SYNTHETIC_DB_AND_GRAFANA",
      modelPrompts: 0,
      realSourceQueries: 0,
      syntheticQueries: sourceCalls,
      dynamicDashboards: writes,
      frameLoads,
      checks: [
        "composite-join",
        "different-query-and-chart",
        "SQL-preview-no-reexecute",
        "URL-light-theme",
        "same-site-portal",
        "interactive-frame",
        "mobile-clipping",
        "revoked-metadata-denial",
        "no-business-values-in-tools",
      ],
    }),
  );
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await rm(dir, { recursive: true, force: true });
}
