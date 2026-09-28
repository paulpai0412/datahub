import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";
const { openSessionHistory } = await createJiti(import.meta.url).import("./session-history.ts");

function setup(t, response) {
  const calls = [];
  const view = {
    opener: {}, closed: false,
    document: {
      title: "", body: { textContent: "" },
      open: () => calls.push("document.open"),
      write: (html) => calls.push(["document.write", html]),
      close: () => calls.push("document.close"),
    },
  };
  t.mock.method(globalThis, "fetch", async (...args) => {
    calls.push(["fetch", ...args]);
    assert.equal(view.opener, null);
    return typeof response === "function" ? response() : response;
  });
  const previous = globalThis.window;
  globalThis.window = {
    open: (...args) => { calls.push(["window.open", ...args]); return view; },
    alert: (message) => calls.push(["alert", message]),
  };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  return { view, calls };
}

test("Full history reserves a detached popup then fetches in the authenticated context", async (t) => {
  const html = "<!doctype html><h1>Full tree</h1><script>window.treeReady=true</script>";
  const { calls } = setup(t, new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  await openSessionHistory("id/?#");
  assert.deepEqual(calls, [
    ["window.open", "", "_blank"],
    ["fetch", "/api/sessions/id%2F%3F%23/export?inline=1", { credentials: "same-origin", cache: "no-store" }],
    "document.open", ["document.write", html], "document.close",
  ]);
});

for (const status of [401, 403, 404, 500]) {
  test(`HTTP ${status} is displayed without rendering the error body or retrying`, async (t) => {
    const { view, calls } = setup(t, new Response("sensitive server details", { status }));
    await openSessionHistory("id");
    assert.equal(view.document.body.textContent, `Full history: HTTP ${status}`);
    assert.equal(calls.filter(x => x[0] === "fetch").length, 1);
    assert(!calls.some(x => x[0] === "document.write"));
  });
}

test("a non-HTML response is not interpreted as a history document", async (t) => {
  const { view, calls } = setup(t, new Response("{}", { headers: { "content-type": "application/json" } }));
  await openSessionHistory("id");
  assert.match(view.document.body.textContent, /Expected an HTML session export/);
  assert(!calls.some(x => x[0] === "document.write"));
});

test("network failure leaves a readable error and does not retry", async (t) => {
  const { view, calls } = setup(t, () => { throw new TypeError("Failed to fetch"); });
  await openSessionHistory("id");
  assert.equal(view.document.body.textContent, "Full history: Failed to fetch");
  assert.equal(calls.filter(x => x[0] === "fetch").length, 1);
});

test("blocked popups do not fetch/export in the background", async (t) => {
  const { calls } = setup(t);
  window.open = () => null;
  await openSessionHistory("id");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "alert");
});

test("closing the viewer while fetching does not reopen it or write into it", async (t) => {
  const { view, calls } = setup(t, () => {
    view.closed = true;
    return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  });
  await openSessionHistory("id");
  assert(!calls.some(x => x[0] === "document.write"));
});

test("both toolbar layouts use the authenticated history opener", () => {
  const source = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("const handleViewFullHistory"), source.indexOf("// Show chat area"));
  assert.match(handler, /openSessionHistory\(selectedSession\.id, translate\("history\.full"\)\)/);
  assert.doesNotMatch(handler, /window\.open|\/export\?/);
});
