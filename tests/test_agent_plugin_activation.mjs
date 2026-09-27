// Synthetic admission artifacts only. No candidate is executed and these PASS
// fixture fields are NOT deployment/semantic verification evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginActivationPolicies, createPluginActivations } from "../extensions/datahub-agent/integration/plugin-activation.mjs";
import { candidateDigest } from "../extensions/datahub-agent/pi-web/lib/discovery-plugin-candidates.ts";
import { canonicalPublicationJson } from "../extensions/datahub-agent/integration/publication-review.mjs";
import { nativeDiscovery } from "../extensions/datahub-agent/integration/native-discovery.mjs";
import { startAgentServer } from "../extensions/datahub-agent/integration/server.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const actor = { tenant: "fixture-tenant", key: "a".repeat(48), urn: "urn:li:corpuser:fixture" };
const source = { sourceId: "fixture-source", root: "/fixture", workspace: true, modelContextApproved: true };
const image = "sha256:" + "1".repeat(64);
const contractDigest = "2".repeat(64), suiteDigest = "3".repeat(64), snapshot = "4".repeat(64);
const config = { serviceId: "fixture-service" };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "discovery-activation-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { id: "fixture-yaml", version: "0.1.0", contractVersion: "1", kind: "asset", limitations: ["fixture only"] };
  const files = { "plugin.py": 'raise AssertionError("never import candidate while reading approval")\n', "manifest.json": JSON.stringify(manifest) };
  const entry = { pluginId: manifest.id, candidateId: randomUUID(), candidateDigest: candidateDigest(files), sessionId: randomUUID(), verificationId: randomUUID(), verificationSha256: "0".repeat(64), sourceId: source.sourceId, selection: "open-api.yaml", config };
  const checks = [];
  for (const name of ["official-reference", "scalar-variation", "unresolved-reference"]) {
    const executionId = randomUUID(), directory = join(root, executionId), stageDigests = {};
    await mkdir(join(directory, "stage", "candidate"), { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      await writeFile(join(directory, "stage", "candidate", file), text);stageDigests["candidate/" + file] = hash(text);
    }
    const resultDigest = hash(name);
    await writeFile(join(directory, "intent.json"), JSON.stringify({ candidateDigest: entry.candidateDigest, stageDigests }));
    await writeFile(join(directory, "result.json"), JSON.stringify({ status: "PASS", candidateDigest: entry.candidateDigest, image,
      result: { resultDigest, contractDigest, snapshotSha256: snapshot, plugin: manifest, sourceId: source.sourceId, configDigest: hash(canonicalPublicationJson(config)) },
      phases: ["prepare", "candidate", "validate"].map(name => ({ name, profileVerified: true, exitCode: 0, oomKilled: false })),
      containers: [0, 1, 2].map(() => ({ owned: true, removed: true, finalState: { pid: 0 } })) }));
    checks.push({ name, executionId, resultDigest, snapshotSha256: snapshot, technicalStatus: "PASS", semanticMatch: true });
  }
  const receipt = { format: "dataflow-discovery.candidate-verification/1", status: "PASS", actor: { tenant: actor.tenant, urn: actor.urn }, ...entry, plugin: manifest, image, suite: "openapi-scalar-yaml/1", suiteDigest, snapshotSha256: snapshot, referenceId: "official-analytics-openapi-yaml", checks };
  const path = join(root, `verification-${entry.verificationId}.json`);
  await writeFile(path, JSON.stringify(receipt));entry.verificationSha256 = hash(await readFile(path));
  const development = { async handle() { return { suiteDigest, contractDigest, runtime: { image } }; } };
  const context = { actor, sources: [source], assertActive() {}, async bridge() { throw new Error("capture must not run in admission-only fixture"); } };
  const host = createPluginActivations({ actor, entries: [entry], development, evidenceRoot: root, image });
  return { root, entry, receipt, path, development, context, host };
}

test("operator allowlist is closed, source-bound and cannot replace builtins", () => {
  const development = { [actor.key]: { referenceSourceId: source.sourceId } }, sources = new Map([[actor.key, [source]]]);
  const entry = { pluginId: "fixture-yaml", candidateId: randomUUID(), candidateDigest: "1".repeat(64), sessionId: randomUUID(), verificationId: randomUUID(), verificationSha256: "2".repeat(64), sourceId: source.sourceId, selection: "open-api.yaml", config };
  assert.equal(pluginActivationPolicies({ [actor.key]: [entry] }, development, sources).get(actor.key).length, 1);
  for (const value of [null, [], { bad: [] }, { [actor.key]: {} }]) assert.throws(() => pluginActivationPolicies(value, development, sources), /invalid_plugin_activation_configuration/);
  for (const patch of [{ pluginId: "legacy-static" }, { pluginId: "openapi-operations" }, { sourceId: "other" }, { selection: "../secret" }, { candidateDigest: "bad" }, { sessionId: "bad" }, { modulePath: "/tmp/code.py" }, { config: [] }]) {
    assert.throws(() => pluginActivationPolicies({ [actor.key]: [{ ...entry, ...patch }] }, development, sources), /invalid_plugin_activation_configuration/);
  }
  assert.throws(() => pluginActivationPolicies({ [actor.key]: [entry, entry] }, development, sources), /invalid_plugin_activation_configuration/);
  assert.throws(() => pluginActivationPolicies({ [actor.key]: [entry] }, {}, sources), /invalid_plugin_activation_configuration/);
  assert.throws(() => pluginActivationPolicies({ [actor.key]: [entry] }, development, new Map()), /invalid_plugin_activation_configuration/);
});

test("admission returns exact revision without importing its throwing source; empty policy disables it", async t => {
  const f = await fixture(t);const listed = await f.host.list(f.context);
  assert.equal(listed.length, 1);assert.equal(listed[0].activation.candidateDigest, f.entry.candidateDigest);
  assert.equal(listed[0].activation.executionBoundary, "credential-free-isolated");assert.equal(listed[0].activation.publicationAuthorized, false);
  const disabled = createPluginActivations({ actor, entries: [], development: f.development, evidenceRoot: f.root, image });
  assert.deepEqual(await disabled.list(f.context), []);assert.equal(disabled.has(f.entry.pluginId), false);
});

test("wrong actor/source, config or selection is denied before candidate execution", async t => {
  const f = await fixture(t);
  await assert.rejects(f.host.list({ ...f.context, actor: { ...actor, key: "b".repeat(48) } }), /activation_not_authorized/);
  await assert.rejects(f.host.list({ ...f.context, sources: [] }), /activation_not_authorized/);
  await assert.rejects(f.host.list({ ...f.context, actor: { ...actor, urn: "urn:li:corpuser:other" } }), /activation_verification_rejected/);
  for (const patch of [{ selection: "." }, { pluginConfig: {} }, { connections: {} }, { pythonPath: "file.py" }, { pluginId: "other" }]) {
    await assert.rejects(f.host.analyze(source, { pluginId: f.entry.pluginId, selection: "open-api.yaml", pluginConfig: config, ...patch }, f.context), /activation_scope_rejected/);
  }
});

test("client snapshot expectation is honored before capture or execution", async t => {
  const f = await fixture(t);
  await assert.rejects(f.host.analyze(source, { pluginId: f.entry.pluginId, selection: "open-api.yaml", pluginConfig: config,
    snapshotSha256: "0".repeat(64) }, f.context), /workspace_source_drift/);
});

test("receipt and candidate byte drift fail closed, not old cached approval", async t => {
  const f = await fixture(t);await f.host.list(f.context);
  await writeFile(f.path, "{}");await assert.rejects(f.host.list(f.context), /activation_verification_drift/);
  await writeFile(f.path, JSON.stringify(f.receipt));
  await writeFile(join(f.root, f.receipt.checks[0].executionId, "stage/candidate/plugin.py"), "print('forged PASS')\n");
  await assert.rejects(f.host.list(f.context), /activation_stage_drift/);
});

test("stale suite and changed current validator are rejected", async t => {
  const f = await fixture(t);
  const stale = createPluginActivations({ actor, entries: [f.entry], development: { async handle() { return { suiteDigest: "0".repeat(64), contractDigest, runtime: { image } }; } }, evidenceRoot: f.root, image });
  await assert.rejects(stale.list(f.context), /activation_suite_drift/);
  const directory = join(f.root, f.receipt.checks[0].executionId), name = "framework/dataflow_discovery/plugin_api.py";
  await mkdir(join(directory, "stage/framework/dataflow_discovery"), { recursive: true });await writeFile(join(directory, "stage", name), "# stale validator\n");
  const path = join(directory, "intent.json"), intent = JSON.parse(await readFile(path));intent.stageDigests[name] = hash("# stale validator\n");await writeFile(path, JSON.stringify(intent));
  await assert.rejects(f.host.list(f.context), /activation_framework_drift/);
});

test("candidate artifact symlinks are never followed", async t => {
  const f = await fixture(t), path = join(f.root, f.receipt.checks[0].executionId, "stage/candidate/plugin.py");
  await rm(path);await symlink(f.path, path);await assert.rejects(f.host.list(f.context), /activation_unavailable/);
});

test("browser/model cannot request activation; invalid operator configuration fails before Docker", async () => {
  await assert.rejects(nativeDiscovery(JSON.stringify({ action: "activate_plugin", requestId: randomUUID() }), { actor, sources: [source], assertActive() {} }), /invalid_discovery_request/);
  await assert.rejects(startAgentServer({ browserAssetsDirectory: "/missing", pluginActivationsByActor: null }), /invalid_plugin_activation_configuration/);
});
