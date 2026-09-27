import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";
import { setImmediate } from "node:timers/promises";
import { installGrafanaBridge } from "./grafana.js";
const intent = {
  action: "open",
  displayRef: "22222222-2222-4222-8222-222222222222",
  requestId: "11111111-1111-4111-8111-111111111111",
  visible: true,
  rect: { left: -50, top: -50, width: 400, height: 400 },
};
function response() {
  return {
    format: "datahub-grafana.portal/1",
    requestId: intent.requestId,
    displayRef: intent.displayRef,
    dashboardUid: "sales-monthly-category",
    orgId: 2,
    url: `http://localhost:3000/d/sales-monthly-category?orgId=2&from=2014-06-01&to=2014-06-30&var-display=${intent.displayRef}&kiosk=`,
    expiresAt: Date.now() + 20000,
  };
}
function fixture(send) {
  const oldWindow = globalThis.window,
    oldDocument = globalThis.document;
  const children = [];
  let listener;
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 900,
    addEventListener(name, fn) {
      if (name === "message") listener = fn;
    },
    removeEventListener() {},
  };
  globalThis.document = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      return {
        style: {},
        setAttribute() {},
        remove() {
          children.splice(children.indexOf(this), 1);
        },
      };
    },
  };
  const frame = Object.assign(new EventTarget(), {
    contentWindow: {},
    getBoundingClientRect: () => ({
      left: 200,
      top: 100,
      right: 1000,
      bottom: 800,
    }),
  });
  const stop = installGrafanaBridge({
    container: {
      append(el) {
        children.push(el);
      },
    },
    frame,
    origin: "http://actor.localhost",
    grafanaOrigin: "http://localhost:3000",
    send,
  });
  const channels = [];
  return {
    children,
    async open(patch = {}, trusted = true) {
      const channel = new MessageChannel();
      channels.push(channel);
      const received = new Promise((resolve) =>
        channel.port1.once("message", (value) => resolve(JSON.parse(value))),
      );
      const task = listener({
        origin: trusted ? "http://actor.localhost" : "http://evil.test",
        source: frame.contentWindow,
        data: {
          type: "datahub-grafana-portal",
          body: JSON.stringify({ ...intent, ...patch }),
        },
        ports: [channel.port2],
      });
      return { channel, received, task };
    },
    close() {
      stop();
      for (const c of channels) {
        c.port1.close();
        c.port2.close();
      }
      globalThis.window = oldWindow;
      globalThis.document = oldDocument;
    },
  };
}
test("portal clips outside Pi bounds, replaces rather than stacks, closes and cleans up", async () => {
  const f = fixture(async () => response());
  try {
    const first = await f.open();
    await first.task;
    assert.equal((await first.received).status, "mounted");
    assert.equal(f.children.length, 1);
    assert.match(f.children[0].style.clipPath, /50px/);
    const second = await f.open();
    await second.task;
    await second.received;
    assert.equal(f.children.length, 1);
    second.channel.port1.postMessage(JSON.stringify({ action: "close" }));
    await setImmediate();
    await setImmediate();
    assert.equal(f.children.length, 0);
  } finally {
    f.close();
  }
});
test("forged URL/org/extra input and foreign origin cannot mount a portal", async () => {
  let calls = 0,
    bad = "http://evil.test/d/sales-monthly-category";
  const f = fixture(async () => {
    calls++;
    return { ...response(), url: bad };
  });
  try {
    const foreign = await f.open({}, false);
    await foreign.task;
    assert.equal(calls, 0);
    const extra = await f.open({ url: "http://evil.test" });
    await extra.task;
    assert.match((await extra.received).error, /invalid/);
    assert.equal(calls, 0);
    for (const url of [
      "http://evil.test/d/sales-monthly-category",
      response().url.replace("orgId=2", "orgId=1"),
      `${response().url}&url=http://evil.test`,
    ]) {
      bad = url;
      const invalid = await f.open();
      await invalid.task;
      assert.match((await invalid.received).error, /denied/);
      assert.equal(f.children.length, 0);
    }
  } finally {
    f.close();
  }
});
test("close during authorization and late successful response cannot resurrect the iframe", async () => {
  let resolve;
  const f = fixture(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  try {
    const pending = await f.open();
    pending.channel.port1.postMessage(JSON.stringify({ action: "close" }));
    await setImmediate();
    await setImmediate();
    resolve(response());
    await pending.task;
    assert.equal(f.children.length, 0);
  } finally {
    f.close();
  }
});
