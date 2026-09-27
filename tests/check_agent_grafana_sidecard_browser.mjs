// Product React sidecard + MFE portal + display Host in a real Chromium browser.
// Synthetic identity/Grafana only; NOT the deployed /mfe/agent, model or MSSQL E2E.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import {
    createGrafanaHost,
    grafanaPolicies,
} from "../extensions/datahub-agent/integration/native-grafana.mjs";
const root = resolve("extensions/datahub-agent/pi-web");
const require = createRequire(join(root, "package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const dir = await mkdtemp(join(tmpdir(), "grafana-sidecard-"));
const key = "a".repeat(48);
const policy = {
    dashboardUid: "datahub-agent-sales-probe",
    datasetUrn: "urn:li:dataset:fixture",
    title: "TEST ONLY",
    viewerLogin: "fixture-viewer",
    orgId: 2,
    grafanaOrigin: "http://localhost:3000",
    expiresAt: Date.now() + 120000,
};
const policies = grafanaPolicies(
    { [key]: policy },
    { datahubOrigin: "http://localhost:9002" },
);
const resultRef = "33333333-3333-4333-8333-333333333333";
const sourceCard = {
    format: "datahub-sql.source-card/1",
    metric: "sales_by_category",
    datasetUrn: policy.datasetUrn,
    from: "2026-01-01",
    through: "2026-01-02",
    resultExpiresAt: Date.now() + 120000,
    points: [
        { month: "2026-01-01", category: "TEST_ONLY", salesAmount: "1.000000" },
    ],
};
let checks = 0,
    allowed = true;
const host = createGrafanaHost({
    policies,
    readSqlResult: async () => {
        checks++;
        if (!allowed) throw new Error("synthetic_acl_denied");
        return sourceCard;
    },
    verifyIdentity: async () => ({ key }),
});
const context = {
    actor: { key },
    cookieHeader: "synthetic",
    grantId: "44444444-4444-4444-8444-444444444444",
    assertActive() {},
};
const receipt = await host.request(
    JSON.stringify({
        action: "grafana_authorize",
        resultRef,
        requestId: "11111111-1111-4111-8111-111111111111",
    }),
    context,
);
const source = `import React,{useState} from 'react'; import{createRoot}from'react-dom/client';
import{DataHubGrafanaMessage,DataHubGrafanaPanel}from'./components/DataHubGrafanaPanel';
import{GrafanaContext}from'./lib/grafana-context';
import styles from './components/DataHubGrafanaPanel.module.css';
function TestShell(){const [opened,setOpened]=useState(false),[expanded,setExpanded]=useState(false),[session,setSession]=useState(1);return <GrafanaContext.Provider value={()=>setOpened(true)}>
<div style={{display:'flex',height:'100vh'}}><main style={{flex:1,overflow:'auto'}}><button onClick={()=>{setSession(s=>s+1);setOpened(false)}}>Switch session</button><DataHubGrafanaMessage value={${JSON.stringify(receipt)}} pending={false}/><div style={{height:1500}}>Chat keeps scrolling</div></main>
{opened&&<aside id="file-panel" className={[styles.workspace,expanded?styles.expanded:''].join(' ')}><div className={styles.slot}><DataHubGrafanaPanel key={session} embed={${JSON.stringify(receipt)}} expanded={expanded} onExpandAction={()=>setExpanded(x=>!x)} onCloseAction={()=>setOpened(false)}/></div></aside>}</div></GrafanaContext.Provider>};createRoot(document.getElementById('root')).render(<TestShell/>);`;
let browser, server;
const errors = [];
try {
    await build({
        stdin: {
            contents: source,
            resolveDir: root,
            sourcefile: "sidecard-fixture.tsx",
            loader: "tsx",
        },
        bundle: true,
        outfile: join(dir, "app.js"),
        alias: { "@": root },
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"test"' },
        logLevel: "silent",
    });
    const bridge = await readFile(
        "extensions/datahub-agent/mfe/grafana.js",
        "utf8",
    );
    server = createServer(async (req, res) => {
        try {
            if (req.url === "/authorize") {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const result = await host.request(
                    Buffer.concat(chunks).toString(),
                    context,
                );
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify(result));
                return;
            }
            if (req.url === "/bridge.js") {
                res.setHeader("content-type", "text/javascript");
                res.end(bridge);
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
                    '<!doctype html><html><head><link rel="stylesheet" href="/app.css"><style>body{margin:0;--bg:white;--bg-panel:#fafafa;--text:#111;--text-muted:#555;--border:#ccc;--accent:blue}button{min-height:36px}#file-panel{width:55%;height:100%;flex-shrink:0;background:white}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
                );
                return;
            }
            const port = server.address().port;
            res.end(
                `<!doctype html><style>body{margin:0}#pi{position:absolute;inset:40px 0 0;width:100%;height:calc(100% - 40px);border:0}</style><div id="host"><header>Trusted MFE fixture — no business data</header><iframe id="pi" title="Pi fixture" src="http://actor.localhost:${port}/pi"></iframe></div><script type="module">import{installGrafanaBridge}from'/bridge.js';const frame=document.getElementById('pi');window.stopBridge=installGrafanaBridge({container:document.getElementById('host'),frame,origin:'http://actor.localhost:${port}',grafanaOrigin:'http://localhost:3000',send:async(input,signal)=>{const r=await fetch('/authorize',{method:'POST',body:JSON.stringify(input),signal});if(!r.ok)throw Error();return r.json()}});</script>`,
            );
        } catch {
            res.writeHead(403).end('{"error":"grafana_scope_denied"}');
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
    });
    page.on("pageerror", (e) => errors.push(e.message));
    let grafanaLoads = 0;
    await page.route("http://localhost:3000/**", (route) => {
        grafanaLoads++;
        return route.fulfill({
            contentType: "text/html",
            body: "<h1>TEST_ONLY Grafana substitute</h1><button onclick=\"document.querySelector('p').textContent='Filtered synthetic data'\">Fixture filter</button><p>All synthetic data</p>",
        });
    });
    await page.goto(`http://localhost:${server.address().port}/`);
    const pi = page.frameLocator("#pi");
    await pi.getByRole("button", { name: "開啟儀表板" }).waitFor();
    assert.equal(
        grafanaLoads,
        0,
        "history rendering must not mount a datasource",
    );
    const preForgedChecks = checks;
    await page.evaluate(() => {
        const channel = new MessageChannel();
        window.dispatchEvent(
            new MessageEvent("message", {
                source: window,
                origin: location.origin,
                data: { type: "datahub-grafana-portal", body: "{}" },
                ports: [channel.port2],
            }),
        );
        channel.port1.close();
    });
    assert.equal(
        checks,
        preForgedChecks,
        "untrusted origin/source cannot ask Host for authorization",
    );
    await pi.getByRole("button", { name: "開啟儀表板" }).click();
    const portal = page.locator(
        'iframe[title="Grafana 來源聚合（尚未對帳既有面板）"]',
    );
    await portal.waitFor({ state: "visible" });
    const nested = page.frameLocator(
        'iframe[title="Grafana 來源聚合（尚未對帳既有面板）"]',
    );
    await nested.getByRole("button", { name: "Fixture filter" }).click();
    assert.equal(
        await nested.locator("p").textContent(),
        "Filtered synthetic data",
    );
    assert.equal(
        await portal.evaluate((el) => el.parentElement.id),
        "host",
        "must be a same-site MFE sibling, not nested Pi",
    );
    // A tiny layout affordance may cover a corner while the viewport's
    // central viewing area is visible. It must not blank the whole portal.
    await pi.locator('[aria-label="Grafana 同站視圖位置"]').evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cover = document.createElement("div");
        cover.id = "covered-viewport-corner";
        cover.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:3px;height:3px;z-index:10000;background:white`;
        document.body.append(cover);
    });
    await page.evaluate(
        () =>
            new Promise((done) =>
                requestAnimationFrame(() => requestAnimationFrame(done)),
            ),
    );
    await portal.waitFor({ state: "visible", timeout: 2000 });
    await pi.locator("#covered-viewport-corner").evaluate((el) => el.remove());
    await pi.locator('[aria-label="Grafana 同站視圖位置"]').evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cover = document.createElement("div");
        cover.id = "covered-viewport-center";
        cover.style.cssText = `position:fixed;left:${r.left + r.width / 2 - 12}px;top:${r.top + r.height / 2 - 12}px;width:24px;height:24px;z-index:10000;background:white`;
        document.body.append(cover);
    });
    await portal.waitFor({ state: "hidden", timeout: 2000 });
    await pi.locator("#covered-viewport-center").evaluate((el) => el.remove());
    await portal.waitFor({ state: "visible", timeout: 2000 });
    const before = await portal.boundingBox();
    await pi.getByRole("button", { name: "放大", exact: true }).click();
    await page.waitForFunction(
        (w) =>
            document
                .querySelector('iframe[title^="Grafana"]')
                ?.getBoundingClientRect().width > w,
        before.width + 100,
    );
    await pi.getByRole("button", { name: "還原", exact: true }).click();
    const loadCount = grafanaLoads;
    await pi.locator("main").evaluate((el) => (el.scrollTop = 300));
    assert.equal(grafanaLoads, loadCount, "scroll must not reload Grafana");
    await pi.getByRole("button", { name: "關閉", exact: true }).click();
    await portal.waitFor({ state: "detached" });
    await pi.locator("main").evaluate((el) => (el.scrollTop = 0));
    const firstChecks = checks;
    await pi.getByRole("button", { name: "開啟儀表板" }).click();
    await portal.waitFor({ state: "visible" });
    assert.ok(checks > firstChecks, "reopen rechecks native ACL");
    await pi.getByRole("button", { name: "Switch session" }).click();
    await portal.waitFor({ state: "detached" });
    await page.setViewportSize({ width: 390, height: 844 });
    await pi.getByRole("button", { name: "開啟儀表板" }).click();
    await portal.waitFor({ state: "visible" });
    const mobile = await portal.boundingBox();
    assert.ok(
        mobile.x >= 0 && mobile.x + mobile.width <= 391 && mobile.width >= 380,
        "mobile must fill available width",
    );
    await pi.getByRole("button", { name: "關閉", exact: true }).click();
    await portal.waitFor({ state: "detached" });
    allowed = false;
    await pi.getByRole("button", { name: "開啟儀表板" }).click();
    await pi.getByRole("status").filter({ hasText: "顯示權限失效" }).waitFor();
    assert.equal(await portal.count(), 0);
    await pi.getByRole("button", { name: "關閉", exact: true }).click();
    allowed = true;
    policies.set(
        key,
        Object.freeze({ ...policy, expiresAt: Date.now() + 900 }),
    );
    await pi.getByRole("button", { name: "開啟儀表板" }).click();
    await pi.getByRole("status").filter({ hasText: "顯示權限失效" }).waitFor();
    assert.equal(
        await portal.count(),
        0,
        "policy replacement invalidates an old displayRef",
    );
    assert.deepEqual(errors, []);
    console.log(
        JSON.stringify({
            passed: true,
            scope: "PRODUCT_COMPONENT_PORTAL_HOST_WITH_SYNTHETIC_BROWSER_FIXTURES",
            scenarios: [
                "history-no-mount",
                "sibling-portal",
                "interactive-iframe",
                "partially-covered-viewport-remains-visible",
                "center-occlusion-hides-portal",
                "expand-restore",
                "scroll-no-reload",
                "close",
                "reopen-reauthorization",
                "unmount",
                "mobile-clipping",
                "ACL-denial",
                "policy-replacement-invalidates-old-display",
            ],
            modelPrompts: 0,
            sourceQueries: 0,
            grafanaLoads,
            checks,
        }),
    );
} finally {
    await browser?.close();
    if (server) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
    }
    await rm(dir, { recursive: true, force: true });
}
