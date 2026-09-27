// Opt-in compatibility regression for the installed native Infinity client.
// Uses an existing, expired query Dashboard and an explicit Viewer credential.
// Changes only the browser's Dashboard GET response, never stored Grafana assets.
// Native backend reads must reject the expired grant; no SQL/model call is allowed.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { chromium } from "../extensions/datahub-agent/pi-web/node_modules/playwright/index.mjs";
import { readQuerySecret } from "../extensions/datahub-agent/integration/query-source.mjs";
import { buildQueryDashboard } from "../extensions/datahub-agent/integration/query-grafana.mjs";

const { values } = parseArgs({
  options: {
    receipt: { type: "string" },
    viewer: { type: "string" },
    output: { type: "string" },
  },
});
assert.ok(
  values.receipt && values.viewer && values.output,
  "explicit private receipt, Viewer credential and output paths required",
);
const prior = JSON.parse(await readFile(values.receipt, "utf8")).cases[0];
assert.match(prior.dashboardUid, /^dq-[a-f0-9]{32}$/);
assert.match(prior.displayRef, /^[a-f0-9-]{36}$/);
const viewer = await readQuerySecret(values.viewer);
assert.equal(viewer.orgId, 2);
const candidate = buildQueryDashboard({
  uid: prior.dashboardUid,
  displayRef: prior.displayRef,
  config: {
    dataUrl: "http://localhost:9041/agent/grafana-data",
    datasourceUid: "datahub-query-results",
  },
  chart: { type: "table", title: "Compatibility fixture" },
  columns: [{ name: "value", type: "string" }],
});
const options = candidate.panels[0].targets[0].url_options;
const proof = {
  scope: "NATIVE_INFINITY_CLIENT_BROWSER_RESPONSE_OVERRIDE_EXPIRED_RESULT",
  sourceQueries: 0,
  modelPrompts: 0,
  grafanaWrites: 0,
  complete: false,
  candidateSha256: createHash("sha256")
    .update(
      await readFile(
        new URL(
          "../extensions/datahub-agent/integration/query-grafana.mjs",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
  cases: [],
};
await writeFile(values.output, JSON.stringify(proof) + "\n", {
  flag: "wx",
  mode: 0o600,
});
const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: true,
});
try {
  for (const repaired of [false, true]) {
    const result = {
      repaired,
      replacedTargets: 0,
      queryStatuses: [],
      expiredReadDenied: false,
      methodErrors: 0,
    };
    proof.cases.push(result);
    const context = await browser.newContext();
    const login = await context.request.post("http://localhost:3000/login", {
      data: { user: viewer.username, password: viewer.password },
      maxRedirects: 0,
    });
    assert.equal(login.status(), 200);
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== "http://localhost:3000")
        return route.abort("blockedbyclient");
      if (
        request.method() !== "GET" &&
        !(
          request.method() === "POST" &&
          (url.pathname === "/api/ds/query" ||
            url.pathname.endsWith("/ofrep/v1/evaluate/flags"))
        )
      )
        return route.abort("blockedbyclient");
      if (
        repaired &&
        request.method() === "GET" &&
        url.pathname.endsWith("/dashboards/" + prior.dashboardUid + "/dto")
      ) {
        const response = await route.fetch({ maxRedirects: 0 });
        assert.equal(response.status(), 200);
        const body = await response.json();
        function patch(value) {
          if (!value || typeof value !== "object") return;
          if (
            value.source === "url" &&
            value.parser === "backend" &&
            value.url ===
              "http://localhost:9041/agent/grafana-data?display=" +
                prior.displayRef
          ) {
            assert.equal(
              value.url_options,
              undefined,
              "the stored RED Dashboard must remain untouched",
            );
            value.url_options = structuredClone(options);
            result.replacedTargets++;
          }
          for (const child of Object.values(value)) patch(child);
        }
        patch(body);
        return route.fulfill({ response, json: body });
      }
      return route.continue();
    });
    const page = await context.newPage();
    let complete;
    const observed = new Promise((resolve) => {
      complete = resolve;
    });
    page.on("console", (message) => {
      if (
        /Cannot read properties of undefined \(reading 'method'\)/.test(
          message.text(),
        )
      ) {
        result.methodErrors++;
        if (!repaired) complete();
      }
    });
    const pending = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname !== "/api/ds/query") return;
      pending.push(
        (async () => {
          result.queryStatuses.push(response.status());
          const body = await response.json();
          // Read error codes only; no business rows enter this report.
          result.expiredReadDenied ||= Object.values(body.results ?? {}).some(
            (r) => /(?:401|403)/.test(r.error ?? ""),
          );
          if (repaired) complete();
        })(),
      );
    });
    const url = new URL("http://localhost:3000/d/" + prior.dashboardUid);
    url.search = new URLSearchParams({
      orgId: "2",
      "var-display": prior.displayRef,
      theme: "light",
      kiosk: "",
    });
    await page.goto(url.href, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page
      .getByText("查詢結果", { exact: true })
      .waitFor({ state: "visible", timeout: 60000 });
    let timer;
    try {
      await Promise.race([
        observed,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("native_query_observation_timeout")),
            40000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await Promise.all(pending);
    if (repaired) {
      assert.equal(result.replacedTargets, 2);
      assert.equal(result.methodErrors, 0);
      assert.ok(result.queryStatuses.length > 0);
      assert.equal(result.expiredReadDenied, true);
    } else {
      assert.ok(result.methodErrors > 0);
      assert.equal(result.queryStatuses.length, 0);
    }
    await context.close();
  }
  proof.complete = true;
} catch (error) {
  proof.failure = error.name;
  process.exitCode = 1;
} finally {
  viewer.password = undefined;
  await browser.close();
  await writeFile(values.output, JSON.stringify(proof, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(proof));
}
