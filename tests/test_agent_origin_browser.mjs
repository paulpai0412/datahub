import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import playwright from "../extensions/datahub-agent/pi-web/node_modules/playwright/index.js";
const { chromium } = playwright;

// Browser-only isolation spike. Synthetic cookies, no DataHub login or model calls.
const keys = ["a".repeat(48), "b".repeat(48)];
const server = createServer((request, response) => {
  const host = request.headers.host;
  const key = host.split(".")[0];
  response.setHeader("cache-control", "no-store");
  if (request.url === "/frame") {
    response.setHeader(
      "set-cookie",
      `agent_session=synthetic-${key}; HttpOnly; SameSite=None; Secure; Partitioned; Path=/`,
    );
    response.setHeader("content-type", "text/html");
    response.end(
      "<!doctype html><title>Isolated fixture</title><p>Origin isolation fixture</p>",
    );
  } else if (request.url === "/probe") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
  } else if (request.url === "/sw.js") {
    response.setHeader("content-type", "application/javascript");
    response.end(
      "self.addEventListener('install',()=>self.skipWaiting()); self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));",
    );
  } else {
    response.setHeader("content-type", "text/html");
    const port = server.address().port;
    response.end(
      `<!doctype html><title>DataHub host fixture</title>${keys.map((key) => `<iframe title="${key}" src="http://${key}.localhost:${port}/frame" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>`).join("")}`,
    );
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "localhost" || url.hostname.endsWith(".localhost")
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${server.address().port}/`, {
    waitUntil: "networkidle",
  });
  const frames = keys.map((key) =>
    page.frames().find((frame) => frame.url().includes(`${key}.localhost`)),
  );
  assert.ok(frames.every(Boolean));
  for (const [index, frame] of frames.entries()) {
    const result = await frame.evaluate(async () => ({
      secure: isSecureContext,
      ...(await (await fetch("/probe")).json()),
    }));
    assert.equal(result.secure, true);
    assert.equal(result.cookie, `agent_session=synthetic-${keys[index]}`);
  }
  await frames[0].evaluate(async () => {
    localStorage.setItem("draft", "alice-only");
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const cache = await caches.open("private-fixture");
    await cache.put("/private", new Response("alice-only"));
  });
  const other = await frames[1].evaluate(async () => ({
    draft: localStorage.getItem("draft"),
    caches: await caches.keys(),
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  assert.deepEqual(other, { draft: null, caches: [], registrations: 0 });
  console.log(
    JSON.stringify({
      browser: browser.version(),
      cookie: "PASS",
      localStorage: "PASS",
      serviceWorker: "PASS",
      cache: "PASS",
      limitation:
        "Synthetic localhost fixture, not live DataHub SSO, logout, OAuth or full pi-web",
    }),
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
