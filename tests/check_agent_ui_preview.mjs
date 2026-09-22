import assert from "node:assert/strict";
import { once } from "node:events";
import { get } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import playwright from "../extensions/datahub-agent/pi-web/node_modules/playwright/index.js";
import { createAgentUiPreview } from "../scripts/preview-agent-ui.mjs";

// Visual/interaction evidence for a disconnected prototype, not Pi/DataHub E2E.
const evidence = resolve(".local/evidence/agent-ui-v0");
await mkdir(evidence, { recursive: true });
const server = await createAgentUiPreview();
let browser;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of [
    "/api/sessions",
    "/agent/bootstrap",
    "/.local/datahub-pat",
    "/assets/../index.html",
    "/index.html?x=1",
  ]) {
    // Raw paths are used so the client does not normalize the traversal probe.
    const response = await new Promise((resolveResponse, reject) => {
      get(
        { hostname: "127.0.0.1", port: server.address().port, path },
        (result) => {
          result.resume();
          resolveResponse(result.statusCode);
        },
      ).on("error", reject);
    });
    assert.equal(response, 404, path);
  }
  assert.equal((await fetch(origin, { method: "POST" })).status, 404);
  const response = await fetch(origin, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-security-policy"),
    /connect-src 'none'/,
  );
  assert.match(
    response.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );

  browser = await playwright.chromium.launch({
    headless: true,
    chromiumSandbox: true,
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const errors = [];
  const requests = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.origin !== origin) {
      errors.push(`external request: ${url.origin}`);
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", (result) => {
    if (result.status() >= 400)
      errors.push(`${result.status()}: ${result.url()}`);
  });
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
    [768, 1024],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `${width}: horizontal overflow`,
    );
    const frame = await page.locator(".agent-frame").boundingBox();
    assert.ok(
      frame.width > width / 2,
      `${width}: workspace collapsed into hidden navigation column`,
    );
    assert.equal(await page.locator("#message").getAttribute("readonly"), "");
    assert.equal(
      await page
        .getByRole("button", { name: "Send", exact: true })
        .isDisabled(),
      true,
    );
    if (width === 390) {
      for (const button of await page
        .locator(".chat-toolbar button, .composer-tools button")
        .all()) {
        assert.ok(
          (await button.boundingBox()).height >= 44,
          "mobile touch target",
        );
      }
    }
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/chat-${width}.png`,
    });

    await page.locator("#history-button").click();
    assert.equal(
      await page.locator("#history-dialog").evaluate((element) => element.open),
      true,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .locator("#history-button")
        .evaluate((element) => element === document.activeElement),
      true,
      "history focus return",
    );
    await page.locator("#workspace-button").click();
    assert.equal(await page.locator("#workspace-drawer").isVisible(), true);
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/workspace-${width}.png`,
    });
    await page
      .getByRole("button", { name: "Close history and workspace" })
      .click();
    assert.equal(
      await page
        .locator("#workspace-button")
        .evaluate((element) => element === document.activeElement),
      true,
      "workspace focus return",
    );

    await page.locator("#details-button").click();
    await page.locator('[data-detail="terminal"]').click();
    assert.equal(await page.locator("#terminal-detail").isVisible(), true);
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/details-${width}.png`,
    });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#details").isVisible(), false);
    assert.equal(
      await page
        .locator("#details-button")
        .evaluate((element) => element === document.activeElement),
      true,
    );

    await page.locator("#settings-button").click();
    for (const name of [
      "general",
      "models",
      "skills",
      "mcp",
      "profiles",
      "plugins",
    ]) {
      await page.locator(`[data-setting="${name}"]`).click();
      assert.equal(await page.locator(`#${name}-setting`).isVisible(), true);
    }
    await page.locator('[data-setting="models"]').click();
    assert.equal(await page.locator("#model-key").isDisabled(), true);
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/models-${width}.png`,
    });
    await page.locator("#sources-button").click();
    assert.equal(await page.locator("#sources-page").isVisible(), true);
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/sources-${width}.png`,
    });
    await page.locator("#workspace-button").click();
    assert.equal(
      await page.locator("#workspace-drawer").isVisible(),
      true,
      "workspace reachable from sources",
    );
    await page.keyboard.press("Escape");
    console.log(
      `PASS ${width}x${height}: pages, drawers, details, keyboard focus, disabled controls, screenshots`,
    );
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator("#workspace-button")
      .evaluate((element) => getComputedStyle(element).transitionDuration),
    "0s",
  );
  assert.equal(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  assert.equal((await context.cookies()).length, 0);
  assert.equal(
    requests.some(
      (path) => path.startsWith("/api/") || path.startsWith("/agent/"),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        browser: browser.version(),
        origin,
        requests: [...new Set(requests)],
        errors,
        scope: "Disconnected UI v0 only; no DataHub/Pi/model acceptance",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}
