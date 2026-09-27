// Operator-approved exact candidate + real source + actual sandbox execution.
// Identity here is a Host harness context, NOT fresh browser authentication.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createPluginActivations, pluginActivationPolicies } from "../extensions/datahub-agent/integration/plugin-activation.mjs";
import { createPluginDevelopment } from "../extensions/datahub-agent/integration/plugin-development.mjs";
import { nativeDiscovery, discoveryPolicies } from "../extensions/datahub-agent/integration/native-discovery.mjs";
import { isPluginPreview } from "../extensions/datahub-agent/pi-web/lib/discovery-plugin-preview.ts";

const [rootArg, authorityArg, sourceArg, outputArg] = process.argv.slice(2);
assert(rootArg && authorityArg && sourceArg && outputArg, "VERIFICATION_ROOT EXACT_APPROVAL_FILE OFFICIAL_SOURCE_ROOT NEW_OUTPUT_DIRECTORY required");
const evidenceRoot = resolve(rootArg), directory = resolve(outputArg), authority = JSON.parse(await readFile(resolve(authorityArg), "utf8"));
assert.equal(authority.candidateDigest, "6bf8ab29051fbd4cb8e2bf0b311aefdc63fc20bcf33038aec495e0fc665b14b9");
assert.equal(authority.scope, "ekop-discovery-test");assert.equal(authority.metadataPublicationApproved, false);
await mkdir(directory, { mode: 0o700 });
const encoded = await readFile(join(evidenceRoot, `verification-${authority.verificationId}.json`));
const receipt = JSON.parse(encoded);assert.equal(receipt.status, "PASS");assert.equal(receipt.candidateId, authority.candidateId);assert.equal(receipt.candidateDigest, authority.candidateDigest);
const actor = { ...receipt.actor, key: createHash("sha256").update(JSON.stringify([receipt.actor.tenant, receipt.actor.urn])).digest("hex").slice(0, 48) };
const source = { sourceId: "official-analytics-openapi-yaml", root: resolve(sourceArg), workspace: true, modelContextApproved: true, catalogScopes: {} };
const scopes = discoveryPolicies({ [actor.key]: [source] });
const policy = { referenceSourceId: source.sourceId, image: receipt.image, evidenceRoot };
const development = createPluginDevelopment({ ...policy, actors: [{ tenant: actor.tenant, key: actor.key }] });
const entry = { pluginId: receipt.plugin.id, candidateId: receipt.candidateId, candidateDigest: receipt.candidateDigest, sessionId: receipt.sessionId, verificationId: receipt.verificationId,
  verificationSha256: createHash("sha256").update(encoded).digest("hex"), sourceId: source.sourceId, selection: "open-api.yaml", config: { serviceId: "datahub-analytics" } };
const entries = pluginActivationPolicies({ [actor.key]: [entry] }, { [actor.key]: policy }, scopes).get(actor.key);
const make = entries => createPluginActivations({ actor, entries, development, evidenceRoot, image: receipt.image });
const context = { actor, sources: scopes.get(actor.key), assertActive() {}, pluginDevelopment: development, pluginActivations: make(entries) };
const request = extra => JSON.stringify({ requestId: randomUUID(), ...extra });
const listing = await nativeDiscovery(request({ action: "list_plugins" }), context);
assert.equal(listing.plugins.length, 3);assert(listing.plugins.some(p => p.manifest.id === "legacy-static"));assert(listing.plugins.some(p => p.manifest.id === "openapi-operations"));
assert.equal(listing.plugins.find(p => p.manifest.id === entry.pluginId).activation.candidateDigest, entry.candidateDigest);
const intent = { action: "analyze_workspace", sourceId: entry.sourceId, selection: entry.selection, pluginId: entry.pluginId, pluginConfig: entry.config };
await assert.rejects(nativeDiscovery(request({ ...intent, selection: "." }), context), /activation_scope_rejected/);
await assert.rejects(nativeDiscovery(request({ ...intent, pluginConfig: { serviceId: "other" } }), context), /activation_scope_rejected/);
const preview = await nativeDiscovery(request(intent), context);
assert(isPluginPreview(preview));assert.equal(preview.activation.candidateDigest, entry.candidateDigest);
assert.equal(preview.result.plugin.version, "0.1.1");assert.equal(preview.result.graph.nodes.length, 3);assert.deepEqual(preview.result.graph.edges, []);
assert.equal(preview.result.coverageComplete, true);assert.equal(preview.publicationAuthorized, false);assert.equal(preview.result.runtimeVerified, false);
const execution = JSON.parse(await readFile(join(evidenceRoot, "activated", preview.activation.executionId, "result.json"), "utf8"));
assert.equal(execution.status, "PASS");assert.deepEqual(execution.phases.map(p => p.name), ["prepare", "candidate", "validate"]);
assert(execution.containers.every(c => c.removed && c.finalState.pid === 0));assert(execution.phases.every(p => p.profileVerified && p.exitCode === 0 && !p.oomKilled));
const reloaded = await nativeDiscovery(request({ action: "list_plugins" }), { ...context, pluginActivations: make(entries) });
assert.deepEqual(reloaded.plugins, listing.plugins);
const disabledContext = { ...context, pluginActivations: make([]) };
const disabled = await nativeDiscovery(request({ action: "list_plugins" }), disabledContext);
assert.deepEqual(disabled.plugins.map(p => p.manifest.id).sort(), ["legacy-static", "openapi-operations"]);
await assert.rejects(nativeDiscovery(request(intent), disabledContext), /plugin_not_registered/);
const report = { status: "PASS", scope: "approved real candidate/source and actual sandbox via normal nativeDiscovery; harness identity, not browser E2E", entry,
  executionId: execution.executionId, checks: ["normal list contains exact activated revision plus both builtins", "selection/config scope rejects before execution", "normal analyze executes only in isolated prepare/candidate/validate", "existing browser preview guard accepts actual output", "fresh activation manager reload retains exact binding", "empty operator policy disables discovery without deleting history; no fallback"],
  liveOperatorConfigChanged: false, metadataWritten: false, freshBrowserIdentity: false };
await writeFile(join(directory, "preview.json"), JSON.stringify(preview, null, 2) + "\n", { flag: "wx", mode: 0o600 });
await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
