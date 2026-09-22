import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { mount } from "./mount.js";
import * as entrypoint from "./mount.js";

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
          assert.equal(children.length, 1);
          assert.equal(children[0].tag, "p");
          assert.match(children[0].textContent, /Agent could not open/);
          assert.doesNotMatch(children[0].textContent, /secret/);
          cleanup();
        }
      },
    );
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
