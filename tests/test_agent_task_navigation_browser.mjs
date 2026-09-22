// Real browser + product gateway/bootstrap; synthetic identity/runtime, no model.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium } from "../extensions/datahub-agent/pi-web/node_modules/playwright/index.mjs";
import { createAgentGateway } from "../extensions/datahub-agent/integration/gateway.mjs";
import { isValidWebSessionToken } from "../extensions/datahub-agent/pi-web/lib/web-auth.ts";

const actor = {
  tenant: "fixture",
  urn: "urn:li:corpuser:alice",
  key: "a".repeat(48),
};
const sessionId = "00000000-0000-4000-8000-000000000020";
const password = "synthetic-navigation-fixture-password-only";
const forwarded = [];
let gatewayOrigin;
const runtime = createServer((request, response) => {
  assert(
    isValidWebSessionToken(
      request.headers.cookie?.replace(/^pi_web_session=/, ""),
      password,
    ),
  );
  forwarded.push(request.url);
  response.writeHead(200, {
    "content-type": "text/html",
    "cache-control": "no-store",
  });
  response.end("<!doctype html><h1>Private runtime fixture</h1>");
});
const parent = createServer((_request, response) => {
  response.writeHead(200, {
    "content-type": "text/html",
    "cache-control": "no-store",
  });
  response.end(`<!doctype html><iframe title="Agent"></iframe><script>
    window.ready=(async()=>{const r=await fetch('${gatewayOrigin}/agent/bootstrap',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}'});window.grant=await r.json();document.querySelector('iframe').src=grant.launchUrl;})();
  </script>`);
});
let gateway, browser;
try {
  for (const server of [runtime, parent]) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  gateway = await createAgentGateway({
    gatewayOrigin: "http://localhost:0",
    datahubOrigin: `http://localhost:${parent.address().port}`,
    mfeDirectory: fileURLToPath(
      new URL("../extensions/datahub-agent/mfe/dist/", import.meta.url),
    ),
    verifyIdentity: async () => actor,
    runtimeForActor: async () => ({
      origin: `http://127.0.0.1:${runtime.address().port}`,
      password,
    }),
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  gatewayOrigin = `http://localhost:${gateway.address().port}`;
  const ownOrigin = `http://${actor.key}.localhost:${gateway.address().port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext();
  await context.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === "localhost" || host.endsWith(".localhost")
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) =>
    console.log("fixture-pageerror", error.message),
  );
  page.on("response", (response) =>
    console.log(
      "fixture-response",
      response.status(),
      response.url().split(/[?#]/)[0],
    ),
  );
  let exchanges = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/agent/exchange") exchanges++;
  });
  await page.goto(`http://localhost:${parent.address().port}`);
  const privateHeading = page
    .frameLocator('iframe[title="Agent"]')
    .getByRole("heading", { name: "Private runtime fixture" });
  await privateHeading.waitFor();
  assert.equal(exchanges, 1);
  const navigate = (url) =>
    page.evaluate((target) => {
      document.querySelector("iframe").src = target;
    }, url);
  const expectStatus = async (url, status, destination = url) => {
    const reply = page.waitForResponse(
      (response) => response.url() === destination,
    );
    await navigate(url);
    assert.equal((await reply).status(), status);
  };
  const baseline = forwarded.length;
  await expectStatus(`${ownOrigin}/?session=${sessionId}`, 403);
  assert.equal(
    forwarded.length,
    baseline,
    "parent direct cross-site navigation stays rejected",
  );
  await navigate(`${ownOrigin}/bootstrap?session=${sessionId}`);
  await privateHeading.waitFor({ timeout: 5000 });
  const frame = await (
    await page.locator("iframe").elementHandle()
  ).contentFrame();
  assert.equal(new URL(frame.url()).searchParams.get("session"), sessionId);
  assert.equal(new URL(frame.url()).hash, "");
  assert.equal(forwarded.at(-1), `/?session=${sessionId}`);
  assert.equal(exchanges, 1, "navigation does not mint/exchange a grant");
  console.log(
    "PASS parent navigation via bootstrap, same private runtime, no new exchange",
  );

  // An invalid destination cannot become an open redirect or reach the runtime.
  const beforeInvalid = forwarded.length;
  await navigate(`${ownOrigin}/bootstrap?session=https://example.invalid/`);
  await page
    .frameLocator("iframe")
    .getByText("Agent login expired. Reopen Agent from DataHub.", {
      exact: true,
    })
    .waitFor();
  assert.equal(forwarded.length, beforeInvalid);
  await navigate(`${ownOrigin}/bootstrap?session=${sessionId}`);
  await privateHeading.waitFor();

  const wrongOrigin = `http://${"b".repeat(48)}.localhost:${gateway.address().port}`;
  const beforeWrong = forwarded.length;
  await expectStatus(
    `${wrongOrigin}/bootstrap?session=${sessionId}`,
    401,
    `${wrongOrigin}/?session=${sessionId}`,
  );
  assert.equal(forwarded.length, beforeWrong);
  const revokeStatus = await page.evaluate(async (origin) => {
    const r = await fetch(origin + "/agent/revoke", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantId: grant.grantId,
        revokeToken: grant.revokeToken,
      }),
    });
    return r.status;
  }, gatewayOrigin);
  assert.equal(revokeStatus, 200);
  const beforeRevoked = forwarded.length;
  await expectStatus(
    `${ownOrigin}/bootstrap?session=${sessionId}`,
    401,
    `${ownOrigin}/?session=${sessionId}`,
  );
  assert.equal(forwarded.length, beforeRevoked);
  console.log(
    "PASS invalid destination, wrong actor and revoked grant never reach private runtime",
  );
} finally {
  await browser?.close();
  for (const server of [gateway, parent, runtime])
    if (server?.listening) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
}
