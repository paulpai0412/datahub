import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  discoveryPolicies,
  nativeDiscovery,
  analyzeDiscovery,
} from "../extensions/datahub-agent/integration/native-discovery.mjs";
import extension from "../extensions/datahub-agent/pi-web/lib/datahub-discovery-extension.ts";
import { installDiscoveryBridge } from "../extensions/datahub-agent/mfe/discovery.js";
import { setImmediate } from "node:timers/promises";

const actor = {
  tenant: "fixture",
  urn: "urn:li:corpuser:fixture",
  key: "a".repeat(48),
};
const id = "00000000-0000-4000-8000-000000000001";
const policy = {
  sourceId: "fixture",
  root: "/approved",
  paths: ["pipeline.py"],
  snapshotSha256: "a".repeat(64),
  modelContextApproved: true,
};
const intent = (extra = {}) =>
  JSON.stringify({
    requestId: id,
    action: "analyze",
    sourceId: "fixture",
    ...extra,
  });
function context(overrides = {}) {
  return {
    actor,
    sources: discoveryPolicies({ [actor.key]: [policy] }).get(actor.key),
    assertActive() {},
    async analyze() {
      throw new Error("Unexpected parser invocation");
    },
    ...overrides,
  };
}

test("Discovery policy is operator-owned, exact-byte and opt-in", () => {
  for (const update of [
    { modelContextApproved: false },
    { modelContextApproved: undefined },
    { root: "relative" },
    { paths: ["../private"] },
    { paths: ["/private"] },
    { paths: ["a.py", "a.py"] },
    { snapshotSha256: "stale" },
    { endpoint: "http://other" },
  ])
    assert.throws(
      () => discoveryPolicies({ [actor.key]: [{ ...policy, ...update }] }),
      /invalid_discovery_policy/,
    );
  assert.throws(() => discoveryPolicies({ forged: [policy] }));
  assert.throws(() => discoveryPolicies({ [actor.key]: [policy, policy] }));
  const saved = discoveryPolicies({ [actor.key]: [policy] }).get(actor.key);
  assert.ok(
    Object.isFrozen(saved) &&
      Object.isFrozen(saved[0]) &&
      Object.isFrozen(saved[0].paths),
  );
  assert.equal(discoveryPolicies().size, 0);
});

test("source list excludes host paths and analysis requires the actor allowlist", async () => {
  const result = await nativeDiscovery(
    JSON.stringify({ requestId: id, action: "list_sources" }),
    context(),
  );
  assert.deepEqual(result, {
    requestId: id,
    sources: [{ sourceId: "fixture", snapshotSha256: policy.snapshotSha256 }],
    publicationAuthorized: false,
  });
  await assert.rejects(
    nativeDiscovery(intent(), context({ sources: [] })),
    /source_not_authorized/,
  );
  await assert.rejects(
    nativeDiscovery(intent(), context({ actor: {} })),
    /identity_required/,
  );
});

test("model cannot provide root, actor, policy, endpoint, SQL or publication intent", async () => {
  for (const extra of [
    { root: "/etc" },
    { paths: ["private.py"] },
    { actor },
    { tenant: "other" },
    { snapshotSha256: policy.snapshotSha256 },
    { policy },
    { endpoint: "http://other" },
    { sql: "SELECT 1" },
    { action: "publish" },
    { offset: 1 },
    { offset: -1 },
    { limit: 11 },
    { candidateDigest: "bad" },
    { action: "list_sources", sourceId: "fixture" },
  ])
    await assert.rejects(
      nativeDiscovery(intent(extra), context()),
      /invalid_discovery_request/,
    );
  await assert.rejects(
    nativeDiscovery("{private invalid", context()),
    /invalid_discovery_request/,
  );
});

test("grant checked before analysis and again before returning source-derived data", async () => {
  let active = true;
  const ctx = context({
    assertActive() {
      assert.ok(active, "grant revoked");
    },
    async analyze(selected, request) {
      assert.equal(selected.root, policy.root);
      assert.equal(request.sourceId, "fixture");
      active = false;
      return { candidates: ["must not return"] };
    },
  });
  await assert.rejects(nativeDiscovery(intent(), ctx), /grant revoked/);
  let calls = 0;
  ctx.analyze = async () => {
    calls++;
  };
  await assert.rejects(nativeDiscovery(intent(), ctx), /grant revoked/);
  assert.equal(calls, 0);
});

test("real isolated Python capture/page bridge: no source execution, digest-bound pages, drift denied", async (t) => {
  const root = await mkdtemp("/tmp/discovery-host-");
  t.after(() => rm(root, { recursive: true }));
  const sentinel = join(root, "executed");
  const text = `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).touch()\nSQL = "SELECT id AS ident FROM dbo.orders"\n`;
  await writeFile(join(root, "pipeline.py"), text);
  // A trusted operator computes approval on synthetic test input; not part of the request API.
  const packagePath = fileURLToPath(
    new URL("../extensions/dataflow-discovery/src/", import.meta.url),
  );
  const python = fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
  const snapshotSha256 = execFileSync(
    python,
    [
      "-I",
      "-B",
      "-c",
      "import sys;sys.path.insert(0,sys.argv[1]);from dataflow_discovery.snapshot import capture_snapshot;print(capture_snapshot(sys.argv[2],['pipeline.py'],source_id='fixture').sha256)",
      packagePath,
      root,
    ],
    { encoding: "utf8" },
  ).trim();
  const selected = { ...policy, root, snapshotSha256 };
  const first = await analyzeDiscovery(selected, { offset: 0, limit: 1 });
  assert.equal(first.candidates.length, 1);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.publicationAuthorized, false);
  assert.equal(first.analysisVersion, "1.0.2");
  assert.ok(!JSON.stringify(first).includes(root));
  const second = await analyzeDiscovery(selected, {
    offset: first.nextOffset,
    limit: 1,
    candidateDigest: first.candidateDigest,
  });
  assert.notEqual(
    first.candidates[0].candidate_id,
    second.candidates[0].candidate_id,
  );
  assert.equal(first.candidateDigest, second.candidateDigest);
  await assert.rejects(
    analyzeDiscovery(selected, { offset: 1, candidateDigest: "0".repeat(64) }),
    /analysis_drift/,
  );
  await writeFile(
    join(root, "pipeline.py"),
    text + "# changed after approval\n",
  );
  await assert.rejects(
    analyzeDiscovery(selected, { offset: 0 }),
    /source_drift/,
  );
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(sentinel));
});

test("parent Discovery bridge isolates frame/origin, rejects writes, cancels on unmount", async () => {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  const source = {};
  const frame = { contentWindow: source };
  const origin = "http://fixture.localhost:30150";
  const sent = [];
  let signal;
  let finish;
  const cleanup = installDiscoveryBridge({
    frame,
    origin,
    send(request, requestSignal) {
      sent.push(request);
      signal = requestSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const replies = [];
  function dispatch(overrides = {}) {
    const event = Object.assign(new Event("message"), {
      source,
      origin,
      data: { type: "datahub-discovery", body: intent() },
      ports: [
        {
          postMessage(value) {
            replies.push(JSON.parse(value));
          },
          close() {},
        },
      ],
      ...overrides,
    });
    globalThis.window.dispatchEvent(event);
  }
  try {
    dispatch({ source: {} });
    dispatch({ origin: "http://other.localhost:30150" });
    assert.equal(sent.length, 0);
    dispatch({
      data: { type: "datahub-discovery", body: intent({ action: "publish" }) },
    });
    assert.equal(sent.length, 0);
    dispatch();
    assert.equal(sent.length, 1);
    dispatch();
    assert.equal(replies.at(-1).error, "discovery_request_busy");
    cleanup();
    assert.equal(signal.aborted, true);
    const before = replies.length;
    finish({ candidates: ["must not be delivered after unmount"] });
    await setImmediate();
    assert.equal(replies.length, before);
    dispatch();
    assert.equal(sent.length, 1);
  } finally {
    cleanup();
    globalThis.window = previous;
  }
});

test("native Pi tool sends only intent and checks response correlation and no publication authority", async () => {
  let tool;
  extension({
    registerTool(value) {
      tool = value;
    },
  });
  assert.equal(tool.name, "dataflow_discovery");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(!("root" in tool.parameters.properties));
  const execute = (params, response, mode = "rpc") =>
    tool.execute("call", params, undefined, undefined, {
      mode,
      ui: {
        async input(title, body) {
          assert.equal(title, "DataHub discovery request");
          return response(JSON.parse(body));
        },
      },
    });
  const result = await execute({ action: "list_sources" }, (request) =>
    JSON.stringify({
      requestId: request.requestId,
      sources: [],
      publicationAuthorized: false,
    }),
  );
  assert.equal(result.details.publicationAuthorized, false);
  await assert.rejects(
    execute({ action: "analyze" }, () => ""),
    /sourceId/,
  );
  await assert.rejects(
    execute({ action: "analyze", sourceId: "fixture", offset: 1 }, () => ""),
    /Pagination/,
  );
  await assert.rejects(
    execute({ action: "list_sources" }, () => "{}", "tui"),
    /host_required/,
  );
  for (const response of [
    () => undefined,
    () => "{invalid",
    () => JSON.stringify({ requestId: id, publicationAuthorized: false }),
    (request) =>
      JSON.stringify({
        requestId: request.requestId,
        publicationAuthorized: true,
      }),
  ])
    await assert.rejects(execute({ action: "list_sources" }, response));
});
