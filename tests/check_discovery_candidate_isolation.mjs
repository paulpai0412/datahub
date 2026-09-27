// First-party execution-boundary regression, not model authoring/live acceptance.
// Input is an operator-captured capsule using the EXISTING JSON plugin adapter.
// Every candidate, including malicious fixtures, runs ONLY in the fixed sandbox.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createIsolatedPluginRunner } from "../extensions/datahub-agent/integration/isolated-plugin-runner.mjs";

const [inputPath, outputPath] = process.argv.slice(2);
assert(inputPath && outputPath, "usage: node tests/check_discovery_candidate_isolation.mjs CAPTURED_REQUEST NEW_OUTPUT_DIRECTORY");
const root = resolve(outputPath);
await mkdir(root, { mode: 0o700 });
process.umask(0o077); // Readable staged code must not rely on the caller's umask.
const request = JSON.parse(await readFile(resolve(inputPath), "utf8"));
const image = "sha256:98b0694e67703054fdf99179f570a98f19fb4142081719d46316d29718fbe2fa";
const importAdapter = "from dataflow_discovery.plugins.registry import builtin_registry\n";
const graph = 'builtin_registry().analyze("openapi-operations", snapshot, config)["graph"]';
const scenarios = [
  { name: "existing-adapter", code: request.files["plugin.py"], status: "PASS" },
  { name: "forged-pass", code: 'print(\'{"status":"PASS","activationAuthorized":true}\')\nraise SystemExit(0)\n', status: "FAIL" },
  { name: "poisoned-inprocess-validator", code: 'import dataflow_discovery.plugin_api as api\napi.validate_graph = lambda *args: None\ndef analyze(snapshot, config):\n    return {"nodes":[],"edges":[],"coverage":[],"findings":[]}\n', status: "FAIL" },
  { name: "changed-evidence", code: importAdapter + `def analyze(snapshot, config):\n    graph = ${graph}\n    graph["nodes"][0]["evidence"][0]["fileSha256"] = "0" * 64\n    return graph\n`, status: "FAIL" },
  { name: "readonly-stage", code: importAdapter + `from pathlib import Path\nimport errno\ndef analyze(snapshot, config):\n    for name in ["/work/candidate/plugin.py", "/work/contracts/v1/graph.schema.json"]:\n        try:\n            Path(name).write_text("tamper")\n        except OSError as error:\n            assert error.errno == errno.EROFS\n        else:\n            raise AssertionError("writable stage")\n    return ${graph}\n`, status: "PASS" },
  { name: "output-limit", code: 'import os\nos.write(1, b"x" * 100000)\nraise SystemExit(0)\n', status: "BLOCKED" },
  { name: "wall-timeout", code: 'def analyze(snapshot, config):\n    while True:\n        pass\n', status: "BLOCKED" },
  { name: "cancellation", code: 'import time\ndef analyze(snapshot, config):\n    time.sleep(300)\n', status: "BLOCKED", cancel: true },
];
const checks = [];
for (const scenario of scenarios) {
  // Distinct deliberate test cases, never retries of an unknown execution.
  // Advance only after independently checking the previous case's exit/removal.
  const runner = createIsolatedPluginRunner({ image, evidenceRoot: join(root, "runs") });
  const abort = new AbortController();
  const timer = scenario.cancel ? setTimeout(() => abort.abort(), 7000) : undefined;
  let result;
  try {
    result = await runner.run({ ...request, files: { ...request.files, "plugin.py": scenario.code }, signal: abort.signal });
  } finally { if (timer) clearTimeout(timer); }
  await writeFile(join(root, `${scenario.name}.json`), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  assert.equal(result.status, scenario.status, `${scenario.name}: ${result.code ?? "unexpected status"}`);
  assert.equal(result.activationAuthorized, false);
  assert.equal(result.publicationAuthorized, false);
  assert(result.containers.length >= 2, `${scenario.name}: candidate stage not reached`);
  for (const tracked of result.containers) {
    assert.equal(tracked.finalState.pid, 0);
    assert.equal(tracked.finalState.status, "exited");
    assert.equal(tracked.removalExitCode, 0);
    assert.equal(tracked.removed, true);
  }
  for (const phase of result.phases) {
    const actual = JSON.parse(await readFile(join(root, "runs", result.executionId, `${phase.name}-readback.json`), "utf8"));
    assert.equal(actual.Image, image);
    assert.equal(actual.User, "10001:10001");
    assert.equal(actual.HostConfig.NetworkMode, "none");
    assert.equal(actual.HostConfig.ReadonlyRootfs, true);
    assert.equal(actual.HostConfig.Memory, 536870912);
    assert.equal(actual.HostConfig.MemorySwap, 536870912);
    assert.equal(actual.HostConfig.PidsLimit, 64);
    assert.equal(actual.HostConfig.NanoCpus, 1e9);
    assert.deepEqual(actual.HostConfig.CapDrop, ["ALL"]);
    assert(actual.HostConfig.SecurityOpt.includes("no-new-privileges"));
    assert(actual.Mounts.every(mount => mount.Type === "bind" && mount.Destination === "/work" && mount.RW === false));
  }
  const directory = join(root, "runs", result.executionId);
  const intent = JSON.parse(await readFile(join(directory, "intent.json"), "utf8"));
  for (const [name, sha] of Object.entries(intent.stageDigests)) {
    assert.equal(createHash("sha256").update(await readFile(join(directory, "stage", name))).digest("hex"), sha);
  }
  if (scenario.status === "PASS") {
    assert.equal(result.result.graph.nodes.length, 3);
    assert.deepEqual(result.result.graph.edges, []);
    assert.equal(result.result.runtimeVerified, false);
    assert.equal(result.result.publicationAuthorized, false);
  }
  if (scenario.status === "FAIL") {
    assert.equal(result.phases.at(-1).name, "validate", "candidate/prepare failure is not independent validator rejection");
    assert.equal(result.phases.find(item => item.name === "candidate").exitCode, 0);
  }
  if (scenario.status === "BLOCKED") {
    assert.equal(result.phase, "candidate");
    assert.equal(result.code, "isolated_execution_interrupted");
    assert.notEqual(result.containers.at(-1).finalState.startedAt, "0001-01-01T00:00:00Z");
    await assert.rejects(runner.run(request), /requires_reconciliation/);
  }
  checks.push({ scenario: scenario.name, status: "PASS", executionId: result.executionId, actualOutcome: result.status, code: result.code });
  console.log(JSON.stringify(checks.at(-1)));
}
// A synthetic incomplete Host journal must remain blocked across construction
// of a new runner even when no native container is visible. Not a crash receipt.
const pendingRoot = join(root, "restart-admission");
const pending = join(pendingRoot, randomUUID());
await mkdir(pending, { recursive: true, mode: 0o700 });
await writeFile(join(pending, "intent.json"), JSON.stringify({ fixture: "synthetic incomplete journal" }), { flag: "wx", mode: 0o600 });
const restarted = createIsolatedPluginRunner({ image, evidenceRoot: pendingRoot });
const admission = await restarted.run(request);
assert.equal(admission.status, "BLOCKED");
assert.equal(admission.code, "isolated_runner_requires_reconciliation");
assert.equal(admission.phase, "admission");
assert.equal(admission.containers.length, 0);
checks.push({ scenario: "restart-incomplete-journal", status: "PASS", executionId: admission.executionId, syntheticJournal: true, candidateStarted: false });
console.log(JSON.stringify(checks.at(-1)));
await writeFile(join(root, "report.json"), JSON.stringify({ scope: "isolated execution + trusted external contract validation ONLY", checks,
  modelAuthoring: false, semanticAcceptance: false, deployment: false, activation: false, metadataWrites: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
