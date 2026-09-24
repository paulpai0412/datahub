import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";
import ts from "typescript";

// Execute the product effect with real MessagePorts; mock React scheduling only.
// onRespond is the native UI completion boundary, not a generic status callback.
const code = ts.transpileModule(
  readFileSync(
    new URL("./DataHubIngestionBridge.tsx", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
function bridge(title, embedded = true) {
  const responses = [],
    notices = [],
    sent = [];
  let effect, peer, posted, handled, rendered;
  const posting = new Promise((resolve) => {
    posted = resolve;
  });
  const handling = new Promise((resolve) => {
    handled = resolve;
  });
  const window = {};
  window.parent = embedded
    ? {
        postMessage(value, origin, ports) {
          assert.equal(origin, "*");
          sent.push(value);
          peer = ports[0];
          posted();
        },
      }
    : window;
  const exports = {};
  runInNewContext(code, {
    exports,
    MessageChannel,
    window,
    setTimeout,
    clearTimeout,
    require(name) {
      if (name === "react/jsx-runtime") {
        const render = (type, props) => {
          rendered = { type, props };
          return rendered;
        };
        return { jsx: render, jsxs: render };
      }
      assert.equal(name, "react");
      return {
        useEffect(callback) {
          effect = callback;
        },
        useState() {
          return [
            null,
            (value) => {
              notices.push(value);
              if (value) handled();
            },
          ];
        },
      };
    },
  });
  rendered = exports.DataHubHostBridge({
    request: {
      id: "native-ui-fixture",
      method: "input",
      title,
      placeholder: "{}",
    },
    onRespond(request, response) {
      assert.equal(request.id, "native-ui-fixture");
      responses.push(response);
      handled();
    },
  });
  const cleanup = effect();
  return {
    responses,
    notices,
    sent,
    async reply(value) {
      await posting;
      peer.postMessage(JSON.stringify(value));
      await handling;
    },
    rendered,
    close() {
      cleanup?.();
      peer?.close();
    },
  };
}

test("Host status is an overlay and cannot push the message column", () => {
  const f = bridge("DataHub workspace import");
  try {
    assert.equal(f.rendered.type, "div");
    assert.equal(f.rendered.props.style.position, "absolute");
    assert.equal(f.rendered.props.style.inset, 0);
    assert.equal(f.rendered.props.style.pointerEvents, "none");
    assert.equal(f.rendered.props.children.props.role, "status");
  } finally {
    f.close();
  }
});

test("unknown Host outcome leaves the native Decision waiting; it is not a human answer", async () => {
  const f = bridge("DataHub task decision");
  try {
    await f.reply({
      state: "unconfirmed",
      note: "Question write may have committed; read before retrying.",
    });
    assert.equal(
      f.responses.length,
      0,
      "indeterminate transport status must not consume the native UI request",
    );
    assert(
      f.notices.some(
        (value) =>
          typeof value === "string" && /waiting|reconcile/i.test(value),
      ),
    );
  } finally {
    f.close();
  }
});

test("deterministic Host rejection settles the native request as a tool error", async () => {
  const f = bridge("DataHub workspace import");
  try {
    await f.reply({
      state: "unconfirmed",
      error: "workspace_no_changes",
      note: "The trusted Host rejected this request; no human answer was recorded.",
    });
    assert.equal(f.responses.length, 1);
    assert.equal(
      JSON.parse(f.responses[0].value).error,
      "workspace_no_changes",
    );
  } finally {
    f.close();
  }
});

test("unknown Host outcome leaves the native request waiting", async () => {
  const f = bridge("DataHub workspace import");
  try {
    await f.reply({
      state: "unconfirmed",
      note: "The write outcome is unknown; reconcile before retrying.",
    });
    assert.equal(f.responses.length, 0);
    assert(f.notices.some((value) => /waiting|reconcile/i.test(value)));
  } finally {
    f.close();
  }
});

test("only a committed human RESPOND completes the native Decision", async () => {
  const f = bridge("DataHub task decision");
  try {
    const result = {
      response: {
        action: "RESPOND",
        text: "Continue",
        actor: "urn:li:corpuser:fixture",
      },
      runVersion: "3",
    };
    await f.reply(result);
    assert.equal(f.responses.length, 1);
    assert.equal(f.responses[0].value, JSON.stringify(result));
    assert.equal(f.sent[0].uiRequestId, "native-ui-fixture");
  } finally {
    f.close();
  }
});

test("standalone Task requests settle with an explicit missing-Host error", () => {
  const f = bridge("DataHub task decision", false);
  try {
    assert.equal(f.responses.length, 1);
    assert.equal(
      JSON.parse(f.responses[0].value).error,
      "datahub_host_required",
    );
  } finally {
    f.close();
  }
});

test("Discovery uses its read-only Host channel and does not consume a Task Decision", async () => {
  const f = bridge("DataHub discovery request");
  try {
    const result = {
      requestId: "fixture",
      candidates: [],
      publicationAuthorized: false,
    };
    await f.reply(result);
    assert.equal(f.sent[0].type, "datahub-discovery");
    assert.equal(f.responses.length, 1);
    assert.equal(f.responses[0].value, JSON.stringify(result));
  } finally {
    f.close();
  }
  const standalone = bridge("DataHub discovery request", false);
  try {
    assert.equal(
      JSON.parse(standalone.responses[0].value).error,
      "datahub_host_required",
    );
  } finally {
    standalone.close();
  }
});

for (const kind of ["semantic", "catalog"])
  test(`${kind} uses its own read-only channel and fails outside the trusted parent`, async () => {
    const f = bridge(`DataHub ${kind} request`);
    try {
      await f.reply({ publicationAuthorized: false, changes: [] });
      assert.equal(f.sent[0].type, `datahub-${kind}`);
      assert.equal(f.responses.length, 1);
    } finally {
      f.close();
    }
    const standalone = bridge(`DataHub ${kind} request`, false);
    try {
      assert.equal(
        JSON.parse(standalone.responses[0].value).error,
        "datahub_host_required",
      );
    } finally {
      standalone.close();
    }
  });

test("ingestion keeps its existing unconfirmed-result and missing-host behavior", async () => {
  for (const embedded of [true, false]) {
    const f = bridge("DataHub ingestion request", embedded);
    try {
      if (embedded) await f.reply({ state: "unconfirmed" });
      assert.equal(f.responses.length, 1);
    } finally {
      f.close();
    }
  }
});
