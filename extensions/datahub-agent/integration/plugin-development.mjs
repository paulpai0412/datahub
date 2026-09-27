import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createIsolatedPluginRunner } from "./isolated-plugin-runner.mjs";
import { candidateFiles, candidateDigest } from "../pi-web/lib/discovery-plugin-candidates.ts";

const hash = value => createHash("sha256").update(value).digest("hex");
const MODULE_DIGEST = hash(await readFile(new URL(import.meta.url)));
const DOCUMENTS = Object.freeze(Object.fromEntries(await Promise.all(
  ["asset-plugin", "language-plugin"].map(async id => {
    const text = await readFile(new URL(`../pi-web/skills/discovery-plugin-dev/references/${id}.md`, import.meta.url), "utf8");
    return [id, Object.freeze({ name: `${id}.md`, text, sha256: hash(text) })];
  }),
)));
const SUITE_DIGEST = hash(JSON.stringify({ module: MODULE_DIGEST,
  documents: Object.fromEntries(Object.entries(DOCUMENTS).map(([id, file]) => [id, file.sha256])) }));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REFERENCE_ID = "official-analytics-openapi-yaml";
const REFERENCE_SHA = "93cb72529313ffced744e21465206bc921b229ef726cbb3530454af0afc5e424";
const ACTIONS = new Set(["plugin_development_contract", "plugin_development_references", "plugin_development_reference", "plugin_development_verify"]);
const object = value => value && typeof value === "object" && !Array.isArray(value);

export class PluginDevelopmentError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

export function parsePluginDevelopmentRequest(request) {
  if (!object(request) || !ACTIONS.has(request.action) || typeof request.requestId !== "string" || !UUID.test(request.requestId)) {
    throw new PluginDevelopmentError("invalid_development_request");
  }
  const allowed = ["action", "requestId"];
  if (["plugin_development_reference", "plugin_development_verify"].includes(request.action)) {
    allowed.push("referenceId");
    if (typeof request.referenceId !== "string" || (request.referenceId !== REFERENCE_ID &&
        !(request.action === "plugin_development_reference" && Object.hasOwn(DOCUMENTS, request.referenceId)))) {
      throw new PluginDevelopmentError("development_reference_unknown");
    }
  }
  if (request.action === "plugin_development_verify") {
    allowed.push("sessionId", "candidate");
    const candidate = request.candidate;
    if (!UUID.test(request.sessionId ?? "") || !object(candidate) || !UUID.test(candidate.candidateId ?? "") ||
        candidate.verified !== false || candidate.activationAuthorized !== false ||
        Object.keys(candidate).some(name => !["candidateId", "candidateDigest", "files", "verified", "activationAuthorized"].includes(name))) {
      throw new PluginDevelopmentError("invalid_development_candidate");
    }
    try {
      const files = candidateFiles(candidate.files);
      if (candidateDigest(files) !== candidate.candidateDigest) throw new Error();
    } catch { throw new PluginDevelopmentError("candidate_revision_drift"); }
  }
  if (Object.keys(request).some(name => !allowed.includes(name))) throw new PluginDevelopmentError("invalid_development_request");
  return request;
}

/** A deliberately bounded first capability. Expectations are Host-owned, not
 * candidate tests. These are regression cases, not a claim of formal holdout or
 * full OpenAPI coverage. The real reference is separate from synthetic probes.
 */
function cases(reference) {
  const suffix = randomUUID().slice(0, 8);
  return [
    { name: "official-reference", source: reference.source, config: { serviceId: "datahub-analytics" },
      expected: { asset: "POST /datahub_usage_events/_search", ports: [
        { name: "request:application/json", direction: "input", type: "string" },
        { name: "response:200:application/json", direction: "output", type: "string" }], complete: true } },
    { name: "scalar-variation", source: { sourceId: `scalar-probe-${suffix}`, files: [{ path: "probe.yaml", text:
      `openapi: 3.0.0\ninfo: {title: Probe, version: '1'}\npaths:\n  /probe-${suffix}:\n    put:\n      requestBody:\n        content:\n          application/json:\n            schema: {type: integer}\n      responses:\n        '201':\n          description: result\n          content:\n            application/json:\n              schema: {type: boolean}\n` }] }, config: { serviceId: `probe-${suffix}` },
      expected: { asset: `PUT /probe-${suffix}`, ports: [
        { name: "request:application/json", direction: "input", type: "integer" },
        { name: "response:201:application/json", direction: "output", type: "boolean" }], complete: true } },
    { name: "unresolved-reference", source: { sourceId: `unsupported-probe-${suffix}`, files: [{ path: "unsupported.yaml", text:
      `openapi: 3.0.0\ninfo: {title: Probe, version: '1'}\npaths:\n  /unresolved-${suffix}:\n    post:\n      requestBody:\n        content:\n          application/json:\n            schema:\n              $ref: 'https://example.invalid/never-fetch.json#/Unknown'\n      responses:\n        '204': {description: no body}\n` }] }, config: { serviceId: `unresolved-${suffix}` },
      expected: { asset: `POST /unresolved-${suffix}`, complete: false } },
  ];
}

function checkSemantics(result, expected) {
  const graph = result.graph;
  const assets = graph.nodes.filter(node => node.kind === "asset");
  const ports = graph.nodes.filter(node => node.kind === "port");
  if (assets.length !== 1 || assets[0].assetType !== "api" || assets[0].name !== expected.asset ||
      graph.nodes.length !== assets.length + ports.length || graph.edges.length !== 0 || result.coverageComplete !== expected.complete) return false;
  if (!expected.complete) return graph.findings.length > 0 && ports.every(port => !port.fields?.length);
  return ports.length === expected.ports.length && expected.ports.every(wanted => {
    const port = ports.find(item => item.name === wanted.name);
    return port?.owner === assets[0].id && port.direction === wanted.direction && port.fields?.length === 1 &&
      port.fields[0].path === "/" && port.fields[0].nativeType === wanted.type;
  });
}

export function createPluginDevelopment({ actors, referenceSourceId, image, evidenceRoot }) {
  if (!Array.isArray(actors) || actors.length === 0 || actors.some(actor => typeof actor.tenant !== "string" || !actor.tenant || !/^[a-f0-9]{48}$/.test(actor.key ?? "")) || !referenceSourceId) {
    throw new PluginDevelopmentError("development_configuration_invalid", 503);
  }
  const permitted = actors.map(actor => ({ tenant: actor.tenant, key: actor.key }));
  const runner = createIsolatedPluginRunner({ image, evidenceRoot });

  async function reference(context) {
    const policy = context.sources.find(item => item.sourceId === referenceSourceId && item.workspace === true && item.modelContextApproved === true);
    if (!policy) throw new PluginDevelopmentError("development_reference_not_authorized", 403);
    const captured = await context.bridge({ operation: "plugin_workspace_input", policy, request: { selection: "open-api.yaml" } }, 131072);
    if (captured.format !== "dataflow-discovery.plugin-input/1" || captured.source?.files?.length !== 1 ||
        captured.source.files[0].path !== "open-api.yaml" || hash(captured.source.files[0].text) !== REFERENCE_SHA) {
      throw new PluginDevelopmentError("development_reference_drift", 409);
    }
    return captured;
  }

  return {
    async handle(request, context) {
      parsePluginDevelopmentRequest(request);
      context.assertActive();
      if (!permitted.some(item => item.tenant === context.actor?.tenant && item.key === context.actor?.key)) {
        throw new PluginDevelopmentError("development_not_authorized", 403);
      }
      if (hash(await readFile(new URL(import.meta.url))) !== MODULE_DIGEST) throw new PluginDevelopmentError("development_suite_drift", 503);
      const envelope = { requestId: request.requestId, activationAuthorized: false, publicationAuthorized: false };
      if (request.action === "plugin_development_contract") {
        const contract = await context.bridge({ operation: "plugin_development_contract" }, 60000);
        context.assertActive();
        return { ...contract, ...envelope, candidateExecutionAvailable: true, suite: "openapi-scalar-yaml/1", suiteDigest: SUITE_DIGEST,
          runtime: { image, python: "3.11", dependencies: ["PyYAML==6.0.3", "jsonschema==4.26.0"],
            entrypoint: "plugin.py:analyze(snapshot, config) -> graph", helpers: "dataflow_discovery.plugin_api: node_id, file_evidence",
            snapshot: "Snapshot.source_id, sha256, files; each SourceFile.path, text, sha256, size_bytes" },
          requirements: ["New plugin ID, not legacy-static/openapi-operations. YAML OpenAPI 3.0 scalar declarations only; unsupported constructs remain findings.",
            "Use config.serviceId. One assetType=api asset named METHOD /path per operation; ports named request:media or response:status:media.",
            "Scalar fields use path=/ and nativeType from schema.type. No inferred examples/value edges; no API calls.",
            "Unresolved remote schema refs remain findings and incomplete coverage, with no guessed fields. YAML evidence uses original source lines/hash, not JSON pointers into converted text.",
            "Host runs actual official reference plus bounded scalar and unresolved-reference probes. Saved tests.py is not currently executed or trusted as approval." ] };
      }
      if (request.action === "plugin_development_reference" && Object.hasOwn(DOCUMENTS, request.referenceId)) {
        return { ...envelope, format: "dataflow-discovery.authoring-reference/1", referenceId: request.referenceId,
          authority: "REFERENCE_ONLY", file: DOCUMENTS[request.referenceId], suiteDigest: SUITE_DIGEST };
      }
      const original = await reference(context);
      context.assertActive();
      if (request.action === "plugin_development_references") return {
        ...envelope, format: "dataflow-discovery.authoring-references/1", references: [{ referenceId: REFERENCE_ID,
          sourceId: referenceSourceId, snapshotSha256: original.snapshotSha256, fileSha256: REFERENCE_SHA,
          scope: "official repository specification, NOT deployed API or business execution" },
          ...Object.entries(DOCUMENTS).map(([referenceId, file]) => ({ referenceId, kind: "documentation", fileSha256: file.sha256 }))] };
      if (request.action === "plugin_development_reference") return {
        ...envelope, format: "dataflow-discovery.authoring-reference/1", referenceId: REFERENCE_ID,
        source: original.source, snapshotSha256: original.snapshotSha256, config: { serviceId: "datahub-analytics" } };

      const candidate = request.candidate;
      const verificationId = randomUUID();
      const checks = [];
      let status = "PASS", code, plugin;
      for (const item of cases(original)) {
        context.assertActive();
        const execution = await runner.run({ files: candidate.files, source: item.source, config: item.config, signal: context.signal });
        const semantic = execution.status === "PASS" && checkSemantics(execution.result, item.expected);
        checks.push({ name: item.name, executionId: execution.executionId, snapshotSha256: execution.result?.snapshotSha256,
          resultDigest: execution.result?.resultDigest, technicalStatus: execution.status, semanticMatch: semantic,
          ...(semantic ? {} : { expected: item.expected, code: execution.code ?? "development_semantic_mismatch" }) });
        if (execution.status !== "PASS" || !semantic) {
          status = execution.status === "BLOCKED" ? "BLOCKED" : "FAIL";
          code = execution.code ?? "development_semantic_mismatch";
          break;
        }
        plugin ??= execution.result.plugin;
        if (["legacy-static", "openapi-operations"].includes(plugin.id) || !plugin.suffixes.some(suffix => [".yaml", ".yml"].includes(suffix))) {
          status = "FAIL"; code = "development_new_yaml_plugin_required"; break;
        }
      }
      const fresh = await reference(context);
      context.assertActive();
      if (fresh.snapshotSha256 !== original.snapshotSha256 || hash(await readFile(new URL(import.meta.url))) !== MODULE_DIGEST) {
        status = "BLOCKED"; code = "development_source_or_suite_drift";
      }
      const receipt = { ...envelope, format: "dataflow-discovery.candidate-verification/1", verificationId, status, ...(code ? { code } : {}),
        candidateId: candidate.candidateId, candidateDigest: candidate.candidateDigest, sessionId: request.sessionId,
        actor: { tenant: context.actor.tenant, urn: context.actor.urn }, referenceId: REFERENCE_ID, snapshotSha256: original.snapshotSha256,
        suite: "openapi-scalar-yaml/1", suiteDigest: SUITE_DIGEST, image, checks, plugin,
        independentReview: "waived_by_owner_not_performed", writerTestsExecuted: false, deployedApiVerified: false };
      // Operational evidence only, not a second Catalog/approval datastore.
      await writeFile(join(evidenceRoot, `verification-${verificationId}.json`), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      return receipt;
    },
  };
}
