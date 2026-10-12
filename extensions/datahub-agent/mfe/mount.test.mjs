import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { mount } from "./mount.js";
import * as entrypoint from "./mount.js";
import { BrowserGrants } from "../integration/browser-grants.mjs";

// DataHub's shipped Federation unwrap selects .default for ES module namespaces.
test("official Federation unwrap receives the mount function", () => {
  const unwrapped =
    entrypoint[Symbol.toStringTag] === "Module"
      ? entrypoint.default
      : entrypoint;
  assert.equal(unwrapped, mount);
});

const launchUrl = `http://${"a".repeat(48)}.localhost:30150/bootstrap#synthetic-once-token`;
const grantId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const revokeToken = "r".repeat(43);

test("MFE bootstrap contract (synthetic DOM and gateway, not browser E2E)", async (t) => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  globalThis.window.location = { href: "http://localhost:9002/mfe/agent" };
  globalThis.window.history = { state: null, replaceState() {} };
  const previousPath = globalThis.__webpack_public_path__;
  const elements = [];
  const children = [];
  globalThis.__webpack_public_path__ = "http://localhost:30150/mfe/";
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      const element = Object.assign(new EventTarget(), {
        tag,
        style: {},
        attributes: {},
        children: [],
        append(...elements) {
          this.children.push(...elements);
        },
        setAttribute(key, value) {
          this.attributes[key] = value;
        },
        remove() {
          const index = children.indexOf(this);
          if (index >= 0) children.splice(index, 1);
        },
      });
      if (tag === "iframe") element.contentWindow = {};
      elements.push(element);
      return element;
    },
  };
  const container = {
    style: { height: "80vh" },
    append(element) {
      children.push(element);
    },
    prepend(element) {
      children.unshift(element);
    },
    insertBefore(element, before) {
      children.splice(children.indexOf(before), 0, element);
    },
  };
  try {
    await t.test(
      "server bootstrap receives no client actor, launches a separate browser origin",
      async () => {
        const requests = [];
        t.mock.method(globalThis, "fetch", async (url, options) => {
          requests.push({ url: url.href, options });
          return Response.json({ launchUrl, grantId, revokeToken });
        });
        const cleanup = mount(container);
        assert.equal(children[0].attributes.role, "status");
        await setImmediate();
        assert.equal(children.length, 3);
        const frame = children.find((element) => element.tag === "iframe");
        assert.equal(
          children.find((element) => element.tag === "details"),
          undefined,
        );
        assert.equal(children[0].attributes["aria-label"], "Agent views");
        assert.equal(
          children.find(
            (element) => element.attributes["aria-label"] === "Agent Registry",
          ).tag,
          "section",
        );
        assert.equal(frame.tag, "iframe");
        assert.equal(frame.src, launchUrl);
        assert.equal(frame.title, "DataHub Agent");
        assert.match(frame.attributes.sandbox, /allow-downloads/);
        assert.doesNotMatch(frame.attributes.sandbox, /allow-top-navigation/);
        cleanup();
        cleanup();
        assert.equal(children.length, 0);
        assert.equal(container.style.height, "80vh");
        assert.equal(requests[0].url, "http://localhost:30150/agent/bootstrap");
        assert.equal(requests[0].options.method, "POST");
        assert.equal(requests[0].options.credentials, "include");
        assert.equal(requests[0].options.body, "{}");
        assert.equal(requests[1].url, "http://localhost:30150/agent/revoke");
        assert.deepEqual(JSON.parse(requests[1].options.body), {
          grantId,
          revokeToken,
        });
        assert.ok(
          !frame.src.includes(revokeToken),
          "stop-only proof stays in the trusted parent",
        );
      },
    );
    await t.test(
      "denial and invalid bootstrap targets display only safe failure text",
      async () => {
        for (const result of [
          new Response("secret", { status: 401 }),
          Response.json({ launchUrl, grantId }),
          Response.json({ launchUrl, grantId, revokeToken: "invalid" }),
          ...[
            "invalid secret",
            "https://evil.example/bootstrap#secret",
            "http://localhost:30150/bootstrap#secret",
            launchUrl.replace(":30150", ":30151"),
            launchUrl.replace("/bootstrap", "/api"),
            launchUrl.replace("#synthetic-once-token", "?secret=x"),
          ].map((launchUrl) =>
            Response.json({ launchUrl, grantId, revokeToken }),
          ),
        ]) {
          t.mock.method(globalThis, "fetch", async () => result);
          const cleanup = mount(container);
          await setImmediate();
          assert.equal(children.length, 2);
          assert.equal(children[0].tag, "p");
          assert.equal(children[1].tag, "button");
          assert.equal(children[1].textContent, "重新連線 Agent");
          assert.match(children[0].textContent, /Agent could not open/);
          assert.doesNotMatch(children[0].textContent, /secret/);
          cleanup();
        }
      },
    );
    await t.test("expired idle lease reopens the workspace with fresh authenticated bootstrap, without a page refresh or tool replay", async () => {
      let now = 0, tick;
      const grants = new BrowserGrants({ clock: () => now });
      const actor = { tenant: "fixture", urn: "urn:li:corpuser:fixture", key: "a".repeat(48) };
      const requests = [], issues = [];
      t.mock.method(globalThis, "setInterval", fn => { tick = fn; return 1; });
      t.mock.method(globalThis, "clearInterval", () => {});
      t.mock.method(globalThis, "fetch", async (url, options) => {
        const body = JSON.parse(options.body); requests.push(url.pathname);
        if (url.pathname === "/agent/bootstrap") {
          const issued = grants.issue(actor); issues.push(issued);
          grants.exchange(issued.ticket, actor.key);
          return Response.json({ grantId: issued.grantId, revokeToken: issued.revokeToken,
            launchUrl: `http://${actor.key}.localhost:30150/bootstrap#${issued.ticket}` });
        }
        if (url.pathname === "/agent/heartbeat") {
          try { grants.renew(body.grantId, actor, body.revokeToken); return Response.json({ ok: true }); }
          catch { return Response.json({ error: "authentication_required" }, { status: 401 }); }
        }
        if (url.pathname === "/agent/revoke") { grants.release(body.grantId, body.revokeToken); return Response.json({ ok: true }); }
        throw Error("unexpected tool or model request");
      });
      const cleanup = mount(container);
      try {
        await setImmediate(); assert.equal(issues.length, 1);
        const retiredFrame = children.find(e => e.tag === "iframe");
        now = 90001; await tick(); await setImmediate();
        assert.equal(issues.length, 2, "expired grant must be replaced, not renewed or left as a terminal refresh-only error");
        const frame = children.find(element => element.tag === "iframe");
        assert(frame, "workspace recovered without full DataHub page refresh");
        assert.notEqual(frame, retiredFrame, "fresh WindowProxy rejects queued messages from the retired document");
        assert(frame.src.includes(issues[1].ticket)); assert.notEqual(issues[0].grantId, issues[1].grantId);
        assert.equal(children.some(e => /Agent could not open/.test(e.textContent ?? "")), false);
        assert(requests.every(p => ["/agent/bootstrap", "/agent/heartbeat", "/agent/revoke"].includes(p)));
      } finally { cleanup(); t.mock.restoreAll(); }
    });
    await t.test("expired DataHub login stops automatic bootstrap; explicit retry is single-flight and wake events cannot bypass login", async () => {
      let tick, denied = false, bootstraps = 0;
      t.mock.method(globalThis, "setInterval", fn => { tick = fn; return 1; });
      t.mock.method(globalThis, "clearInterval", () => {});
      t.mock.method(globalThis, "fetch", async url => {
        if (url.pathname === "/agent/bootstrap") { bootstraps++; return denied ? new Response("private", { status: 401 }) : Response.json({ launchUrl, grantId, revokeToken }); }
        if (url.pathname === "/agent/heartbeat") return new Response("private", { status: 401 });
        if (url.pathname === "/agent/revoke") return Response.json({ ok: true });
        throw Error("unexpected operation");
      });
      const cleanup = mount(container);
      try {
        await setImmediate(); denied = true; await tick(); await setImmediate();
        assert.equal(bootstraps, 2); assert.equal(children.some(e => e.tag === "iframe"), false);
        const button = children.find(e => e.tag === "button"); assert(button); assert.equal(button.disabled, false);
        globalThis.window.dispatchEvent(new Event("focus")); globalThis.window.dispatchEvent(new Event("online"));
        await setImmediate(); assert.equal(bootstraps, 2, "no background authentication retry loop");
        denied = false; const reconnect = button.onclick(); button.onclick(); await reconnect;
        assert.equal(bootstraps, 3); assert.equal(children.filter(e => e.tag === "iframe").length, 1);
      } finally { cleanup(); t.mock.restoreAll(); }
    });
    await t.test("a transient heartbeat transport failure reauthenticates once; visibility/focus renewal is single-flight", async () => {
      let tick, fail = false, heartbeats = 0, bootstraps = 0;
      t.mock.method(globalThis, "setInterval", fn => { tick = fn; return 1; });
      t.mock.method(globalThis, "clearInterval", () => {});
      t.mock.method(globalThis, "fetch", async url => {
        if (url.pathname === "/agent/bootstrap") { bootstraps++; return Response.json({ launchUrl, grantId, revokeToken }); }
        if (url.pathname === "/agent/heartbeat") { heartbeats++; if (fail) throw Error("private transport detail"); return Response.json({ ok: true }); }
        if (url.pathname === "/agent/revoke") return Response.json({ ok: true });
        throw Error("no tools or prompts allowed");
      });
      const cleanup = mount(container);
      try {
        await setImmediate(); fail = true; await tick(); await setImmediate();
        assert.equal(bootstraps, 2); assert.equal(children.filter(e => e.tag === "iframe").length, 1);
        fail = false; const before = heartbeats;
        globalThis.window.dispatchEvent(new Event("focus")); globalThis.window.dispatchEvent(new Event("online"));
        await setImmediate(); assert.equal(heartbeats, before + 1); assert.equal(bootstraps, 2);
      } finally { cleanup(); t.mock.restoreAll(); }
    });
    await t.test("cleanup during rebootstrap aborts the old connection and a late reply cannot restore the workspace", async () => {
      let tick, resolve, bootstraps = 0, oldSignal;
      const late = new Promise(done => { resolve = done; });
      t.mock.method(globalThis, "setInterval", fn => { tick = fn; return 1; });
      t.mock.method(globalThis, "clearInterval", () => {});
      t.mock.method(globalThis, "fetch", async (url, options) => {
        if (url.pathname === "/agent/bootstrap") { bootstraps++; if (bootstraps === 1) return Response.json({ launchUrl, grantId, revokeToken }); return late; }
        if (url.pathname === "/agent/heartbeat") { oldSignal = options.signal; return new Response("denied", { status: 401 }); }
        if (url.pathname === "/agent/revoke") return Response.json({ ok: true });
        throw Error("no old operation may replay");
      });
      const cleanup = mount(container);
      try {
        await setImmediate(); await tick(); await setImmediate(); assert.equal(bootstraps, 2); assert.equal(oldSignal.aborted, true);
        cleanup(); resolve(Response.json({ launchUrl, grantId, revokeToken })); await setImmediate();
        assert.equal(children.length, 0); globalThis.window.dispatchEvent(new Event("online")); await setImmediate(); assert.equal(bootstraps, 2);
      } finally { cleanup(); t.mock.restoreAll(); }
    });
    await t.test("reconnection cancels old in-flight requests and fences queued same-origin messages from the retired iframe", async () => {
      let tick, resolve, bootstraps = 0, requestSignal;
      const replies = [], requests = [], late = new Promise(done => { resolve = done; });
      t.mock.method(globalThis, "setInterval", fn => { tick = fn; return 1; }); t.mock.method(globalThis, "clearInterval", () => {});
      t.mock.method(globalThis, "fetch", async (url, options) => {
        if (url.pathname === "/agent/bootstrap") { bootstraps++; return Response.json({ launchUrl,
          grantId: bootstraps === 1 ? grantId : "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", revokeToken }); }
        if (url.pathname === "/agent/catalog") { requests.push(JSON.parse(options.body)); requestSignal = options.signal; return late; }
        if (url.pathname === "/agent/heartbeat") return new Response("expired", { status: 401 });
        if (url.pathname === "/agent/revoke") return Response.json({ ok: true });
        throw Error("no replay or new operation allowed");
      });
      const message = oldFrame => { const event = new Event("message"); Object.assign(event, { source: oldFrame.contentWindow,
        origin: new URL(launchUrl).origin, data: { type: "datahub-catalog", body: JSON.stringify({ action: "entity" }) },
        ports: [{ postMessage(value) { replies.push(value); }, close() {} }] }); return event; };
      const cleanup = mount(container);
      try {
        await setImmediate(); const oldFrame = children.find(e => e.tag === "iframe");
        globalThis.window.dispatchEvent(message(oldFrame)); await setImmediate(); assert.equal(requests.length, 1);
        assert.equal(requests[0].grantId, grantId);
        await tick(); await setImmediate(); assert.equal(bootstraps, 2); assert.equal(requestSignal.aborted, true);
        const newFrame = children.find(e => e.tag === "iframe"); assert.notEqual(newFrame.contentWindow, oldFrame.contentWindow);
        globalThis.window.dispatchEvent(message(oldFrame)); resolve(Response.json({ data: "late old metadata" })); await setImmediate();
        assert.equal(requests.length, 1, "no replay and no borrowing the new grant by an old document"); assert.deepEqual(replies, []);
      } finally { cleanup(); t.mock.restoreAll(); }
    });
    await t.test(
      "cleanup prevents a late bootstrap result from mounting",
      async () => {
        let resolve;
        const response = new Promise((done) => {
          resolve = done;
        });
        t.mock.method(globalThis, "fetch", () => response);
        const cleanup = mount(container);
        cleanup();
        resolve(Response.json({ launchUrl, grantId, revokeToken }));
        await setImmediate();
        assert.equal(children.length, 0);
        assert.equal(container.style.height, "80vh");
      },
    );
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.__webpack_public_path__ = previousPath;
    t.mock.restoreAll();
  }
});
