// Actual Host -> fixed Python capture -> isolated validation; identity is an
// explicit synthetic test context. No model, login, activation or deployment.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativeDiscovery, discoveryPolicies } from "../extensions/datahub-agent/integration/native-discovery.mjs";
import { createPluginDevelopment } from "../extensions/datahub-agent/integration/plugin-development.mjs";
import { candidateDigest } from "../extensions/datahub-agent/pi-web/lib/discovery-plugin-candidates.ts";

const [sourcePath, outputPath] = process.argv.slice(2);
assert(sourcePath && outputPath, "usage: node tests/check_discovery_authoring_host.mjs OFFICIAL_RESOURCE_DIRECTORY NEW_EVIDENCE_DIRECTORY");
const directory = resolve(outputPath);
await mkdir(directory, { mode: 0o700 });
const actor = { tenant: "test-authoring", urn: "urn:li:corpuser:synthetic-authoring-test" };
actor.key = createHash("sha256").update(JSON.stringify([actor.tenant, actor.urn])).digest("hex").slice(0, 48);
const source = { sourceId: "official-analytics-yaml", root: resolve(sourcePath), workspace: true, modelContextApproved: true, catalogScopes: {} };
const sources = discoveryPolicies({ [actor.key]: [source] }).get(actor.key);
const image = "sha256:98b0694e67703054fdf99179f570a98f19fb4142081719d46316d29718fbe2fa";
const development = createPluginDevelopment({ actors: [{ tenant: actor.tenant, key: actor.key }],
  referenceSourceId: source.sourceId, image, evidenceRoot: join(directory, "runs") });
const context = { actor, sources, assertActive() {}, pluginDevelopment: development };
const request = (action, extra = {}) => JSON.stringify({ requestId: randomUUID(), action: `plugin_development_${action}`, ...extra });
const checks = [];
const contract = await nativeDiscovery(request("contract"), context);
assert.equal(contract.format, "dataflow-discovery.authoring-contract/1");
assert.equal(contract.candidateExecutionAvailable, true);
assert.equal(contract.files.length, 3);
assert.equal(contract.activationAuthorized, false);
assert.equal(contract.publicationAuthorized, false);
checks.push("actual fixed contract via native Discovery/Python");
const references = await nativeDiscovery(request("references"), context);
for (const id of ["asset-plugin", "language-plugin"]) {
  assert(references.references.some(item => item.referenceId === id && item.kind === "documentation"));
  const document = await nativeDiscovery(request("reference", { referenceId: id }), context);
  const text = await readFile(new URL(`../extensions/datahub-agent/pi-web/skills/discovery-plugin-dev/references/${id}.md`, import.meta.url), "utf8");
  assert.equal(document.file.text, text);
  assert.equal(document.file.sha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(document.authority, "REFERENCE_ONLY");
  assert.equal(document.suiteDigest, contract.suiteDigest);
  assert.equal(document.activationAuthorized, false);
  await assert.rejects(nativeDiscovery(request("verify", { referenceId: id }), context), /development_reference_unknown/);
}
checks.push("fixed skill reference documents are readable, source-bound and not executable test inputs");
const referenceId = references.references[0].referenceId;
const reference = await nativeDiscovery(request("reference", { referenceId }), context);
assert.equal(reference.source.files.length, 1);
assert.equal(reference.source.files[0].text, await readFile(join(resolve(sourcePath), "open-api.yaml"), "utf8"));
assert.equal(reference.snapshotSha256, references.references[0].snapshotSha256);
checks.push("actual official YAML read without conversion, enrichment or business API calls");
await assert.rejects(nativeDiscovery(request("contract"), { ...context, pluginDevelopment: undefined }), /development_not_enabled/);
await assert.rejects(nativeDiscovery(request("contract"), { ...context, actor: { ...actor, key: "0".repeat(48) } }), /development_not_authorized/);
await assert.rejects(nativeDiscovery(request("reference", { referenceId: "arbitrary-path" }), context), /development_reference_unknown/);
checks.push("opt-in actor/reference authorization fail closed");
const files = { "plugin.py": 'raise AssertionError("candidate MUST NOT be imported with an invalid manifest")\n' + "# source capsule\n".repeat(800), "manifest.json": "{}" };
const candidate = { candidateId: randomUUID(), candidateDigest: candidateDigest(files), files, verified: false, activationAuthorized: false };
const verifyRequest = request("verify", { sessionId: randomUUID(), referenceId, candidate });
assert(Buffer.byteLength(verifyRequest) > 8192);
const verification = await nativeDiscovery(verifyRequest, context);
assert.equal(verification.format, "dataflow-discovery.candidate-verification/1");
assert.equal(verification.status, "FAIL");
assert.equal(verification.candidateDigest, candidate.candidateDigest);
assert.equal(verification.activationAuthorized, false);
const execution = JSON.parse(await readFile(join(directory, "runs", verification.checks[0].executionId, "result.json"), "utf8"));
assert.deepEqual(execution.phases.map(phase => phase.name), ["prepare"]);
assert(execution.containers.every(container => container.removed && container.finalState.pid === 0));
checks.push("source capsule above 8KB reaches isolated prepare; invalid manifest never imports code");
await assert.rejects(nativeDiscovery(request("verify", { sessionId: randomUUID(), referenceId, candidate: { ...candidate, candidateDigest: "0".repeat(64) } }), context), /candidate_revision_drift/);
await assert.rejects(nativeDiscovery(JSON.stringify({ action: "list_plugins", requestId: randomUUID(), padding: "x".repeat(9000) }), context), /invalid_discovery_request/);
checks.push("capsule drift denied; legacy 8KB limit preserved");
await writeFile(join(directory, "report.json"), JSON.stringify({ scope: "actual source + Host route + isolated input rejection; synthetic actor", checks,
  contractDigest: contract.contractDigest, suiteDigest: contract.suiteDigest, snapshotSha256: reference.snapshotSha256, verification,
  realModel: false, freshIdentity: false, activation: false, deployment: false, metadataWrites: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ status: "PASS", checks, modelExecuted: false, candidateImported: false, metadataWrites: false }));
