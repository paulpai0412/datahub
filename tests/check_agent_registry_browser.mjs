import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "../extensions/datahub-agent/pi-web/node_modules/playwright/index.mjs";

const home = await mkdtemp(join(tmpdir(), "datahub-registry-browser-"));
const source = await readFile(new URL("../extensions/datahub-agent/mfe/registry.js", import.meta.url), "utf8");
const browser = await chromium.launch({
  executablePath: "/home/timmypai/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  headless: true, chromiumSandbox: true,
  env: { PATH: process.env.PATH, HOME: home },
});
try {
  const page = await browser.newPage();
  const calls = [];
  let denied = false;
  let release;
  let held;
  let finished;
  const name = "<img src=x onerror=alert(1)> Registry canary";
  await page.route("http://registry.test/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/registry.js") return route.fulfill({ contentType: "text/javascript", body: source });
    if (path === "/openapi/v3/entity/scroll") {
      calls.push({ body: request.postDataJSON(), headers: request.headers() });
      if (held) await held;
      try {
        await route.fulfill({ status: denied ? 403 : 200, contentType: "application/json", body: JSON.stringify(denied ? { secret: "must-not-render" } : { totalCount: 21, entities: [{ urn: "urn:li:aiAgent:canary", aiAgentInfo: { value: { name, description: "Metadata, not permission." }, systemMetadata: { version: "1" } }, aiAgentDependencies: { value: { tools: ["urn:li:api:canary"] } } }] }) });
      } finally { finished?.(); }
      return;
    }
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body style="margin:0;font:14px sans-serif"><main style="height:100dvh"><iframe title="Fixture chat" style="display:block;width:100%;height:100%;border:0"></iframe></main><script type="module">import{installRegistryView}from"/registry.js";window.stopRegistry=installRegistryView(document.querySelector("main"),document.querySelector("iframe"));</script></body></html>' });
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("http://registry.test/");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
    assert.equal(await page.locator("article img").count(), 0);
    assert.equal(await page.getByText("This is only the first page, not the complete registry.", { exact: true }).count(), 1);
    const bounds = await page.getByRole("button", { name: "Agents", exact: true }).boundingBox();
    assert.ok(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    assert.equal(await page.locator("iframe").isVisible(), true);
  }
  // The live Core sidebar leaves only 66px of MFE space at a 390px viewport.
  await page.locator("main").evaluate((main) => { main.style.width = "66px"; });
  for (const label of ["Chat", "Agents"]) {
    const box = await page.getByRole("button", { name: label, exact: true }).boundingBox();
    assert.ok(box.height >= 44 && box.width >= 44 && box.x + box.width <= 66, "Control overflows narrow Host");
  }
  await page.locator("main").evaluate((main) => { main.style.width = ""; });
  assert.deepEqual(calls[0].body, { entities: ["aiAgent"], aspects: ["aiAgentInfo", "aiAgentDependencies"] });
  assert.equal(calls[0].headers.authorization, undefined);
  denied = true;
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByText("Registry unavailable. Check your DataHub login and permissions, then reopen Agents.", { exact: true }).waitFor();
  assert.equal((await page.locator("body").innerText()).includes("must-not-render"), false);
  denied = false;
  held = new Promise((resolve) => { release = resolve; });
  const done = new Promise((resolve) => { finished = resolve; });
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByText("Loading Agent Registry…", { exact: true }).waitFor();
  await page.evaluate(() => window.stopRegistry());
  release();
  await done;
  assert.equal(await page.locator("article,nav,section").count(), 0);
  assert.equal(await page.locator("iframe").evaluate((frame) => frame.style.height), "100%");
  console.log("Registry browser fixture: 1440/390, native controls, text-only metadata, bounded-page notice, denial, cleanup PASS; not live DataHub.");
} finally {
  await browser.close();
  await rm(home, { recursive: true, force: true });
}
