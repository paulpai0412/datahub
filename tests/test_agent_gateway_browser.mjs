import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import playwright from "../extensions/datahub-agent/pi-web/node_modules/playwright/index.js";
const { chromium } = playwright;
import { createAgentGateway } from "../extensions/datahub-agent/integration/gateway.mjs";
import { GrantError } from "../extensions/datahub-agent/integration/browser-grants.mjs";
import { isValidWebSessionToken } from "../extensions/datahub-agent/pi-web/lib/web-auth.ts";

// Actual Federation mount, gateway, HTTP proxy and browser cookies; synthetic
// identity/runtime fixtures only. Not DataHub SSO or pi-web product acceptance.
const actors = {
  alice: {
    tenant: "fixture",
    urn: "urn:li:corpuser:alice",
    key: "a".repeat(48),
  },
  bob: { tenant: "fixture", urn: "urn:li:corpuser:bob", key: "b".repeat(48) },
};
let gatewayPort;
let runtimeDelay = 0;
const upstreamRequests = [];
const runtime = createServer((request, response) => {
  upstreamRequests.push({
    path: request.url,
    cookie: request.headers.cookie,
    authorization: request.headers.authorization,
  });
  const actor = Object.values(actors).find((actor) =>
    isValidWebSessionToken(
      request.headers.cookie?.replace(/^pi_web_session=/, ""),
      `fixture-${actor.key}`,
    ),
  );
  if (!actor) {
    response.writeHead(401);
    response.end();
    return;
  }
  response.setHeader("cache-control", "no-store");
  if (request.url === "/api/fixture") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ key: actor.key }));
  } else if (request.url === "/api/download") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": "attachment; filename=fixture.txt",
    });
    response.end("Synthetic download fixture");
  } else {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>Runtime fixture</title><h1>Isolated runtime fixture</h1><a href="/api/download">Download fixture</a>',
    );
  }
});
const host = createServer((request, response) => {
  if (!["/alice", "/bob"].includes(request.url)) {
    response.writeHead(404);
    response.end();
    return;
  }
  const user = request.url === "/bob" ? "bob" : "alice";
  response.writeHead(200, {
    "content-type": "text/html",
    "set-cookie": `PLAY_SESSION=${user}; HttpOnly; SameSite=Lax; Path=/`,
    "cache-control": "no-store",
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>DataHub host fixture</title><main style="height:650px"></main><script src="http://localhost:${gatewayPort}/mfe/remoteEntry.js"></script><script>(async()=>{await datahubAgentMFE.init({});const factory=await datahubAgentMFE.get('./mount');window.unmountAgent=factory().mount(document.querySelector('main'));})();</script>`,
  );
});
for (const server of [runtime, host]) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}
const frontend = `http://localhost:${host.address().port}`;
const gateway = await createAgentGateway({
  gatewayOrigin: "http://localhost:0",
  datahubOrigin: frontend,
  mfeDirectory: fileURLToPath(
    new URL("../extensions/datahub-agent/mfe/dist/", import.meta.url),
  ),
  verifyIdentity: async (cookie) => {
    const name = /(?:^|;\s*)PLAY_SESSION=(alice|bob)(?:;|$)/.exec(
      cookie ?? "",
    )?.[1];
    if (!name) throw new GrantError();
    return actors[name];
  },
  runtimeForActor: async (actor) => {
    if (runtimeDelay)
      await new Promise((resolve) => setTimeout(resolve, runtimeDelay));
    return {
      origin: `http://127.0.0.1:${runtime.address().port}`,
      password: `fixture-${actor.key}`,
    };
  },
});
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
gatewayPort = gateway.address().port;
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
  const pageErrors = [];
  context.on("page", (page) =>
    page.on("pageerror", (error) => pageErrors.push(error.message)),
  );
  const page = await context.newPage();
  page.on("response", (response) =>
    console.log(
      "fixture-response",
      response.status(),
      response.url().split(/[?#]/)[0],
    ),
  );
  await page.clock.install();
  await page.goto(`${frontend}/alice`);
  await page
    .frameLocator('iframe[title="DataHub Agent"]')
    .getByRole("heading", { name: "Isolated runtime fixture" })
    .waitFor();
  const alice = page
    .frames()
    .find((frame) => frame.url().includes(`${actors.alice.key}.localhost`));
  assert.equal(new URL(alice.url()).hash, "");
  const own = await alice.evaluate(async () =>
    (await fetch("/api/fixture")).json(),
  );
  assert.equal(own.key, actors.alice.key);
  await alice.evaluate(() => localStorage.setItem("draft", "alice-private"));
  const downloadReady = page.waitForEvent("download");
  await alice.getByRole("link", { name: "Download fixture" }).click();
  const download = await downloadReady;
  assert.equal(download.suggestedFilename(), "fixture.txt");
  assert.equal(await download.failure(), null);

  // Same actor / same browser shares the cookie jar, but each mount has its own lease.
  const sibling = await context.newPage();
  await sibling.goto(`${frontend}/alice`);
  await sibling
    .frameLocator('iframe[title="DataHub Agent"]')
    .getByRole("heading", { name: "Isolated runtime fixture" })
    .waitFor();
  assert.equal(
    await alice.evaluate(async () => (await fetch("/api/fixture")).status),
    200,
  );
  const siblingRevoked = sibling.waitForResponse((response) =>
    response.url().endsWith("/agent/revoke"),
  );
  await sibling.evaluate(() => window.unmountAgent());
  assert.equal((await siblingRevoked).status(), 200);
  assert.equal(
    await alice.evaluate(async () => (await fetch("/api/fixture")).status),
    200,
    "closing a sibling tab must not invalidate this tab's shared browser cookie",
  );
  await sibling.close();

  // Keep a separate old-origin frame alive: removing the MFE alone is not revocation.
  await page.evaluate((origin) => {
    const probe = document.createElement("iframe");
    probe.id = probe.name = "old-origin-probe";
    probe.src = origin + "/bootstrap";
    document.body.append(probe);
  }, new URL(alice.url()).origin);
  await page.frameLocator("#old-origin-probe").getByRole("status").waitFor();
  const oldProbe = page.frame({ name: "old-origin-probe" });
  assert.equal(
    await oldProbe.evaluate(async () => (await fetch("/api/fixture")).status),
    200,
  );

  const second = await context.newPage();
  await second.goto(`${frontend}/bob`);
  await second
    .frameLocator('iframe[title="DataHub Agent"]')
    .getByRole("heading", { name: "Isolated runtime fixture" })
    .waitFor();
  const bob = second
    .frames()
    .find((frame) => frame.url().includes(`${actors.bob.key}.localhost`));
  assert.equal(await bob.evaluate(() => localStorage.getItem("draft")), null);
  assert.equal(
    (await bob.evaluate(async () => (await fetch("/api/fixture")).json())).key,
    actors.bob.key,
  );
  // The old parent now presents Bob's DataHub cookie: its Alice lease must not renew.
  await page.clock.fastForward(20000);
  await page
    .getByRole("status")
    .filter({ hasText: "Agent could not open" })
    .waitFor();
  assert.equal(await page.locator('iframe[title="DataHub Agent"]').count(), 0);
  assert.equal(
    await oldProbe.evaluate(async () => (await fetch("/api/fixture")).status),
    401,
    "account switch must revoke the old cookie, not merely remove the MFE",
  );
  await page.evaluate(() =>
    document.querySelector("#old-origin-probe").remove(),
  );

  await second.evaluate((origin) => {
    const probe = document.createElement("iframe");
    probe.id = probe.name = "logout-probe";
    probe.src = origin + "/bootstrap";
    document.body.append(probe);
  }, new URL(bob.url()).origin);
  await second.frameLocator("#logout-probe").getByRole("status").waitFor();
  const logoutProbe = second.frame({ name: "logout-probe" });
  assert.equal(
    await logoutProbe.evaluate(
      async () => (await fetch("/api/fixture")).status,
    ),
    200,
  );
  await context.clearCookies({ name: "PLAY_SESSION" });
  const logoutRevoke = second.waitForResponse((response) =>
    response.url().endsWith("/agent/revoke"),
  );
  await second.evaluate(() => window.unmountAgent());
  assert.equal(
    (await logoutRevoke).status(),
    200,
    "cleanup must work after the DataHub cookie is gone",
  );
  assert.equal(
    await logoutProbe.evaluate(
      async () => (await fetch("/api/fixture")).status,
    ),
    401,
  );
  await second.evaluate(() => document.querySelector("#logout-probe").remove());
  assert.equal(await second.locator("iframe").count(), 0);
  // Fresh cookie jar + delayed responses reproduce competing Set-Cookie writes.
  const parallelContext = await browser.newContext();
  await parallelContext.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "localhost" && !url.hostname.endsWith(".localhost"))
      return route.abort();
    // Explicit negative-control probe only; never changes the deployed script.
    if (
      process.env.AGENT_TEST_UNLOCKED_BOOTSTRAP === "1" &&
      url.pathname === "/agent-bootstrap.js"
    ) {
      try {
        // Playwright's Node HTTP client does not resolve Chromium's *.localhost.
        const response = await route.fetch({
          url: `http://127.0.0.1:${gatewayPort}${url.pathname}`,
          headers: { ...route.request().headers(), host: url.host },
        });
        const original = await response.text();
        const unlocked = original
          .replace(
            "await navigator.locks.request('datahub-agent-exchange',{signal},async()=>{",
            "await (async()=>{",
          )
          .replace("await r.arrayBuffer()});", "await r.arrayBuffer()})();");
        assert.notEqual(unlocked, original);
        return await route.fulfill({ response, body: unlocked });
      } catch {
        return route.abort(); // Main scenario fails normally and its finally owns cleanup.
      }
    }
    return route.continue();
  });
  const peers = await Promise.all([
    parallelContext.newPage(),
    parallelContext.newPage(),
  ]);
  const exchanges = peers.map((peer) =>
    peer.waitForResponse((response) =>
      response.url().endsWith("/agent/exchange"),
    ),
  );
  runtimeDelay = 1000;
  await Promise.all(
    peers.map(async (peer) => {
      await peer.goto(`${frontend}/alice`);
      await peer
        .frameLocator('iframe[title="DataHub Agent"]')
        .getByRole("heading", { name: "Isolated runtime fixture" })
        .waitFor();
    }),
  );
  runtimeDelay = 0;
  const cookies = await Promise.all(
    exchanges.map(async (pending) => {
      const headers = await (await pending).allHeaders();
      return /^datahub_agent_session=([^;]+)/.exec(headers["set-cookie"])?.[1];
    }),
  );
  const cookie = (await parallelContext.cookies()).find(
    (item) => item.name === "datahub_agent_session",
  );
  const winner = cookies.lastIndexOf(cookie?.value);
  assert.ok(winner >= 0);
  const closed = peers[winner].waitForResponse((response) =>
    response.url().endsWith("/agent/revoke"),
  );
  await peers[winner].evaluate(() => window.unmountAgent());
  assert.equal((await closed).status(), 200);
  const survivor = peers[1 - winner]
    .frames()
    .find((frame) => frame.url().includes(`${actors.alice.key}.localhost`));
  assert.equal(
    await survivor.evaluate(async () => (await fetch("/api/fixture")).status),
    200,
    "concurrent fresh tabs must share a cookie without one lease revoking the other",
  );
  await peers[1 - winner].evaluate(() => window.unmountAgent());
  await parallelContext.close();
  assert.ok(upstreamRequests.length >= 5);
  assert.ok(
    upstreamRequests.every(
      (request) =>
        request.cookie?.startsWith("pi_web_session=") &&
        !request.cookie.includes("PLAY_SESSION") &&
        request.authorization === undefined,
    ),
  );
  assert.deepEqual(pageErrors, []);
  console.log(
    JSON.stringify({
      browser: browser.version(),
      federation: "PASS",
      bootstrapCookie: "PASS",
      proxy: "PASS",
      download: "PASS",
      separateStorage: "PASS",
      sameActorSiblingCleanup: "PASS",
      concurrentFirstExchange: "PASS",
      accountSwitchHeartbeat: "PASS",
      oldCookieRevoked: "PASS",
      logoutCleanup: "PASS",
      cleanup: "PASS",
      limitation:
        "Synthetic identity/runtime; not live DataHub SSO, pi-web UI, containers, models or ingestion",
    }),
  );
} finally {
  await browser?.close();
  for (const server of [gateway, host, runtime]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
