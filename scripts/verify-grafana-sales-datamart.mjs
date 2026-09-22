// Operator-only browser verifier for the approved local Grafana case.
// Uses real login/UI/query responses; never creates/updates assets or credentials.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "../extensions/datahub-agent/pi-web/node_modules/playwright/index.mjs";

const origin = "http://127.0.0.1:3000";
const uid = "dataflow-salesdatamart";
const root = new URL("../", import.meta.url);
const prefix = (sql) =>
  sql
    .split(/\bWHERE\b/i)[0]
    .replace(/\s+/g, " ")
    .trim();
const cases = [
  { id: "all" },
  { id: "category_single", category: ["Bikes"] },
  { id: "category_multi", category: ["Bikes", "Accessories"] },
  { id: "territory_single", territory: ["Canada"] },
  { id: "territory_multi", territory: ["Canada", "France"] },
  {
    id: "combined_multi",
    territory: ["Canada", "France"],
    category: ["Bikes", "Accessories"],
  },
  {
    id: "june_2014",
    from: "2014-06-01T00:00:00.000Z",
    to: "2014-06-30T23:59:59.999Z",
  },
  {
    id: "empty_dates",
    from: "2015-01-01T00:00:00.000Z",
    to: "2015-01-31T23:59:59.999Z",
  },
];
const closeEnough = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 0.000001, "aggregate mismatch");
const frame = (test, id) => test.observations[id].frames[0];
const values = (test, id) => frame(test, id).data.values;
const amount = (test) => values(test, "panel:1")[0][0];
const groups = (test, id) =>
  Object.fromEntries(
    values(test, id)[0].map((key, i) => [key, values(test, id)[1][i]]),
  );

async function main() {
  assert.equal(
    process.argv[2],
    "--verify-approved-dashboard",
    "explicit approval flag required",
  );
  assert.ok(
    process.argv[3] === undefined || process.argv[3] === "--empty-dates-only",
    "unsupported verification selection",
  );
  const selectedCases =
    process.argv[3] === "--empty-dates-only"
      ? cases.filter((c) => c.id === "empty_dates")
      : cases;
  const dashboard = JSON.parse(
    await readFile(
      new URL("extensions/sales-datamart/grafana/dashboard.json", root),
      "utf8",
    ),
  ).dashboard;
  const expected = new Map(
    dashboard.panels.map((p) => [prefix(p.targets[0].rawSql), `panel:${p.id}`]),
  );
  for (const variable of dashboard.templating.list)
    expected.set(prefix(variable.query), `variable:${variable.name}`);
  assert.equal(expected.size, 9);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = new URL(
    `.local/evidence/dataflow-discovery/grafana-browser-matrix-${stamp}.json`,
    root,
  );
  const report = {
    startedAt: new Date().toISOString(),
    status: "IN_PROGRESS",
    phase: "login",
    cases: [],
    pageErrors: [],
  };
  await writeFile(output, JSON.stringify(report), { flag: "wx", mode: 0o600 });
  const home = await mkdtemp(join(tmpdir(), "dataflow-grafana-verify-"));
  let browser;
  let active;
  const pending = new Set();
  try {
    const credential = JSON.parse(
      await readFile(new URL(".local/grafana-operator.json", root), "utf8"),
    );
    browser = await chromium.launch({
      executablePath:
        "/home/timmypai/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
      headless: true,
      chromiumSandbox: true,
      env: { PATH: process.env.PATH, HOME: home },
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      timezoneId: "Asia/Taipei",
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.pageErrors.push({ name: e.name }));
    page.on("response", (response) => {
      const test = active;
      if (!test || new URL(response.url()).pathname !== "/api/ds/query") return;
      const work = (async () => {
        const body = await response.json();
        const request = response.request().postDataJSON();
        assert.equal(response.status(), 200);
        for (const query of request.queries) {
          assert.equal(query.datasource?.uid, uid);
          const id = expected.get(prefix(query.rawSql));
          assert.ok(id, "unexpected SQL projection");
          const result = body.results[query.refId];
          assert.ok(
            result && !result.error && result.status === 200,
            "query failed",
          );
          test.record.observations[id] = {
            rawSql: query.rawSql,
            from: request.from,
            to: request.to,
            frames: result.frames,
          };
        }
        if (Object.keys(test.record.observations).length === expected.size)
          test.finish();
      })().catch((error) => {
        test.record.errorType = error.name;
        test.finish();
      });
      pending.add(work);
      void work.finally(() => pending.delete(work));
    });
    await page.goto(origin + "/login", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page
      .getByLabel("Email or username", { exact: true })
      .fill(credential.username);
    await page
      .getByLabel("Password", { exact: true })
      .fill(credential.password);
    const [login] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/login",
      ),
      page.getByRole("button", { name: "Log in", exact: true }).click(),
    ]);
    assert.equal(login.status(), 200);
    const me = await (await context.request.get(origin + "/api/user")).json();
    assert.ok(
      me.login === credential.username &&
        me.orgId === 1 &&
        me.isGrafanaAdmin === true,
    );
    const skip = page.getByText("Skip", { exact: true });
    if (await skip.isVisible()) await skip.click(); // Native optional prompt, no password mutation.
    await page.waitForURL((url) => url.pathname !== "/login", {
      timeout: 10000,
    });
    report.authenticated = true;
    for (const scenario of selectedCases) {
      report.phase = scenario.id;
      const record = { id: scenario.id, observations: {} };
      report.cases.push(record);
      let finish;
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      const timer = setTimeout(() => {
        record.errorType = "QueryCompletionTimeout";
        finish();
      }, 45000);
      active = {
        record,
        finish: () => {
          clearTimeout(timer);
          finish();
        },
      };
      const url = new URL("/d/dataflow-sales-v1", origin);
      for (const name of ["territory", "category"])
        for (const value of scenario[name] || ["$__all"])
          url.searchParams.append(`var-${name}`, value);
      if (scenario.from)
        url.searchParams.set("from", String(Date.parse(scenario.from)));
      if (scenario.to)
        url.searchParams.set("to", String(Date.parse(scenario.to)));
      try {
        await page.goto(url.href, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
        await page
          .getByText("Sales quality summary", { exact: true })
          .waitFor({ timeout: 15000 });
        // Grafana lazily starts off-screen panels; exercise every actual panel.
        for (const panel of dashboard.panels)
          await page
            .getByText(panel.title, { exact: true })
            .scrollIntoViewIfNeeded();
        // Wait for ALL nine actual query responses, not the first visible KPI.
        await done;
        assert.equal(record.errorType, undefined, "query completion failed");
        assert.equal(Object.keys(record.observations).length, 9);
        for (const id of [1, 2, 3])
          assert.deepEqual(
            frame(record, `panel:${id}`).schema.fields.map((f) => f.name),
            ["value"],
          );
        if (scenario.id === "empty_dates") {
          // v13.1.2 returns a schema-less empty frame for zero-row grouped SQL.
          // That is absence of result rows, NOT proof that Catalog schema is empty.
          for (const id of [4, 5, 6]) {
            assert.deepEqual(frame(record, `panel:${id}`).schema.fields, []);
            assert.deepEqual(values(record, `panel:${id}`), []);
          }
        } else {
          // Native time-series frames canonicalize SQL alias "time" to "Time".
          assert.deepEqual(
            frame(record, "panel:4").schema.fields.map((f) => f.name),
            ["Time", "sales_amount"],
          );
          assert.equal(frame(record, "panel:4").schema.fields[0].type, "time");
          assert.deepEqual(
            frame(record, "panel:5").schema.fields.map((f) => f.name),
            ["category", "sales_amount"],
          );
          assert.deepEqual(
            frame(record, "panel:6").schema.fields.map((f) => f.name),
            ["territory", "sales_amount"],
          );
        }
        assert.deepEqual(
          frame(record, "panel:7").schema.fields.map((f) => f.name),
          [
            "line_count",
            "order_count",
            "quantity",
            "line_net_amount",
            "source_line_total",
          ],
        );
        const quality = values(record, "panel:7").map((column) => column[0]);
        record.summary = {
          amount: amount(record),
          orders: values(record, "panel:2")[0][0],
          aov: values(record, "panel:3")[0][0],
          quality,
          months:
            scenario.id === "empty_dates"
              ? 0
              : values(record, "panel:4")[0].length,
        };
        if (scenario.id === "empty_dates") {
          assert.deepEqual(record.summary, {
            amount: null,
            orders: 0,
            aov: null,
            quality: [0, 0, null, null, null],
            months: 0,
          });
        } else {
          assert.equal(quality[1], record.summary.orders);
          closeEnough(quality[3], record.summary.amount);
          closeEnough(quality[4], record.summary.amount);
          closeEnough(
            record.summary.aov,
            Math.round((record.summary.amount / record.summary.orders) * 1e6) /
              1e6,
          );
          for (const id of [4, 5, 6])
            closeEnough(
              values(record, `panel:${id}`)[1].reduce((a, b) => a + b, 0),
              record.summary.amount,
            );
          const start = Date.parse(scenario.from || dashboard.time.from);
          record.monthlyPointsBeforeSelectedStart = values(
            record,
            "panel:4",
          )[0].filter((time) => time < start).length;
          assert.equal(
            record.monthlyPointsBeforeSelectedStart,
            0,
            "monthly points clipped before selected range",
          );
          if (scenario.id === "all") {
            assert.equal(record.summary.orders, 17489);
            assert.equal(quality[0], 75284);
            assert.equal(quality[2], 178425);
            closeEnough(record.summary.amount, 72418506.319091);
            closeEnough(record.summary.aov, 4140.803152);
          } else if (scenario.id.startsWith("category_")) {
            closeEnough(
              amount(record),
              scenario.category.reduce(
                (sum, name) => sum + groups(report.cases[0], "panel:5")[name],
                0,
              ),
            );
          } else if (scenario.id.startsWith("territory_")) {
            closeEnough(
              amount(record),
              scenario.territory.reduce(
                (sum, name) => sum + groups(report.cases[0], "panel:6")[name],
                0,
              ),
            );
          } else if (scenario.id === "combined_multi") {
            const prior = report.cases.find(
              (item) => item.id === "territory_multi",
            );
            closeEnough(
              amount(record),
              scenario.category.reduce(
                (sum, name) => sum + groups(prior, "panel:5")[name],
                0,
              ),
            );
          } else if (scenario.id === "june_2014") {
            closeEnough(
              amount(record),
              groups(report.cases[0], "panel:4")[Date.parse(scenario.from)],
            );
          }
        }
        record.visibleText = await page.locator("body").innerText();
        record.status = "QUERY_SHAPES_AND_AGGREGATES_PASS";
        await page.screenshot({
          path: new URL(
            `.local/evidence/dataflow-discovery/grafana-${scenario.id}-bottom-${stamp}.png`,
            root,
          ).pathname,
          fullPage: true,
        });
        await page
          .getByText("Sales amount (local currency)", { exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: new URL(
            `.local/evidence/dataflow-discovery/grafana-${scenario.id}-${stamp}.png`,
            root,
          ).pathname,
          fullPage: true,
        });
      } finally {
        clearTimeout(timer);
        active = undefined;
      }
      await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
        mode: 0o600,
      });
    }
    report.status = report.cases.some(
      (c) => c.monthlyPointsBeforeSelectedStart > 0,
    )
      ? "NUMERICAL_PASS_MONTHLY_BOUNDARY_UI_GAP"
      : "BROWSER_QUERY_MATRIX_PASS";
  } catch (error) {
    report.status = "INCOMPLETE";
    report.errorType = error.name;
    // Keep only our source location, not messages that might contain response data.
    report.errorLocation = error.stack
      ?.split("\n")
      .find((line) => line.includes("verify-grafana-sales-datamart.mjs:"))
      ?.trim();
    process.exitCode = 1;
  } finally {
    await Promise.allSettled(pending);
    if (browser) await browser.close();
    await rm(home, { recursive: true, force: true });
    report.ownedBrowserClosed = Boolean(browser);
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        receipt: output.pathname,
        status: report.status,
        phase: report.phase,
        cases: report.cases.map((c) => ({
          id: c.id,
          status: c.status,
          responses: Object.keys(c.observations).length,
          summary: c.summary,
          monthlyPointsBeforeSelectedStart: c.monthlyPointsBeforeSelectedStart,
          errorType: c.errorType,
        })),
        errorType: report.errorType,
      }),
    );
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "REFUSED_OR_CHECKPOINT_IO_FAILED",
      errorType: error.name,
    }),
  );
  process.exitCode = 1;
});
