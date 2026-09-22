// Real production pi-web + gateway + container + browser. Synthetic DataHub
// identity only. No model calls, source DB/GMS writes or developer credentials.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../extensions/datahub-agent/pi-web/node_modules/playwright/index.js";
import { createRuntimeManager } from "../extensions/datahub-agent/integration/runtime-manager.mjs";
import { createAgentGateway } from "../extensions/datahub-agent/integration/gateway.mjs";
import { GrantError } from "../extensions/datahub-agent/integration/browser-grants.mjs";

const exec = promisify(execFile);
const imageId = process.env.AGENT_RUNTIME_IMAGE;
const expectSkin = process.env.AGENT_EXPECT_DATAHUB_SKIN === "1";
const expectMcp = process.env.AGENT_EXPECT_MCP_SETTINGS === "1";
assert.match(imageId ?? "", /^sha256:[a-f0-9]{64}$/);
assert.ok(
  process.env.AGENT_BROWSER_ASSETS,
  "explicit immutable browser artifact directory required",
);
const scope = `pi-test-${randomBytes(6).toString("hex")}`;
const evidence =
  process.env.AGENT_BROWSER_EVIDENCE ??
  fileURLToPath(
    new URL("../.local/evidence/agent-isolation/", import.meta.url),
  );
await mkdir(evidence, { recursive: true });
const actors = Object.fromEntries(
  ["alice", "bob"].map((name) => {
    const tenant = "pi-web-browser-fixture",
      urn = `urn:li:corpuser:${name}`;
    const key = createHash("sha256")
      .update(JSON.stringify([tenant, urn]))
      .digest("hex")
      .slice(0, 48);
    return [name, { tenant, urn, key }];
  }),
);
async function docker(args) {
  try {
    return (
      await exec("docker", args, { timeout: 30000, maxBuffer: 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw new Error("pi_browser_docker_operation_failed");
  }
}
async function seed(name) {
  const who = actors[name];
  const owner = createHash("sha256")
    .update(JSON.stringify([who.tenant, who.urn]))
    .digest("hex");
  const container = await docker([
    "ps",
    "-q",
    "--filter",
    `label=datahub.agent.scope=${scope}`,
    "--filter",
    `label=datahub.agent.owner=${owner}`,
  ]);
  assert.match(container, /^[a-f0-9]{12,64}$/);
  // Only known synthetic session data in a newly created test HOME.
  await docker([
    "exec",
    container,
    "node",
    "--input-type=module",
    "-e",
    `
    import {mkdir,writeFile} from 'node:fs/promises';
    const name=${JSON.stringify(name)};
    const cwd='/home/node/workspace';
    await mkdir(cwd,{recursive:true});
    await writeFile(cwd+'/note.txt',name+' isolated file fixture');
    await writeFile(cwd+'/large.bin',Buffer.alloc(4*1024*1024,name==='alice'?42:43));
    const dir='/home/node/.pi/agent/sessions/test';
    await mkdir(dir,{recursive:true});
    const timestamp='2026-09-10T00:00:00.000Z';
    await writeFile(dir+'/'+name+'.jsonl',[
      {type:'session',version:3,id:name,timestamp,cwd},
      {type:'session_info',id:'name',parentId:null,timestamp,name:name+' fixture'},
      {type:'message',id:'message',parentId:'name',timestamp,message:{role:'user',content:name+' synthetic session'}}
    ].map(x=>JSON.stringify(x)).join('\\n')+'\\n');
  `,
  ]);
}
async function stop(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
let manager, gateway, host, browser;
let gatewayPort;
const consoleErrors = [],
  failedRequests = [];
function observe(page) {
  page.on("console", (message) => {
    if (message.type() === "error")
      consoleErrors.push(
        message
          .text()
          .replace(/#[A-Za-z0-9_-]{32,}/g, "#[redacted]")
          .slice(0, 2000),
      );
  });
  page.on("requestfailed", (request) =>
    failedRequests.push({
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText,
    }),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      failedRequests.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });
}
try {
  console.log(
    JSON.stringify({
      scope,
      imageId,
      limitation:
        "Real pi-web; synthetic DataHub identity, no model or ingestion",
    }),
  );
  manager = await createRuntimeManager({
    scope,
    imageId,
    memoryMiB: 1024,
    cpus: 1,
  });
  for (const name of ["alice", "bob"]) {
    await manager.forActor(actors[name]);
    await seed(name);
  }
  host = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>DataHub identity fixture</title></head><body style="margin:0;height:100vh"><div id="agent" style="height:100vh"></div><script src="http://localhost:${gatewayPort}/mfe/remoteEntry.js"></script><script>(async()=>{await datahubAgentMFE.init({}); const factory=await datahubAgentMFE.get('./mount'); window.unmountAgent=factory().mount(document.querySelector('#agent'));})().catch(e=>console.error(e));</script></body></html>`,
    );
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const datahubOrigin = `http://localhost:${host.address().port}`;
  gateway = await createAgentGateway({
    gatewayOrigin: "http://localhost:0",
    datahubOrigin,
    mfeDirectory: fileURLToPath(
      new URL("../extensions/datahub-agent/mfe/dist/", import.meta.url),
    ),
    browserAssetsDirectory: process.env.AGENT_BROWSER_ASSETS,
    runtimeForActor: (actor) => manager.forActor(actor),
    verifyIdentity: async (cookie) => {
      const match = Object.entries(actors).find(
        ([name]) => cookie === `PLAY_SESSION=${name}`,
      );
      if (!match) throw new GrantError();
      return match[1];
    },
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  gatewayPort = gateway.address().port;
  browser = await playwright.chromium.launch({ chromiumSandbox: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "127.0.0.1"
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  observe(page);
  const errors = [],
    created = new Set();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/terminal" &&
      request.method() === "POST"
    )
      created.add(request.postDataJSON().id);
  });
  await context.addCookies([
    {
      name: "PLAY_SESSION",
      value: "alice",
      url: datahubOrigin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  // Wait for the completed exchange/redirect, not merely iframe attachment.
  const [runtimeFrame] = await Promise.all([
    page.waitForEvent("framenavigated", {
      predicate: (frame) =>
        frame.url().split("?", 1)[0] ===
        `http://${actors.alice.key}.localhost:${gatewayPort}/`,
    }),
    page.goto(datahubOrigin),
  ]);
  await runtimeFrame.waitForLoadState("load");
  await runtimeFrame.waitForFunction(
    () => navigator.serviceWorker.controller !== null,
  );
  await runtimeFrame.goto(
    `http://${actors.alice.key}.localhost:${gatewayPort}/?session=alice`,
  );
  await runtimeFrame
    .getByText("alice synthetic session", { exact: true })
    .waitFor();
  assert.deepEqual(
    await runtimeFrame.evaluate(async () =>
      (await fetch("/api/web-auth")).json(),
    ),
    { enabled: true, authenticated: true },
  );
  if (expectSkin) {
    assert.equal(
      await page
        .locator("#agent")
        .evaluate((e) => e.getBoundingClientRect().height),
      900,
      "fixture must give the MFE a definite full-height parent",
    );
    // Registry/Tasks own part of that parent; the iframe occupies the remainder.
    const frameBox = await page
      .locator('iframe[title="DataHub Agent"]')
      .boundingBox();
    assert(
      frameBox && frameBox.height > 0 && frameBox.y + frameBox.height <= 900,
    );
    assert.equal(
      await runtimeFrame.evaluate(() => innerHeight),
      Math.round(frameBox.height),
    );
    assert.equal(
      await runtimeFrame.locator("html").getAttribute("data-datahub"),
      "true",
    );
    assert.equal(
      await runtimeFrame.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--accent")
          .trim(),
      ),
      "#533fd1",
    );
    await runtimeFrame
      .getByRole("heading", { name: "Agent", exact: true })
      .waitFor();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const workspace = runtimeFrame.getByRole("button", {
        name: "Workspace",
        exact: true,
      });
      await workspace.click();
      await runtimeFrame
        .getByRole("button", {
          name: "Close History and Workspace",
          exact: true,
        })
        .waitFor();
      await page.keyboard.press("Escape");
      await runtimeFrame.waitForFunction(
        () => document.querySelector("#session-sidebar").inert,
      );
      assert.equal(
        await workspace.evaluate(
          (element) => element === document.activeElement,
        ),
        true,
        "return focus to actual drawer opener",
      );
      assert.equal(
        await runtimeFrame.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "no horizontal overflow",
      );
      assert.equal(
        await runtimeFrame
          .locator("textarea")
          .first()
          .evaluate(
            (element) =>
              element.getBoundingClientRect().bottom > innerHeight - 160,
          ),
        true,
        "composer stays at workspace bottom",
      );
      await page.screenshot({
        path: `${evidence}/skin-chat-${width}.png`,
        animations: "disabled",
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const settingsOpener = runtimeFrame
      .locator(".datahub-header")
      .getByRole("button", { name: "Settings", exact: true });
    await settingsOpener.focus();
    await settingsOpener.press("Enter");
    const settings = runtimeFrame.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await settings.waitFor();
    assert(
      await settings.evaluate((e) => e.contains(document.activeElement)),
      "Settings receives focus on open",
    );
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "hidden" });
    assert(
      await settingsOpener.evaluate((e) => e === document.activeElement),
      "Escape returns focus to actual Settings opener",
    );
    await settingsOpener.press("Enter");
    await settings
      .getByRole("button", { name: "General", exact: true })
      .click();
    await settings
      .getByText("DataHub theme · Deployment controlled.", { exact: false })
      .waitFor();
    await settings.getByRole("button", { name: "Models", exact: true }).click();
    await page.screenshot({
      path: `${evidence}/skin-models.png`,
      animations: "disabled",
    });
    if (expectMcp) {
      await settings.getByRole("button", { name: "MCP", exact: true }).click();
      const editor = settings.getByLabel("MCP server config (JSON)");
      await editor.waitFor();
      const config = {
        settings: { hostConfigDiscovery: "off" },
        mcpServers: {
          fixture: {
            command: "node",
            args: ["disabled-fixture.mjs"],
            disabled: true,
            env: { FIXTURE: "alice-only" },
          },
        },
      };
      await editor.fill("{");
      await settings
        .getByRole("button", { name: "Save config", exact: true })
        .click();
      await settings
        .getByRole("status")
        .filter({ hasText: "Invalid JSON" })
        .waitFor();
      await editor.fill(JSON.stringify(config, null, 2));
      await settings
        .getByRole("button", { name: "Save config", exact: true })
        .click();
      await settings
        .getByRole("status")
        .filter({ hasText: "Saved." })
        .waitFor();
      const saved = await runtimeFrame.evaluate(async () =>
        (await fetch("/api/mcp-config")).json(),
      );
      assert.deepEqual(saved.config, config);
      assert.match(saved.revision, /^[a-f0-9]{64}$/);
      assert.equal(
        await runtimeFrame.evaluate(
          async (config) =>
            (
              await fetch("/api/mcp-config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ config, revision: "stale" }),
              })
            ).status,
          config,
        ),
        409,
      );
      await settings
        .getByRole("button", { name: "Reload current session", exact: true })
        .click();
      await settings
        .getByRole("status")
        .filter({ hasText: "Session reloaded." })
        .waitFor();
      await page.screenshot({
        path: `${evidence}/skin-mcp.png`,
        animations: "disabled",
      });
      console.log(
        "Native MCP settings: invalid JSON, save/readback, stale revision, real session reload PASS; disabled fixture only",
      );
    }
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    assert(
      await settingsOpener.evaluate((e) => e === document.activeElement),
      "Close returns focus after real settings subpanels and native reload",
    );
    console.log(
      "DataHub skin: real header/theme/drawer/Escape/focus/Settings/Models + 3 viewport checks PASS; no model call",
    );
  }
  const sidebar = runtimeFrame.getByRole("button", {
    name: "Show sidebar",
    exact: true,
  });
  if (await sidebar.count()) await sidebar.click();
  await runtimeFrame
    .getByRole("button", { name: "Open workspace terminal", exact: true })
    .click();
  await runtimeFrame.locator(".terminal-panel:visible .is-ready").waitFor();
  await runtimeFrame
    .locator(".terminal-panel:visible .xterm-helper-textarea")
    .focus();
  await page.keyboard.type(
    "printf '\\nDHA_HOME=%s\\n' \"$HOME\"; printf '\\nDHA_PTY_OK\\n'",
  );
  await page.keyboard.press("Enter");
  await runtimeFrame.waitForFunction(() =>
    document
      .querySelector(".terminal-panel .xterm-rows")
      ?.textContent?.includes("DHA_HOME=/home/node"),
  );
  assert.equal(created.size, 1);
  await page.screenshot({
    path: `${evidence}/real-pi-web-terminal.png`,
    fullPage: true,
  });
  console.log(
    "native page auth / seeded session / real PTY over reverse HTTP: PASS",
  );
  const hide = runtimeFrame.locator("#file-panel").getByRole("button", {
    name: "Hide file panel",
    exact: true,
    includeHidden: true,
  });
  if ((await hide.getAttribute("aria-expanded")) === "true") await hide.click();
  if (await sidebar.count()) await sidebar.click();
  await runtimeFrame.getByText("note.txt", { exact: true }).click();
  await runtimeFrame
    .getByText("alice isolated file fixture", { exact: true })
    .waitFor();
  assert.equal(
    await runtimeFrame.evaluate(
      async () => (await fetch("/api/models-config")).status,
    ),
    200,
  );
  const transfer = await runtimeFrame.evaluate(async () => {
    const file = await fetch(
      "/api/files/home/node/workspace/large.bin?type=download",
    );
    const bytes = new Uint8Array(await file.arrayBuffer());
    const form = new FormData();
    form.append("files", new Blob([bytes]), "uploaded.bin");
    const upload = await fetch("/api/files/home/node/workspace?type=upload", {
      method: "POST",
      body: form,
    });
    const roundTrip = await fetch(
      "/api/files/home/node/workspace/uploaded.bin?type=download",
    );
    const uploaded = new Uint8Array(await roundTrip.arrayBuffer());
    return {
      download: file.status,
      upload: upload.status,
      readback: roundTrip.status,
      bytes: bytes.length,
      uploadedBytes: uploaded.length,
      intact: bytes.every((b) => b === 42) && uploaded.every((b) => b === 42),
    };
  });
  assert.deepEqual(transfer, {
    download: 200,
    upload: 200,
    readback: 200,
    bytes: 4194304,
    uploadedBytes: 4194304,
    intact: true,
  });
  console.log(
    "native Files / 4 MiB download-upload-readback / model settings endpoint: PASS",
  );
  const sibling = await context.newPage();
  const [siblingFrame] = await Promise.all([
    sibling.waitForEvent("framenavigated", {
      predicate: (frame) =>
        frame.url().split("?", 1)[0] ===
        `http://${actors.alice.key}.localhost:${gatewayPort}/`,
    }),
    sibling.goto(datahubOrigin),
  ]);
  await siblingFrame.waitForLoadState("load");
  assert.equal(
    await siblingFrame.evaluate(
      async () => (await fetch("/api/sessions")).status,
    ),
    200,
  );
  const siblingRevoked = sibling.waitForResponse((response) =>
    response.url().endsWith("/agent/revoke"),
  );
  await sibling.evaluate(() => window.unmountAgent());
  assert.equal((await siblingRevoked).status(), 200);
  assert.equal(
    await runtimeFrame.evaluate(
      async () => (await fetch("/api/sessions")).status,
    ),
    200,
  );
  const [terminalId] = created;
  assert.equal(
    await runtimeFrame.evaluate(async (id) => {
      const response = await fetch(`/api/terminal/${id}`);
      await response.body?.cancel();
      return response.status;
    }, terminalId),
    200,
  );
  await sibling.close();
  console.log(
    "real pi-web sibling-tab cleanup preserves sessions and PTY: PASS",
  );

  await page.evaluate((origin) => {
    const probe = document.createElement("iframe");
    probe.id = probe.name = "old-origin-probe";
    probe.src = origin + "/bootstrap";
    document.body.append(probe);
  }, new URL(runtimeFrame.url()).origin);
  await page.frameLocator("#old-origin-probe").getByRole("status").waitFor();
  const oldProbe = page.frame({ name: "old-origin-probe" });
  assert.equal(
    await oldProbe.evaluate(async () => (await fetch("/api/sessions")).status),
    200,
  );

  await context.addCookies([
    {
      name: "PLAY_SESSION",
      value: "bob",
      url: datahubOrigin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const second = await context.newPage();
  second.setDefaultTimeout(30000);
  observe(second);
  second.on("pageerror", (error) => errors.push(error.message));
  const [other] = await Promise.all([
    second.waitForEvent("framenavigated", {
      predicate: (frame) =>
        frame.url().split("?", 1)[0] ===
        `http://${actors.bob.key}.localhost:${gatewayPort}/`,
    }),
    second.goto(datahubOrigin),
  ]);
  await other.waitForLoadState("load");
  await other.waitForFunction(
    () => navigator.serviceWorker.controller !== null,
  );
  await other.goto(
    `http://${actors.bob.key}.localhost:${gatewayPort}/?session=bob`,
  );
  await other.getByText("bob synthetic session", { exact: true }).waitFor();
  if (expectMcp) {
    const bobConfig = await other.evaluate(async () =>
      (await fetch("/api/mcp-config")).json(),
    );
    assert.deepEqual(bobConfig.config.mcpServers, {});
    assert.doesNotMatch(JSON.stringify(bobConfig), /alice-only/);
    console.log(
      "MCP configuration remains isolated between real Alice/Bob containers: PASS",
    );
  }
  assert.equal(
    await other.getByText("alice synthetic session", { exact: true }).count(),
    0,
  );
  assert.equal(
    await other.evaluate(
      async (id) => (await fetch(`/api/terminal/${id}`)).status,
      terminalId,
    ),
    404,
  );
  await page
    .getByRole("status")
    .filter({ hasText: "Agent could not open" })
    .waitFor();
  assert.equal(await page.locator('iframe[title="DataHub Agent"]').count(), 0);
  assert.equal(
    await oldProbe.evaluate(async () => (await fetch("/api/sessions")).status),
    401,
  );
  await page.evaluate(() =>
    document.querySelector("#old-origin-probe").remove(),
  );

  await second.evaluate((origin) => {
    const probe = document.createElement("iframe");
    probe.id = probe.name = "logout-probe";
    probe.src = origin + "/bootstrap";
    document.body.append(probe);
  }, new URL(other.url()).origin);
  await second.frameLocator("#logout-probe").getByRole("status").waitFor();
  const logoutProbe = second.frame({ name: "logout-probe" });
  assert.equal(
    await logoutProbe.evaluate(
      async () => (await fetch("/api/sessions")).status,
    ),
    200,
  );
  await context.clearCookies({ name: "PLAY_SESSION" });
  const logoutRevoked = second.waitForResponse((response) =>
    response.url().endsWith("/agent/revoke"),
  );
  await second.evaluate(() => window.unmountAgent());
  assert.equal((await logoutRevoked).status(), 200);
  assert.equal(
    await logoutProbe.evaluate(
      async () => (await fetch("/api/sessions")).status,
    ),
    401,
  );
  await second.evaluate(() => document.querySelector("#logout-probe").remove());
  assert.equal(await second.locator("iframe").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browser: browser.version(),
      serviceWorkers: "PASS",
      separateContainersAndSessions: "PASS",
      foreignTerminalDenied: "PASS",
      accountSwitchHeartbeat: "PASS",
      oldCookieRevoked: "PASS",
      sameActorSiblingAndPty: "PASS",
      logoutCleanup: "PASS",
      cleanup: "PASS",
    }),
  );
} catch (error) {
  console.log("primary failure", {
    name: error?.name,
    message: /^(runtime_[a-z_]+|pi_browser_docker_operation_failed)$/.test(
      error?.message ?? "",
    )
      ? error.message
      : "see bounded diagnostics",
    actual: typeof error?.actual === "number" ? error.actual : undefined,
    expected: typeof error?.expected === "number" ? error.expected : undefined,
  });
  // Preserve public fixture UI evidence BEFORE cleanup; never dump cookies/env.
  console.log(JSON.stringify({ consoleErrors, failedRequests }));
  let index = 0;
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages()) {
      await page
        .screenshot({
          path: `${evidence}/pi-web-failure-${index++}.png`,
          fullPage: true,
        })
        .catch(() => {});
      for (const frame of page.frames()) {
        if (!/https?:\/\/[a-f0-9]{48}\.localhost:/.test(frame.url())) continue;
        const url = new URL(frame.url());
        console.log(
          JSON.stringify({
            frame: url.origin + url.pathname,
            body: await frame
              .locator("body")
              .innerText({ timeout: 2000 })
              .then((text) => text.slice(0, 6000))
              .catch(() => "unavailable"),
            sessions: await frame
              .evaluate(async () => {
                const response = await fetch("/api/sessions");
                return { status: response.status, body: await response.json() };
              })
              .catch(() => "unavailable"),
          }),
        );
      }
    }
  throw error;
} finally {
  await browser?.close();
  await stop(gateway);
  await stop(host);
  await manager?.close();
  assert.equal(
    await docker([
      "ps",
      "-aq",
      "--filter",
      `label=datahub.agent.scope=${scope}`,
    ]),
    "",
  );
  for (const who of Object.values(actors)) {
    const volume = `dha-${scope}-${who.key}`;
    if (
      !(await docker([
        "volume",
        "ls",
        "--filter",
        `name=^${volume}$`,
        "--format",
        "{{.Name}}",
      ]))
    )
      continue;
    assert.equal(
      await docker([
        "volume",
        "inspect",
        volume,
        "--format",
        '{{index .Labels "datahub.agent.scope"}}',
      ]),
      scope,
    );
    await docker(["volume", "rm", volume]);
  }
  console.log("real-pi test containers and fixture volumes removed");
}
