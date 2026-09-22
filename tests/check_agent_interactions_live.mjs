// Opt-in local DataHub UI acceptance. No model prompts, credential reads, or deployment.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "../extensions/datahub-agent/pi-web/node_modules/playwright/index.mjs";
import { expect } from "../extensions/datahub-agent/pi-web/node_modules/playwright/test.mjs";

const { T07_CDP, T07_SESSION_ID, T07_EVIDENCE } = process.env;
assert(T07_CDP && T07_SESSION_ID && T07_EVIDENCE);
assert.match(T07_CDP, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.match(T07_SESSION_ID, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
await mkdir(T07_EVIDENCE, { recursive: true });
const receipt = `${T07_EVIDENCE}/result.json`;
const proof = {
  at: new Date().toISOString(),
  steps: [],
  blockedMutations: [],
  pageErrors: [],
  limits: [
    "Chromium composition events, not Windows OS IME",
    "Viewport checks, not physical touch devices",
    "Page heartbeat network failure, not OS-wide offline or proof of the old waiting-page cause",
  ],
};
await writeFile(receipt, JSON.stringify(proof), { flag: "wx", mode: 0o600 });
const save = () =>
  writeFile(receipt, JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
const browser = await chromium.connectOverCDP(T07_CDP);
let page,
  frame,
  draft,
  originalDraft,
  sidebarInitiallyOpen,
  coreToggled = false;
const marker = "T07_LOCAL_UNSENT_中文組字";
const input = () =>
  frame.getByPlaceholder("Message… Type / for commands, @ for files", {
    exact: true,
  });
async function openRun() {
  await page.goto("http://localhost:9002/mfe/agent");
  const iframe = page.locator('iframe[title="DataHub Agent"]');
  await iframe.waitFor();
  frame = await (await iframe.elementHandle()).contentFrame();
  assert(frame);
  await frame.waitForURL(
    (u) => u.hostname.endsWith(".localhost") && u.pathname === "/",
  );
  const active = await frame.evaluate(async () => {
    const r = await fetch("/api/agent/running");
    const j = await r.json();
    return { status: r.status, count: j.runningSessionIds?.length };
  });
  assert.deepEqual(
    active,
    { status: 200, count: 0 },
    "Active work: do not exercise editor",
  );
  const runtimeOrigin = new URL(frame.url()).origin;
  await frame.goto(
    `${runtimeOrigin}/bootstrap?session=${encodeURIComponent(T07_SESSION_ID)}`,
  );
  await frame.waitForURL(
    (u) =>
      u.pathname === "/" && u.searchParams.get("session") === T07_SESSION_ID,
  );
  await expect(input()).toBeVisible();
}
try {
  page = await browser.contexts()[0].newPage();
  page.on("pageerror", (e) => proof.pageErrors.push(e.name));
  await page.route("**/api/agent/**", async (route) => {
    const r = route.request();
    if (r.method() === "POST") {
      let type;
      try {
        type = r.postDataJSON()?.type;
      } catch {
        /* Reject unknown writes. */
      }
      if (
        ![
          "get_state",
          "get_tools",
          "get_commands",
          "get_available_models",
        ].includes(type)
      ) {
        proof.blockedMutations.push({ path: new URL(r.url()).pathname, type });
        await route.abort("blockedbyclient");
        return;
      }
    }
    await route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRun();
  proof.browser = browser.version();
  sidebarInitiallyOpen = await frame
    .getByRole("button", { name: "Close History and Workspace", exact: true })
    .isVisible();
  if (sidebarInitiallyOpen)
    await frame
      .getByRole("button", { name: "Close History and Workspace", exact: true })
      .click();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    // The native DataHub sidebar has its own explicit collapse control.
    if (width === 390 && (await frame.evaluate(() => innerWidth < 200))) {
      await page
        .getByRole("button", { name: "Navbar toggler", exact: true })
        .click();
      coreToggled = true;
    }
    const opener = frame.getByRole("button", {
      name: "Workspace",
      exact: true,
    });
    await opener.focus();
    await opener.press("Enter");
    await expect(
      frame.getByRole("button", {
        name: "Close History and Workspace",
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    const bounds = await frame.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert(bounds.scrollWidth <= bounds.width, "Native horizontal overflow");
    const composerBox = await input().boundingBox();
    assert(
      composerBox &&
        composerBox.width >= 120 &&
        composerBox.x >= 0 &&
        composerBox.x + composerBox.width <= width,
      "Composer must remain visible and usable within host",
    );
    const hostBounds = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert(
      hostBounds.scrollWidth <= hostBounds.width,
      "DataHub host horizontal overflow",
    );
    proof.steps.push({
      name: "keyboard-drawer-and-overflow",
      viewport: width,
      native: bounds,
      host: hostBounds,
      pass: true,
    });
    await save();
    if (coreToggled) {
      await page
        .getByRole("button", { name: "Navbar toggler", exact: true })
        .click();
      coreToggled = false;
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const settingsButton = frame
    .getByRole("button", { name: "Settings", exact: true })
    .first();
  await settingsButton.focus();
  await settingsButton.press("Enter");
  const settings = frame.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "General", exact: true }).click();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    assert(
      await settings.evaluate((e) => e.contains(document.activeElement)),
      "Settings keyboard focus escaped",
    );
  }
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  const settingsFocus = await settingsButton.evaluate((e) => ({
    returned: e === document.activeElement,
    activeTag: document.activeElement?.tagName,
    activeLabel: document.activeElement?.getAttribute("aria-label"),
  }));
  proof.steps.push({
    name: "settings-tab-containment-escape-focus",
    ...settingsFocus,
    pass: settingsFocus.returned,
  });
  await save();
  draft = input();
  originalDraft = await draft.inputValue();
  assert.equal(originalDraft, "", "Existing user draft: do not overwrite");
  await draft.fill(marker);
  await draft.press("Shift+Enter");
  await expect(draft).toHaveValue(marker + "\n");
  const composition = await draft.evaluate((e) => {
    const dispatch = (event) => !e.dispatchEvent(event);
    dispatch(
      new CompositionEvent("compositionstart", { bubbles: true, data: "中" }),
    );
    dispatch(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        isComposing: true,
        keyCode: 229,
      }),
    );
    dispatch(
      new CompositionEvent("compositionend", { bubbles: true, data: "中文" }),
    );
    const gracePrevented = dispatch(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
      }),
    );
    return { gracePrevented, value: e.value };
  });
  assert.equal(composition.gracePrevented, true);
  assert.equal(composition.value, marker + "\n");
  assert.equal(
    proof.blockedMutations.length,
    0,
    "IME must not even attempt submission",
  );
  proof.steps.push({
    name: "shift-enter-and-composition-events-no-submit",
    ...composition,
    pass: true,
  });
  await save();
  await page.reload();
  frame = await (
    await page.locator('iframe[title="DataHub Agent"]').elementHandle()
  ).contentFrame();
  await frame.waitForURL(
    (u) =>
      u.pathname === "/" && u.searchParams.get("session") === T07_SESSION_ID,
  );
  draft = input();
  await expect(draft).toHaveValue("");
  // The unchanged upstream draft-store is an in-memory Map, not localStorage.
  proof.steps.push({
    name: "upstream-memory-draft-clears-on-full-reload",
    limitation: "No cross-reload draft persistence; no new storage added",
    pass: true,
  });
  await save();
  let failedHeartbeats = 0;
  await page.route("**/agent/heartbeat", async (route) => {
    failedHeartbeats++;
    await route.abort("internetdisconnected");
  });
  await expect(
    page.getByText(
      "Agent could not open. Check your DataHub login and retry from the Agent menu.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 35000 });
  await expect(page.locator('iframe[title="DataHub Agent"]')).toHaveCount(0);
  assert(failedHeartbeats > 0);
  await page.unroute("**/agent/heartbeat");
  await openRun();
  draft = input();
  await expect(draft).toHaveValue("");
  const recovered = await frame.evaluate(async (id) => {
    const r = await fetch("/api/sessions/" + id + "?deferThinking&deferMedia");
    const j = await r.json();
    return {
      status: r.status,
      sessionId: j.sessionId,
      messageCount: j.context?.messages?.length,
    };
  }, T07_SESSION_ID);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.sessionId, T07_SESSION_ID);
  assert(recovered.messageCount > 0);
  proof.steps.push({
    name: "heartbeat-network-failure-removes-frame-and-reopen-recovers-history",
    failedHeartbeats,
    recovered,
    pass: true,
  });
  assert.equal(proof.blockedMutations.length, 0);
  assert.equal(proof.pageErrors.length, 0);
  proof.completed = true;
  proof.passed = proof.steps.every((s) => s.pass);
  await save();
  console.log(JSON.stringify(proof, null, 2));
  assert(proof.passed, "See per-scenario defects in receipt");
} catch (error) {
  proof.failure = { name: error.name, message: error.message };
  await save();
  throw error;
} finally {
  if (page) {
    try {
      await page.unroute("**/agent/heartbeat");
      if (coreToggled)
        await page
          .getByRole("button", { name: "Navbar toggler", exact: true })
          .click();
      if (
        draft &&
        originalDraft === "" &&
        (await draft.isVisible()) &&
        (await draft.inputValue()).startsWith(marker)
      )
        await draft.fill("");
      if (
        frame &&
        sidebarInitiallyOpen &&
        !(await frame
          .getByRole("button", {
            name: "Close History and Workspace",
            exact: true,
          })
          .isVisible())
      )
        await frame
          .getByRole("button", { name: "Workspace", exact: true })
          .click();
      proof.cleanup = {
        ownedPageClosed: false,
        markerDraftRemoved:
          !draft ||
          !(await draft.isVisible()) ||
          !(await draft.inputValue()).startsWith(marker),
      };
    } catch (error) {
      proof.cleanup = { unconfirmed: error.name };
    }
    await page.close();
    proof.cleanup.ownedPageClosed = true;
  }
  await browser.close();
  await save();
}
