// Real React + exact SettingsPanel function fixture. Child settings/API are stubbed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "../extensions/datahub-agent/pi-web/node_modules/playwright/index.mjs";
import { expect } from "../extensions/datahub-agent/pi-web/node_modules/playwright/test.mjs";
const dir = process.env.SETTINGS_FOCUS_FIXTURE;
assert(dir, "Explicit built fixture required");
const files = new Map(
    await Promise.all(
        [
            ["/fixture.js", "dist/fixture.js"],
            ["/settings.css", "settings.css"],
            ["/datahub.css", "datahub.css"],
        ].map(async ([url, file]) => [url, await readFile(`${dir}/${file}`)]),
    ),
);
const server = createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    if (files.has(req.url)) {
        res.setHeader(
            "content-type",
            req.url.endsWith(".js") ? "text/javascript" : "text/css",
        );
        res.end(files.get(req.url));
        return;
    }
    res.setHeader("content-type", "text/html");
    res.end(
        '<!doctype html><html data-datahub="true"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/settings.css"><link rel="stylesheet" href="/datahub.css"><style>:root{--bg:white;--bg-panel:white;--text:black;--border:#ddd}</style><div id="root"></div><script src="/fixture.js"></script></html>',
    );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
const proof = {
    source: JSON.parse(await readFile(`${dir}/source.json`, "utf8")),
    steps: [],
};
try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const openerName of ["Open Settings A", "Open Settings B"]) {
            const opener = page.getByRole("button", {
                name: openerName,
                exact: true,
            });
            await opener.focus();
            await opener.press("Enter");
            const dialog = page.getByRole("dialog", {
                name: "Settings",
                exact: true,
            });
            await expect(dialog).toBeVisible();
            // Focus on a child reproduces the real failure: removal otherwise leaves BODY focused.
            await dialog.getByLabel("Fixture text").focus();
            await page.keyboard.press("Escape");
            await expect(dialog).toBeHidden();
            await expect(opener).toBeFocused();
            await opener.press("Enter");
            await expect(dialog).toBeVisible();
            const initialFocusInside = await dialog.evaluate((e) =>
                e.contains(document.activeElement),
            );
            assert(
                initialFocusInside,
                "Opening Settings must move keyboard focus into it",
            );
            await dialog
                .getByRole("button", { name: "Close", exact: true })
                .click();
            await expect(opener).toBeFocused();
            proof.steps.push({
                width,
                openerName,
                initialFocusInside,
                escapeAndCloseReturnFocus: true,
            });
        }
    }
    proof.passed = true;
} catch (error) {
    proof.failure = { name: error.name, message: error.message };
    throw error;
} finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await writeFile(
        `${dir}/result.json`,
        JSON.stringify(proof, null, 2) + "\n",
        { flag: "wx" },
    );
}
