import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateFiles, candidateDigest } from "../pi-web/lib/discovery-plugin-candidates.ts";
import { canonicalPublicationJson } from "./publication-review.mjs";
import { createIsolatedPluginRunner } from "./isolated-plugin-runner.mjs";
import { DiscoveryError } from "./native-discovery.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const pluginId = /^[a-z][a-z0-9-]{0,79}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = value => createHash("sha256").update(value).digest("hex");
const same = (left, right) => canonicalPublicationJson(left) === canonicalPublicationJson(right);
const checks = ["official-reference", "scalar-variation", "unresolved-reference"];
const fields = ["pluginId", "candidateId", "candidateDigest", "sessionId", "verificationId", "verificationSha256", "sourceId", "selection", "config"];

export class PluginActivationError extends DiscoveryError {
  constructor(code, status = 409) { super(code, status); }
}
const reject = (code, status) => { throw new PluginActivationError(code, status); };

/** Deployment allowlist only. No browser/tool action can grant activation.
 * The existing operator config is the authority, not this operational evidence.
 */
export function pluginActivationPolicies(value = {}, development = {}, sources = new Map()) {
  if (!object(value)) reject("invalid_plugin_activation_configuration", 503);
  const policies = new Map();
  for (const [actorKey, entries] of Object.entries(value)) {
    const policy = development[actorKey];
    if (!/^[a-f0-9]{48}$/.test(actorKey) || !policy || !Array.isArray(entries) || entries.length > 16)
      reject("invalid_plugin_activation_configuration", 503);
    const ids = new Set();
    for (const entry of entries) {
      if (!object(entry) || Object.keys(entry).length !== fields.length || Object.keys(entry).some(name => !fields.includes(name)) ||
          !pluginId.test(entry.pluginId ?? "") || ["legacy-static", "openapi-operations"].includes(entry.pluginId) || ids.has(entry.pluginId) ||
          ![entry.candidateId, entry.sessionId, entry.verificationId].every(id => typeof id === "string" && uuid.test(id)) ||
          ![entry.candidateDigest, entry.verificationSha256].every(id => typeof id === "string" && digest.test(id)) ||
          entry.sourceId !== policy.referenceSourceId || entry.selection !== "open-api.yaml" || !object(entry.config) ||
          !(sources.get(actorKey) ?? []).some(source => source.sourceId === entry.sourceId && source.workspace && source.modelContextApproved)) {
        reject("invalid_plugin_activation_configuration", 503);
      }
      canonicalPublicationJson(entry.config);
      ids.add(entry.pluginId);
    }
    policies.set(actorKey, structuredClone(entries));
  }
  return policies;
}

/** Only Host-owned evidence files; never imports candidate code or tests. */
async function bytes(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) reject("activation_artifact_rejected");
    const value = await file.readFile();
    if (value.length > maximum) reject("activation_artifact_rejected");
    return value;
  } finally { await file.close(); }
}
const json = async path => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bytes(path, 1048576)));

function currentFrameworkPath(name) {
  if (name.startsWith("framework/dataflow_discovery/")) {
    return fileURLToPath(new URL(`../../dataflow-discovery/src/${name.slice("framework/".length)}`, import.meta.url));
  }
  if (name.startsWith("contracts/")) return fileURLToPath(new URL(`../../dataflow-discovery/${name}`, import.meta.url));
  if (["candidate_worker.py", "candidate_boundary.py"].includes(name)) {
    return fileURLToPath(new URL(`../../dataflow-discovery/testing/${name}`, import.meta.url));
  }
  return null;
}

export function createPluginActivations({ actor, entries, development, evidenceRoot, image }) {
  const approved = structuredClone(entries);
  const runner = createIsolatedPluginRunner({ image, evidenceRoot: join(evidenceRoot, "activated") });

  async function load(entry, context) {
    context.assertActive();
    if (context.actor?.tenant !== actor.tenant || context.actor?.key !== actor.key ||
        !context.sources.some(source => source.sourceId === entry.sourceId && source.workspace && source.modelContextApproved)) reject("activation_not_authorized", 403);
    const encoded = await bytes(join(evidenceRoot, `verification-${entry.verificationId}.json`), 60000);
    if (hash(encoded) !== entry.verificationSha256) reject("activation_verification_drift");
    const receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded));
    if (receipt.status !== "PASS" || receipt.format !== "dataflow-discovery.candidate-verification/1" ||
        receipt.actor?.tenant !== context.actor.tenant || receipt.actor?.urn !== context.actor.urn ||
        receipt.candidateId !== entry.candidateId || receipt.candidateDigest !== entry.candidateDigest ||
        receipt.sessionId !== entry.sessionId || receipt.verificationId !== entry.verificationId ||
        receipt.plugin?.id !== entry.pluginId || receipt.image !== image || receipt.suite !== "openapi-scalar-yaml/1" ||
        receipt.referenceId !== "official-analytics-openapi-yaml" || !Array.isArray(receipt.checks) ||
        !same(receipt.checks.map(check => check.name), checks) || receipt.checks.some(check =>
          check.technicalStatus !== "PASS" || check.semanticMatch !== true || !uuid.test(check.executionId ?? ""))) {
      reject("activation_verification_rejected");
    }
    const contract = await development.handle({ action: "plugin_development_contract", requestId: randomUUID() }, context);
    if (contract.suiteDigest !== receipt.suiteDigest || contract.runtime.image !== image) reject("activation_suite_drift");
    let files;
    for (const check of receipt.checks) {
      const directory = join(evidenceRoot, check.executionId);
      const result = await json(join(directory, "result.json"));
      const intent = await json(join(directory, "intent.json"));
      if (result.status !== "PASS" || result.candidateDigest !== entry.candidateDigest || result.image !== image ||
          result.result?.resultDigest !== check.resultDigest || result.result?.contractDigest !== contract.contractDigest ||
          result.result?.snapshotSha256 !== check.snapshotSha256 || !same(result.result.plugin, receipt.plugin) ||
          !same(result.phases?.map(phase => phase.name), ["prepare", "candidate", "validate"]) ||
          result.phases.some(phase => !phase.profileVerified || phase.exitCode !== 0 || phase.oomKilled) ||
          result.containers?.length !== 3 || result.containers.some(container => !container.owned || !container.removed || container.finalState?.pid !== 0) ||
          intent.candidateDigest !== entry.candidateDigest || !object(intent.stageDigests)) reject("activation_execution_rejected");
      for (const [name, expected] of Object.entries(intent.stageDigests)) {
        if (name.split("/").some(part => part === "..") || name.startsWith("/")) reject("activation_artifact_rejected");
        if (hash(await bytes(join(directory, "stage", name), 1048576)) !== expected) reject("activation_stage_drift");
        const current = currentFrameworkPath(name);
        if (current && hash(await bytes(current, 1048576)) !== expected) reject("activation_framework_drift");
      }
      if (check.name === "official-reference") {
        if (result.result.sourceId !== entry.sourceId || result.result.snapshotSha256 !== receipt.snapshotSha256 ||
            result.result.configDigest !== hash(canonicalPublicationJson(entry.config))) reject("activation_scope_rejected", 403);
        const directoryNames = await readdir(join(directory, "stage", "candidate"));
        if (directoryNames.some(name => !["README.md", "manifest.json", "plugin.py", "tests.py"].includes(name))) reject("activation_artifact_rejected");
        files = candidateFiles(Object.fromEntries(await Promise.all(directoryNames.map(async name => [name,
          new TextDecoder("utf-8", { fatal: true }).decode(await bytes(join(directory, "stage", "candidate", name), 48000))]))));
        if (candidateDigest(files) !== entry.candidateDigest || !same(JSON.parse(files["manifest.json"]), receipt.plugin)) reject("activation_candidate_drift");
      }
    }
    context.assertActive();
    return { receipt, files, binding: { candidateId: entry.candidateId, candidateDigest: entry.candidateDigest,
      verificationId: entry.verificationId, verificationSha256: entry.verificationSha256, sessionId: entry.sessionId,
      sourceId: entry.sourceId, snapshotSha256: receipt.snapshotSha256, image, suiteDigest: receipt.suiteDigest,
      executionBoundary: "credential-free-isolated", publicationAuthorized: false } };
  }

  async function guarded(operation) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof PluginActivationError) throw error;
      if (typeof error?.code === "string" && /^[a-z_]{1,80}$/.test(error.code) && [400, 403, 409, 503].includes(error.status)) {
        reject(error.code, error.status);
      }
      reject("activation_unavailable", 503);
    }
  }

  return {
    has(id) { return approved.some(entry => entry.pluginId === id); },
    list(context) {
      return guarded(async () => {
        const listed = [];
        for (const entry of approved) {
          const loaded = await load(entry, context);
          listed.push({ manifest: loaded.receipt.plugin, previewFormat: "dataflow-discovery.plugin-preview/1", activation: loaded.binding });
        }
        return listed;
      });
    },
    analyze(policy, request, context) {
      return guarded(async () => {
        const entry = approved.find(item => item.pluginId === request.pluginId);
        if (!entry || policy.sourceId !== entry.sourceId || request.selection !== entry.selection ||
            !same(request.pluginConfig ?? {}, entry.config) || ["connections", "pythonPath", "entrypoint"].some(name => request[name] !== undefined)) reject("activation_scope_rejected", 403);
        const loaded = await load(entry, context);
        if (request.snapshotSha256 !== undefined && request.snapshotSha256 !== loaded.receipt.snapshotSha256) reject("workspace_source_drift");
        const capture = () => context.bridge({ operation: "plugin_workspace_input", policy,
          request: { selection: entry.selection, snapshotSha256: loaded.receipt.snapshotSha256 } }, 131072);
        const input = await capture();
        context.assertActive();
        if (input.format !== "dataflow-discovery.plugin-input/1" || input.snapshotSha256 !== loaded.receipt.snapshotSha256) reject("activation_source_drift");
        const execution = await runner.run({ files: loaded.files, source: input.source, config: entry.config, signal: context.signal });
        context.assertActive();
        if (execution.status !== "PASS") reject(execution.status === "BLOCKED" ? "activation_execution_blocked" : "activation_analysis_failed", execution.status === "BLOCKED" ? 503 : 409);
        // This activation is deliberately scoped to the approved exact source
        // and config. A later run cannot replace its semantic result merely by
        // emitting structurally valid data from the same candidate bytes.
        if (execution.result?.resultDigest !== loaded.receipt.checks[0].resultDigest) reject("activation_result_drift");
        const fresh = await capture();
        if (fresh.snapshotSha256 !== input.snapshotSha256 || execution.result?.sourceId !== entry.sourceId ||
            execution.result?.snapshotSha256 !== input.snapshotSha256 || execution.candidateDigest !== entry.candidateDigest ||
            !same(execution.result.plugin, loaded.receipt.plugin) || execution.result.publicationAuthorized !== false || execution.result.runtimeVerified !== false) reject("activation_source_drift");
        await load(entry, context);
        context.assertActive();
        return { format: "dataflow-discovery.plugin-preview/1", sourceId: entry.sourceId,
          snapshotSha256: input.snapshotSha256, manifest: input.manifest, result: execution.result,
          activation: { ...loaded.binding, executionId: execution.executionId }, complete: false, publicationAuthorized: false };
      });
    },
  };
}
