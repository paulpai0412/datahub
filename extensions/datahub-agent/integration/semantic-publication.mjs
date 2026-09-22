import { createHash } from "node:crypto";
import { nativeSemantic, SemanticError } from "./native-semantic.mjs";
import { canonicalPublicationJson as canonical, makePublicationReview } from "./publication-review.mjs";
import { stewardVersion, validateStewardChange } from "./semantic-preservation.mjs";

const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
export const semanticCandidateId = (candidate) => `cand_${hash(candidate).slice(0, 24)}`;
const fail = (code) => { throw new SemanticError(code, 409); };
const audit = (actor, time) => ({ actor, time });
function versions(snapshot, fieldState) {
  return { dataset: Object.fromEntries(Object.entries(snapshot).map(([name, value]) => [name, value?.version ?? "-1"])),
    field: Object.fromEntries(["schemaFieldKey", "structuredProperties", "status"].map((name) => [name, fieldState?.[name]?.systemMetadata.version ?? "-1"])) };
}
function publicationPolicy(context, source) {
  const policy = context.sources.find((entry) => entry.urn === source);
  if (policy?.semanticModelContextApproved !== true || policy.semanticPublicationApproved !== true) fail("semantic_publication_not_authorized");
  if (policy.semanticAuditAudience !== "EXISTING_TASK_RUN_ACL") fail("semantic_audit_visibility_not_approved");
  return policy;
}

/** Fixed typed compiler. Neither arbitrary Aspects nor serialized approvals enter
 * here. Every invocation reruns the existing native semantic evidence boundary.
 */
export async function compileSemanticPublication(request, context, timing = {}) {
  const policy = publicationPolicy(context, request.sourceUrn);
  if (!["preview", "preview_definition"].includes(request.action)) fail("invalid_semantic_proposal");
  if (request.action === "preview_definition" && policy.semanticDefinitionCreationApproved !== true) fail("semantic_definition_creation_not_authorized");
  const createdAt = timing.createdAt ?? (context.now ?? Date.now)();
  const expiresAt = timing.expiresAt ?? createdAt + 600000;
  let captured;
  const preview = await nativeSemantic(JSON.stringify(request), { ...context,
    captureSemanticSnapshot: (value) => { captured = value; },
    captureSemanticDefinitionTarget: (row) => { if (row && Object.keys(row).some((key) => key !== "urn")) fail("semantic_definition_target_exists"); },
  });
  if (!captured || preview.membership.status !== "NATIVE_RUN_MATCH") fail("semantic_source_membership_required");
  // Incomplete Source inventory is explicit but does not expand this exact,
  // individually proven Dataset subset into source-wide authority.
  const { snapshot, fieldState, selectedField } = captured;
  const stamp = audit(context.actor.urn, createdAt);
  const changes = new Map();
  function target(urn, aspect, before) {
    const key = `${urn}\n${aspect}`;
    if (!changes.has(key)) changes.set(key, { urn, aspect,
      expectedVersion: before?.version ?? before?.systemMetadata?.version ?? "-1",
      beforeValueJson: canonical(before?.value ?? null), value: structuredClone(before?.value ?? {}) });
    return changes.get(key).value;
  }
  let candidates;
  if (preview.definition) {
    const d = preview.definition;
    if (d.conflicts.length) fail("semantic_definition_reuse_required");
    candidates = [request.definition];
    Object.assign(target(d.proposedUrn, d.aspect, null), d.value);
  } else {
    candidates = request.candidates;
    for (const item of preview.changes) {
      if (item.operation !== "PROPOSED" || item.conflicts.length) fail("semantic_candidate_not_publishable");
      let aspect, urn = request.datasetUrn, value;
      if (item.fieldPath && item.kind !== "property") {
        aspect = "editableSchemaMetadata";
        const root = target(urn, aspect, snapshot[aspect]);
        root.created ??= stamp;
        root.lastModified = stamp;
        root.editableSchemaFieldInfo ??= [];
        value = root.editableSchemaFieldInfo.find((entry) => entry.fieldPath === item.fieldPath);
        if (!value) { value = { fieldPath: item.fieldPath }; root.editableSchemaFieldInfo.push(value); }
      } else {
        aspect = { description: "editableDatasetProperties", domain: "domains", tag: "globalTags", term: "glossaryTerms", property: "structuredProperties", owner: "ownership", documentation: "institutionalMemory" }[item.kind];
        if (item.fieldPath) {
          if (!selectedField || selectedField.fieldPath !== item.fieldPath) fail("semantic_field_snapshot_required");
          urn = selectedField.urn;
          if (!selectedField.materialized) {
            Object.assign(target(urn, "schemaFieldKey", null), { parent: request.datasetUrn, fieldPath: item.fieldPath.replace(/[(),]/g, (c) => ({ "(": "%28", ")": "%29", ",": "%2C" })[c]) });
          }
        }
        value = target(urn, aspect, item.fieldPath ? fieldState?.[aspect] : snapshot[aspect]);
      }
      if (item.kind === "description") value.description = item.value;
      if (item.kind === "domain") (value.domains ??= []).push(item.value);
      if (item.kind === "tag") {
        const container = item.fieldPath ? (value.globalTags ??= {}) : value;
        (container.tags ??= []).push({ tag: item.value });
      }
      if (item.kind === "term") {
        const container = item.fieldPath ? (value.glossaryTerms ??= {}) : value;
        (container.terms ??= []).push({ urn: item.value });
        container.auditStamp = stamp;
      }
      if (item.kind === "property") {
        value.properties ??= [];
        const values = item.values.map((v) => ({ [typeof v === "number" ? "double" : "string"]: v }));
        const existing = value.properties.find((entry) => entry.propertyUrn === item.value);
        if (existing) existing.values = values;
        else value.properties.push({ propertyUrn: item.value, values });
      }
      if (item.kind === "owner") { (value.owners ??= []).push({ owner: item.value, type: item.ownerType }); value.lastModified = stamp; }
      if (item.kind === "documentation") (value.elements ??= []).push({ url: item.value, description: item.description, createStamp: stamp });
    }
  }
  const { asOf: _asOf, ...stablePreview } = preview;
  const semanticContext = { actor: context.actor.urn, createdAt, request, preview: stablePreview,
    policySha256: hash(policy), guards: versions(snapshot, fieldState) };
  const review = makePublicationReview({ purpose: "SEMANTIC", source: request.sourceUrn, sourceId: "semantic-steward",
    snapshotSha256: request.snapshotDigest, candidateDigest: hash({ request, preview: stablePreview }), analysisVersion: stewardVersion,
    candidateIds: candidates.map(semanticCandidateId), datasets: [request.datasetUrn], expiresAt,
    semanticContextJson: canonical(semanticContext),
    changes: [...changes.values()].map(({ value, ...change }) => ({ ...change, valueJson: canonical(value) })) });
  for (const change of review.changes) if (!validateStewardChange(review, change, JSON.parse(change.beforeValueJson), context.actor.urn)) fail("semantic_human_value_conflict");
  return review;
}

export async function recompileSemanticPublication(review, context) {
  if (review.analysisVersion !== stewardVersion) fail("semantic_compiler_mismatch");
  const saved = JSON.parse(review.semanticContextJson);
  const fresh = await compileSemanticPublication(saved.request, context, { createdAt: saved.createdAt, expiresAt: review.expiresAt });
  if (fresh.planDigest !== review.planDigest) fail("semantic_review_stale");
  return fresh;
}

/** Public CAS is per Aspect, not a cross-entity transaction. Detect changed
 * source/schema/reference context after writes and never call that trusted PASS.
 */
export async function verifySemanticPublicationContext(review, context) {
  const saved = JSON.parse(review.semanticContextJson);
  if (hash(publicationPolicy(context, review.source)) !== saved.policySha256) fail("semantic_review_stale");
  const request = { ...saved.request }; delete request.snapshotDigest;
  request.action = "inspect_dataset";
  delete request.candidates; delete request.definition; delete request.reason; delete request.evidenceIds;
  let observed;
  const inspected = await nativeSemantic(JSON.stringify(request), { ...context, captureSemanticSnapshot: (value) => { observed = value; } });
  for (const key of ["source", "scope", "membership"]) if (canonical(inspected[key]) !== canonical(saved.preview[key])) fail("semantic_publication_context_changed");
  const current = versions(observed.snapshot, observed.fieldState);
  for (const [group, values] of Object.entries(saved.guards)) {
    for (const [aspect, version] of Object.entries(values)) {
      const urn = group === "dataset" ? saved.request.datasetUrn : observed.selectedField?.urn;
      if (!review.changes.some((change) => change.urn === urn && change.aspect === aspect) && current[group][aspect] !== version) fail("semantic_publication_context_changed");
    }
  }
  const after = await nativeSemantic(JSON.stringify({ ...saved.request, snapshotDigest: inspected.snapshotDigest }), { ...context,
    captureSemanticDefinitionTarget: (row) => {
      if (!row || row.status?.value?.removed === true) fail("semantic_publication_context_changed");
      const change = review.changes.find((entry) => entry.urn === row.urn);
      if (!change || canonical(row[change.aspect]?.value) !== change.valueJson) fail("semantic_publication_context_changed");
    },
  });
  const beforeRefs = saved.preview.definition ? [saved.preview.definition.parent] : saved.preview.changes.map((c) => c.definition ?? null);
  const afterRefs = after.definition ? [after.definition.parent] : after.changes.map((c) => c.definition ?? null);
  if (canonical(beforeRefs) !== canonical(afterRefs)) fail("semantic_publication_context_changed");
  return { status: "SOURCE_SCHEMA_REFERENCES_RECHECKED", observedAt: (context.now ?? Date.now)() };
}
