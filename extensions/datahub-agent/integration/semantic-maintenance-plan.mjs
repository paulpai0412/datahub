import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { taskRecords, TaskRecordError } from "./task-records.mjs";
import { canonicalPublicationJson as canonical, validatePublicationReview } from "./publication-review.mjs";
import { catalogAssetScope, catalogAssetType, catalogTypes, maintenanceStewardVersion, vocabularyTypes } from "./semantic-catalog-contract.mjs";
import { inspectCatalogIntent, parseCatalogRequest } from "./native-semantic-catalog.mjs";
import { semanticNativeClient, semanticReviewPolicy, SemanticError } from "./semantic-native-client.mjs";
import { compileCatalogPublication } from "./semantic-catalog-publication.mjs";
import { recompileSemanticPublication, verifySemanticPublicationContext } from "./semantic-publication.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const prefix = "semantic-maintenance/1:";
const linkPrefix = "semantic-maintenance-item/1:";
const keepPrefix = "semantic-maintenance-keep/1:";
const gapPrefix = "semantic-maintenance-gap/1:";
const sealId = "maintenance-plan";
const governanceFocuses = ["all", "glossary", "tag", "table", "field"];
function observationStatus(observation) {
  if (observation.gap?.code === "UNRESOLVED_OPERATION") return "DEFERRED";
  return observation.gap ? "GAP" : "KEEP";
}
const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const requireValue = (condition, code = "invalid_semantic_maintenance_request") => {
  if (!condition) throw new TaskRecordError(code);
};
const parse = (text, marker) => {
  requireValue(typeof text === "string" && text.startsWith(marker), "semantic_maintenance_record_invalid");
  try { return JSON.parse(text.slice(marker.length)); }
  catch { throw new TaskRecordError("semantic_maintenance_record_invalid"); }
};
const keys = (value, allowed) => requireValue(value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key)));

export const maintenanceActions = Object.freeze({
  start_maintenance: ["requestId", "sessionId", "uiRequestId", "sourceUrn", "assetUrns", "focus"],
  reconcile_maintenance_start: ["requestId", "sourceUrn", "originalRequestId"],
  prepare_maintenance: ["requestId", "sessionId", "uiRequestId", "maintenanceRunUrn", "contract", "sourceUrn", "assetUrn", "fieldPath", "snapshotDigest", "evidenceMode", "candidates", "definition", "reason", "evidenceIds", "gap", "version", "responseMode"],
  revise_maintenance: ["requestId", "sessionId", "uiRequestId", "maintenanceRunUrn", "contract", "sourceUrn", "assetUrn", "fieldPath", "snapshotDigest", "evidenceMode", "candidates", "definition", "reason", "evidenceIds", "gap", "itemId", "version", "childVersion", "planDigest", "responseMode"],
  recover_maintenance: ["requestId", "sessionId", "uiRequestId", "maintenanceRunUrn", "itemId", "version", "childVersion", "planDigest"],
  seal_maintenance: ["requestId", "sessionId", "uiRequestId", "maintenanceRunUrn"],
  read_maintenance: ["requestId", "maintenanceRunUrn", "offset", "assetUrn", "version", "view"],
  continue_maintenance: ["requestId", "sessionId", "uiRequestId", "maintenanceRunUrn"],
  approve_maintenance: ["maintenanceRunUrn", "version", "planDigest", "selection"],
  publish_maintenance_item: ["maintenanceRunUrn", "planDigest", "itemId"],
});
export const maintenanceWriteActions = ["start_maintenance", "prepare_maintenance", "revise_maintenance", "recover_maintenance", "seal_maintenance"];

/** Exact ORIGINAL locators only. Neither an existence proof nor replay authority. */
export function maintenanceStartLocators(actorKey, requestId) {
  requireValue(uuid.test(requestId));
  const maintenanceRunUrn = `urn:li:dataProcessInstance:semantic-${actorKey}-${requestId}`;
  return { taskUrn: `urn:li:dataJob:(urn:li:dataFlow:(pi,ekop-agent-${actorKey},DEV),semantic-${actorKey}-${requestId})`,
    runUrn: maintenanceRunUrn, maintenanceRunUrn };
}

/** Emitted ONLY by pure input validation, never by a catch around preparation.
 * The receipt proves no writes by THIS invocation, not effects of older intents.
 */
export class MaintenanceInputRejection extends TaskRecordError {
  constructor(input, issue, location) {
    super("invalid_semantic_maintenance_request", 400);
    if (["prepare_maintenance", "revise_maintenance"].includes(input.action) && uuid.test(input.requestId) &&
        typeof input.maintenanceRunUrn === "string" && input.maintenanceRunUrn.length <= 1024) {
      const body = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "uiRequestId"));
      this.inputRejection = Object.freeze({ format: "datahub-semantic.input-rejection/1", phase: "INPUT_VALIDATION",
        nativeWriteStarted: false, correction: "NEW_INTENT_ONLY", action: input.action, requestId: input.requestId,
        ...(issue ? { issue } : {}),
        ...(location ? { location: Object.freeze({ ...location }) } : {}),
        maintenanceRunUrn: input.maintenanceRunUrn,
        requestDigest: createHash("sha256").update(JSON.stringify(body)).digest("hex") });
    }
  }
}

function validateMaintenanceInput(input, actorKey) {
  const check = condition => { if (!condition) throw new MaintenanceInputRejection(input); };
  check(Object.keys(input).every(key => key === "action" || maintenanceActions[input.action].includes(key)));
  check(input.responseMode === undefined || input.responseMode === "incremental");
  if (!["prepare_maintenance", "revise_maintenance"].includes(input.action) || input.gap === undefined) return;
  const gap = input.gap;
  check(gap && typeof gap === "object" && !Array.isArray(gap) &&
    Object.keys(gap).every(key => ["code", "reason", "operation"].includes(key)) &&
    typeof gap.reason === "string" && gap.reason.length > 0 && gap.reason.length <= 1024 &&
    input.candidates === undefined && input.definition === undefined && input.reason === undefined && input.evidenceIds === undefined);
  if (gap.code !== "UNRESOLVED_OPERATION") {
    check(["INSUFFICIENT_EVIDENCE", "HUMAN_VALUE", "SHARED_IMPACT", "AMBIGUOUS_MEANING", "UNSUPPORTED_CHANGE"].includes(gap.code) &&
      gap.operation === undefined);
    return;
  }
  const operation = gap.operation;
  check(operation && typeof operation === "object" && !Array.isArray(operation) &&
    Object.keys(operation).every(key => ["action", "maintenanceRunUrn", "requestId", "itemId"].includes(key)) &&
    ["prepare_maintenance", "revise_maintenance", "publish_maintenance_item"].includes(operation.action) &&
    typeof operation.maintenanceRunUrn === "string" && operation.maintenanceRunUrn.length <= 1024 &&
    operation.maintenanceRunUrn.startsWith(`urn:li:dataProcessInstance:semantic-${actorKey}`) &&
    (operation.requestId === undefined || uuid.test(operation.requestId)) &&
    (operation.itemId === undefined || uuid.test(operation.itemId)));
}

/** Compact, deterministic selection over the sealed native item order. It is
 * consent content, NOT a bearer token or a model-supplied authorization grant. */
export function maintenanceSelection(count, indexes) {
  const bytes = Buffer.alloc(Math.ceil(count / 8));
  for (const index of indexes) {
    requireValue(Number.isInteger(index) && index >= 0 && index < count);
    bytes[index >> 3] |= 1 << (index % 8);
  }
  return bytes.toString("base64");
}
function selected(selection, count) {
  requireValue(typeof selection === "string" && selection.length <= 180);
  const bytes = Buffer.from(selection, "base64");
  requireValue(bytes.length === Math.ceil(count / 8) && bytes.toString("base64") === selection &&
    (count % 8 === 0 || (bytes.at(-1) >> (count % 8)) === 0));
  return Array.from({ length: count }, (_, index) => Boolean(bytes[index >> 3] & (1 << (index % 8))));
}

/** Reuses Task/Run/Decision and the existing publisher. The root Run contains
 * small immutable references; each item has its own native Run and attempt.
 * This avoids a second datastore and a giant 91-asset publication transaction. */
export function maintenancePlan(context) {
  const records = taskRecords({ ...context, recompilePublication: (review) => recompileSemanticPublication(review, context),
    verifyPublicationReadback: (review) => verifySemanticPublicationContext(review, context),
    authorizeMaintenancePublication: authorizePublication });
  const now = context.now ?? Date.now;
  const runUrn = (id) => {
    requireValue(uuid.test(id));
    return `urn:li:dataProcessInstance:semantic-${context.actor.key}-${id}`;
  };
  function policy(sourceUrn, write = false) {
    context.assertActive();
    const source = context.sources.find((entry) => entry.urn === sourceUrn);
    requireValue(source?.semanticModelContextApproved === true && source.semanticCatalogUpdatesApproved === true &&
      source.semanticAgentUrn && source.semanticAuditAudience === "EXISTING_TASK_RUN_ACL" &&
      (!write || source.semanticPublicationApproved === true), "semantic_publication_not_authorized");
    return source;
  }
  function links(run, pendingItemId, includeSuperseded = false) {
    const superseded = new Set(), seen = new Map();
    const result = run.value.decisions.filter((decision) => decision.id !== sealId).map((decision) => {
      const value = parse(decision.question, linkPrefix);
      keys(value, ["id", "digest", "asset", "definition", "supersedes"]);
      if (value.supersedes) {
        keys(value.supersedes, ["id", "digest", "childVersion"]);
        const prior = seen.get(value.supersedes.id);
        requireValue(prior && !superseded.has(prior.id) && prior.digest === value.supersedes.digest &&
          prior.asset === value.asset && prior.definition === value.definition &&
          /^[1-9][0-9]*$/.test(value.supersedes.childVersion), "semantic_maintenance_record_invalid");
        superseded.add(prior.id);
      }
      seen.set(value.id, value);
      requireValue(decision.id === value.id && uuid.test(value.id) && digest.test(value.digest) && /^[a-f0-9]{24}$/.test(value.asset) && typeof value.definition === "boolean" &&
        ((decision.id === pendingItemId && !decision.response && decision.choices.length === 0) ||
          (decision.response?.actor === context.actor.urn && decision.response.action === "RESPOND" &&
          decision.response.text === "LINKED_NO_CONSENT")), "semantic_maintenance_record_invalid");
      return value;
    });
    requireValue(result.length <= 1024 && new Set(result.map((item) => item.id)).size === result.length,
      "semantic_maintenance_record_invalid");
    return includeSuperseded ? result : result.filter((item) => !superseded.has(item.id));
  }
  function planDigest(root) {
    return hash({ actor: root.run.value.actor, source: root.run.value.source,
      task: root.task.urn, taskVersion: root.run.value.taskVersion, items: links(root.run) });
  }
  async function readRoot(urn, write = false) {
    requireValue(typeof urn === "string" && urn.startsWith(`urn:li:dataProcessInstance:semantic-${context.actor.key}-`) &&
      uuid.test(urn.slice(`urn:li:dataProcessInstance:semantic-${context.actor.key}-`.length)), "semantic_maintenance_actor_mismatch");
    const run = await records.getRun(urn);
    const task = await records.getTask(run.value.task, run.value.taskVersion);
    const marker = parse(task.value.instructions, prefix);
    requireValue(run.value.actor === context.actor.urn && task.value.actor === context.actor.urn &&
      marker.runUrn === urn && run.value.source === task.value.source && marker.scopeDigest === hash(task.value.assets),
      "semantic_maintenance_binding_mismatch");
    policy(run.value.source, write);
    requireValue(marker.focus === undefined || governanceFocuses.includes(marker.focus), "semantic_maintenance_record_invalid");
    const root = { run, task, ...(marker.focus !== undefined ? { governance: {
      sourceUrn: run.value.source, focus: marker.focus, assetScopeBasis: "NATIVE_TASK_SELECTED_ASSETS",
    } } : {}) };
    const seal = run.value.decisions.find((decision) => decision.id === sealId);
    if (seal) {
      const stored = parse(seal.question, prefix);
      requireValue(stored.planDigest === planDigest(root) && stored.count === links(run).length,
        "semantic_maintenance_plan_changed");
      root.seal = seal;
      root.planDigest = stored.planDigest;
    }
    return root;
  }
  async function child(root, item) {
    const run = await records.getRun(runUrn(item.id));
    requireValue(run.value.actor === context.actor.urn && run.value.source === root.run.value.source &&
      run.value.task === root.task.urn && run.value.taskVersion === root.run.value.taskVersion &&
      run.value.sessionId === root.run.value.sessionId && run.value.decisions.length === 1,
      "semantic_maintenance_binding_mismatch");
    const decision = run.value.decisions[0];
    requireValue(decision.id === item.id, "semantic_maintenance_binding_mismatch");
    if (decision.publicationReview) {
      const review = validatePublicationReview(decision.publicationReview);
      const saved = parse(review.semanticContextJson, "");
      requireValue(review.analysisVersion === maintenanceStewardVersion && review.planDigest === item.digest &&
        saved.maintenance?.runUrn === root.run.urn && review.source === root.run.value.source &&
        isDeepStrictEqual(saved.maintenance.governance ?? null, root.governance ?? null) &&
        item.definition === Boolean(saved.request.definition) && item.asset === hash(saved.request.assetUrn).slice(0, 24) &&
        isDeepStrictEqual(saved.maintenance.supersedes ?? null, item.supersedes ?? null),
        "semantic_maintenance_binding_mismatch");
      return { run, decision, review, saved };
    }
    const isGap = decision.question.startsWith(gapPrefix);
    const observation = parse(decision.question, isGap ? gapPrefix : keepPrefix);
    requireValue(hash(observation) === item.digest && observation.runUrn === root.run.urn &&
      !item.definition && item.asset === hash(observation.assetUrn).slice(0, 24) &&
      isDeepStrictEqual(observation.supersedes ?? null, item.supersedes ?? null) &&
      decision.response?.actor === context.actor.urn && decision.response.text === (isGap ? "EXPLICIT_GAP" : "OBSERVED_NO_CHANGE"),
      "semantic_maintenance_record_invalid");
    return { run, decision, observation };
  }
  function verifiedInitial(value) {
    let initial;
    try { initial = JSON.parse(value.decision.publicationAttempt?.outcomeJson ?? "null"); }
    catch { return null; }
    return initial?.status === "VERIFIED_CURRENT_VALUES" &&
      initial.contextVerification?.status === "SOURCE_SCHEMA_REFERENCES_RECHECKED" ? initial : null;
  }
  async function initialAndCurrent(value) {
    const initial = verifiedInitial(value);
    if (!initial) return false;
    const current = await records.reconcilePublication(value.run.urn, value.decision.id);
    if (current.status !== "MATCHED_CLAIMED_ATTEMPT" || current.observations.length !== initial.observations?.length ||
        !current.observations.every((entry, index) => entry.version === initial.observations[index].version)) return false;
    try {
      // Earlier definitions remain usable after this SAME confirmed plan
      // applies editable metadata on their anchor. Those effects are not a
      // schema revision. The consumer's existing compiler still rechecks its
      // full exact context and every referenced definition before dispatch.
      const observed = await inspectCatalogIntent({ contract: "catalog/1", action: "inspect_asset", requestId: randomUUID(),
        sourceUrn: value.review.source, assetUrn: value.saved.request.assetUrn,
        ...(value.saved.request.fieldPath ? { fieldPath: value.saved.request.fieldPath } : {}) }, context);
      return (observed.row.schemaMetadata?.systemMetadata?.version ?? "-1") === value.saved.guards.asset.schemaMetadata;
    } catch { return false; }
  }
  function dependencies(saved) {
    return [...new Set([...Object.values(saved.maintenance.definitions).map((entry) => entry.reviewRef.decisionId),
      ...saved.maintenance.priorChanges.map((entry) => entry.reviewRef.decisionId)])];
  }
  async function ownedDefinitionImpact(kind, urn, nativeValue, sourceUrn, selectedAssets) {
    const source = policy(sourceUrn), scope = selectedAssets ?? catalogAssetScope(source), client = semanticNativeClient(context);
    let start = 0, total, observed = 0;
    const references = [];
    do {
      let page;
      if (kind === "property") {
        const data = await client.call("/api/v2/graphql", { query: "query($input:SearchAcrossEntitiesInput!){searchAcrossEntities(input:$input){start count total searchResults{entity{urn}}}}",
          variables: { input: { types: ["DATASET", "SCHEMA_FIELD", "CONTAINER", "DATA_FLOW", "DATA_JOB", "CHART", "DASHBOARD"], query: "*", start, count: 20,
            orFilters: [{ and: [{ field: `structuredProperties.${nativeValue.qualifiedName}`, condition: "EXISTS", values: [] }] }] } } });
        page = data.data?.searchAcrossEntities;
        page = { ...page, relationships: page?.searchResults?.map((entry) => ({ entity: entry.entity })) };
      } else {
        const types = { domain: ["AssociatedWith", "IsPartOf"], node: ["IsPartOf"], term: ["TermedWith", "IsA", "HasA"], tag: ["TaggedWith"] }[kind];
        const data = await client.call("/api/v2/graphql", { query: "query($urn:String!,$input:RelationshipsInput!){entity(urn:$urn){urn relationships(input:$input){start count total relationships{entity{urn}}}}}",
          variables: { urn, input: { types, direction: "INCOMING", start, count: 20, includeSoftDelete: false } } });
        requireValue(data.data?.entity?.urn === urn, "semantic_maintenance_impact_unconfirmed"); page = data.data.entity.relationships;
      }
      requireValue(page?.start === start && Number.isSafeInteger(page.total) && page.total >= 0 && Array.isArray(page.relationships) &&
        page.relationships.length === Math.min(20, Math.max(0, page.total - start)) && (total === undefined || total === page.total), "semantic_maintenance_impact_unconfirmed");
      total = page.total;
      for (const entry of page.relationships) {
        const target = entry.entity?.urn;
        requireValue(typeof target === "string", "semantic_maintenance_impact_unconfirmed");
        if (!scope.includes(target)) {
          if (target.startsWith("urn:li:schemaField:")) {
            const parent = scope.find((asset) => target.startsWith(`urn:li:schemaField:(${asset},`) && target.endsWith(")"));
            requireValue(parent, "semantic_maintenance_known_outside_reference");
          } else {
            const definitionKind = Object.keys(vocabularyTypes).find((key) => target.startsWith(`urn:li:${vocabularyTypes[key].entity}:`));
            requireValue(definitionKind, "semantic_maintenance_known_outside_reference");
            const type = vocabularyTypes[definitionKind];
            await client.authorize(target, type.privilege);
            const row = await client.entity(target, type.entity, [type.aspect, "status"]);
            await records.ownedSemanticDefinition(target, type.aspect, row[type.aspect], sourceUrn);
          }
        }
        references.push(target); observed++;
      }
      start += page.relationships.length;
    } while (start < total && start < 1000);
    context.assertActive();
    return { references, observedCount: observed, indexedTotal: total, complete: false, unknownGlobalImpact: true,
      indexedWindowTruncated: start < total, note: "Observed references are source-scoped; ACL filtering, index lag and concurrent references remain unknown. Exact whole-plan human consent is required; this is NOT a global completeness proof." };
  }
  function consent(root) {
    requireValue(root.seal?.response?.action === "RESPOND" && root.seal.response.actor === context.actor.urn,
      "semantic_maintenance_consent_required");
    const value = parse(root.seal.response.text, prefix);
    keys(value, ["planDigest", "selection"]);
    requireValue(value.planDigest === root.planDigest, "semantic_maintenance_consent_required");
    return selected(value.selection, links(root.run).length);
  }
  async function authorizePublication(review, proof, { run, task }) {
    keys(proof, ["runUrn", "planDigest"]);
    const saved = parse(review.semanticContextJson, "");
    requireValue(saved.maintenance.runUrn === proof.runUrn, "semantic_maintenance_consent_required");
    const root = await readRoot(proof.runUrn, true);
    requireValue(root.planDigest === proof.planDigest && run.value.task === root.task.urn && task.urn === root.task.urn &&
      run.value.source === root.run.value.source, "semantic_maintenance_consent_required");
    const items = links(root.run), index = items.findIndex((item) => runUrn(item.id) === run.urn && item.digest === review.planDigest);
    requireValue(index >= 0 && consent(root)[index], "semantic_maintenance_consent_required");
    for (const id of dependencies(saved)) {
      const item = items.find((entry) => entry.id === id);
      requireValue(item, "semantic_maintenance_dependency_invalid");
      requireValue(await initialAndCurrent(await child(root, item)), "semantic_maintenance_dependency_unverified");
    }
    if (saved.maintenance.ownedDefinition) {
      const kind = saved.request.definition.kind, aspect = vocabularyTypes[kind].aspect;
      const inspected = await inspectCatalogIntent(saved.request, context);
      const current = inspected.definitionTarget[aspect];
      const proof = await records.ownedSemanticDefinition(saved.request.definition.urn, aspect, current, review.source);
      requireValue(isDeepStrictEqual(proof, saved.maintenance.ownedDefinition), "semantic_maintenance_definition_not_owned");
      await ownedDefinitionImpact(kind, saved.request.definition.urn, current.value, review.source,
        root.governance ? root.task.value.assets : undefined);
    }
    // Native root records are immutable after seal/response. Scope revocation
    // and the Host's active grant are checked again at final target dispatch.
    return () => { policy(review.source, true); context.assertActive(); };
  }
  async function pending(input) {
    requireValue(uuid.test(input.requestId) && uuid.test(input.sessionId) && typeof input.uiRequestId === "string" && context.runtime,
      "semantic_native_request_required");
    const state = await context.runtime.state(input.sessionId);
    const entry = state.state?.extensionUiRequests?.find((item) => item.id === input.uiRequestId && item.method === "input" && item.title === "DataHub semantic request");
    let actual;
    try { actual = JSON.parse(entry?.placeholder); } catch { throw new TaskRecordError("semantic_native_request_not_pending"); }
    const { uiRequestId: _ui, ...expected } = input;
    requireValue(state.running === true && state.state.sessionId === input.sessionId && isDeepStrictEqual(actual, expected),
      "semantic_native_request_mismatch");
  }
  async function absent(urn) {
    try { await records.getRun(urn); }
    catch (error) { if (error instanceof TaskRecordError && error.message === "task_record_not_found") return; throw error; }
    throw new TaskRecordError("semantic_maintenance_preparation_incomplete", 409, { runUrn: urn, retryAllowed: false });
  }
  // The native Task owns the selected subjects. Definition evidence anchors
  // and superseded children are not asset applications. Accounting is a fact
  // about recorded work, never a semantic quality or successful-write verdict.
  function assetAccounting(root, items) {
    const assets = root.task.value.assets.map(assetUrn => ({ assetUrn, accounted: false, activeItemCount: 0 }));
    const byHash = new Map(assets.map(asset => [hash(asset.assetUrn).slice(0, 24), asset]));
    for (const item of items) {
      const asset = byHash.get(item.asset);
      requireValue(asset, "semantic_maintenance_binding_mismatch");
      if (!item.definition) { asset.accounted = true; asset.activeItemCount++; }
    }
    return assets;
  }
  function receipt(root, items, assets) {
    const unpreparedAssetCount = assets.filter(asset => !asset.accounted).length;
    return { publicationAuthorized: false, maintenanceRunUrn: root.run.urn, taskUrn: root.task.urn,
      sourceUrn: root.run.value.source, runVersion: root.run.version,
      ...(root.governance ? { governance: root.governance } : {}),
      state: root.seal ? root.seal.response ? "CONFIRMED" : "READY" : "DRAFT",
      planDigest: root.planDigest ?? null, selection: root.seal?.response ? parse(root.seal.response.text, prefix).selection : null,
      readOnly: policy(root.run.value.source).semanticPublicationApproved !== true,
      totalItems: items.length, totalRecordedItems: links(root.run, undefined, true).length,
      assetCount: assets.length, accountedAssetCount: assets.length - unpreparedAssetCount, unpreparedAssetCount,
      scopeDigest: hash(root.task.value.assets), scopeBasis: "NATIVE_TASK_SELECTED_ASSETS",
      auditAudience: "EXISTING_TASK_RUN_ACL", retryAllowed: false };
  }
  // Used by both the explicit scope read and the actual seal. It evaluates
  // structural prerequisites, not whether an Agent's semantic scheme is good.
  // Read all bound children only on these operations, not on every item receipt.
  async function sealAssessment(root, items, assets) {
    const activeIds = new Set(items.map(item => item.id));
    let staleDependencyItemCount = 0, deferredItemCount = 0;
    const deferredAssets = new Set();
    for (const item of items) {
      const value = await child(root, item);
      if (value.review && dependencies(value.saved).some(id => !activeIds.has(id))) staleDependencyItemCount++;
      if (value.observation?.gap?.code === "UNRESOLVED_OPERATION") {
        deferredItemCount++; deferredAssets.add(value.observation.assetUrn);
      }
    }
    const checks = [
      { condition: "PLAN_UNSEALED", met: !root.seal, error: "semantic_maintenance_plan_sealed" },
      { condition: "PLAN_OPEN", met: !root.run.value.closedAt, error: "task_run_closed" },
      { condition: "PLAN_HAS_ITEMS", met: items.length > 0, error: "semantic_maintenance_plan_sealed" },
      { condition: "ACTIVE_DEPENDENCIES", met: staleDependencyItemCount === 0, error: "semantic_maintenance_dependency_changed" },
      { condition: "SELECTED_ASSETS_ACCOUNTED", met: assets.every(asset => asset.accounted), error: "semantic_maintenance_assets_unaccounted" },
    ];
    return { structurallyReady: checks.every(check => check.met), checks, staleDependencyItemCount,
      deferredItemCount, deferredAssetCount: deferredAssets.size,
      deferralPolicy: "UNRESOLVED_OPERATION_NO_REPLAY_NO_TARGET_WRITE",
      completeSourceInventoryRequired: false, semanticCompletenessVerified: false,
      authorizationRecheckedOnWrite: true, originalSessionRequired: true, humanConsentRequiredForPublication: true };
  }
  async function scopeView(root, items, offset, subject) {
    requireValue(subject.assetUrn === undefined);
    // Pin every later page to the first receipt. Never fill a missing version
    // or assemble scope pages from different native plan revisions.
    requireValue((offset === 0 && subject.version === undefined) || subject.version === root.run.version,
      "semantic_maintenance_plan_changed");
    const assertCurrentScope = () => {
      const currentScope = catalogAssetScope(policy(root.run.value.source));
      requireValue(root.task.value.assets.every(asset => currentScope.includes(asset)), "semantic_maintenance_scope_changed");
    };
    assertCurrentScope();
    const assets = assetAccounting(root, items), visible = subject.view === "unprepared" ? assets.filter(asset => !asset.accounted) : assets;
    requireValue(Number.isInteger(offset) && offset >= 0 && offset <= visible.length);
    const page = visible.slice(offset, offset + 20), client = semanticNativeClient(context);
    for (const asset of page) await client.authorize(asset.assetUrn, catalogTypes[catalogAssetType(asset.assetUrn)].privilege);
    const sealing = await sealAssessment(root, items, assets);
    const current = await readRoot(root.run.urn);
    requireValue(current.run.version === root.run.version, "semantic_maintenance_plan_changed");
    assertCurrentScope();
    context.assertActive();
    return { format: "datahub-semantic.maintenance-scope/1", ...receipt(root, items, assets),
      view: subject.view, accountingBasis: "ACTIVE_APPLICATION_OR_KEEP_OR_GAP_NOT_SEMANTIC_COMPLETENESS",
      totalAssets: visible.length, offset, nextOffset: offset + page.length < visible.length ? offset + page.length : null,
      assets: page, sealing };
  }
  async function view(urn, offset = 0, subject = {}) {
    const root = await readRoot(urn), items = links(root.run), activeIds = new Set(items.map((item) => item.id));
    requireValue(subject.view === undefined || ["scope", "unprepared"].includes(subject.view));
    if (subject.view !== undefined) return scopeView(root, items, offset, subject);
    let visible = items, pageSize = 20;
    // Internal write delivery only; public read_maintenance never accepts this
    // selector. Keep full native reads and legacy receipts unchanged.
    if (subject.preparedItemId !== undefined) {
      visible = items.filter(item => item.id === subject.preparedItemId);
      requireValue(visible.length === 1, "semantic_maintenance_preparation_incomplete");
    }
    if (subject.assetUrn !== undefined) {
      requireValue(root.task.value.assets.includes(subject.assetUrn), "semantic_maintenance_scope_changed");
      requireValue(subject.version === root.run.version, "semantic_maintenance_plan_changed");
      // Current metadata visibility is required before exposing stored proposals.
      await inspectCatalogIntent({ contract: "catalog/1", action: "inspect_asset", requestId: randomUUID(),
        sourceUrn: root.run.value.source, assetUrn: subject.assetUrn }, context);
      visible = items.filter(item => !item.definition && item.asset === hash(subject.assetUrn).slice(0, 24));
      // A complete stored input can be near 24KB; one whole item per page keeps
      // subject context bounded without truncation or a second proposal store.
      pageSize = 1;
    } else if (subject.version !== undefined) requireValue(subject.version === root.run.version, "semantic_maintenance_plan_changed");
    requireValue(Number.isInteger(offset) && offset >= 0 && offset <= visible.length);
    const page = [];
    for (const item of visible.slice(offset, offset + pageSize)) {
      const value = await child(root, item);
      if (subject.assetUrn !== undefined) requireValue((value.observation ?? value.saved.request).assetUrn === subject.assetUrn,
        "semantic_maintenance_binding_mismatch");
      const revision = { planDigest: item.digest, childVersion: value.run.version,
        ...(item.supersedes ? { supersedes: { ...item.supersedes, recordRef: { runUrn: runUrn(item.supersedes.id), decisionId: item.supersedes.id } } } : {}) };
      if (value.observation) {
        const observed = await inspectCatalogIntent({ contract: "catalog/1", action: "inspect_asset", requestId: randomUUID(),
          sourceUrn: root.run.value.source, assetUrn: value.observation.assetUrn,
          ...(value.observation.evidenceMode ? { evidenceMode: value.observation.evidenceMode } : {}),
          ...(value.observation.fieldPath ? { fieldPath: value.observation.fieldPath } : {}) }, context);
        page.push({ id: item.id, ...revision, ...(value.observation.fieldPath ? { fieldPath: value.observation.fieldPath } : {}), status: observed.preview.snapshotDigest === value.observation.snapshotDigest ? observationStatus(value.observation) : "OBSERVATION_CHANGED",
          ...(value.observation.gap ? { gap: value.observation.gap } : {}),
          assetUrn: value.observation.assetUrn, candidateCount: value.observation.candidateCount,
          ...(subject.assetUrn === undefined ? {} : { observation: value.observation }) });
      } else {
        let status = "PENDING";
        if (value.decision.publicationAttempt) status = await initialAndCurrent(value) ? "VERIFIED" : verifiedInitial(value) ? "VERIFIED_CURRENT_CHANGED" : "ATTEMPTED_UNVERIFIED";
        else if (value.decision.response) status = value.decision.response.publicationVerdict?.verdict ?? "UNCONFIRMED";
        const staleDependencies = dependencies(value.saved).filter((id) => !activeIds.has(id));
        page.push({ id: item.id, ...revision, status, reviewRef: { runUrn: value.run.urn, decisionId: item.id },
          ...(value.saved.request.fieldPath ? { fieldPath: value.saved.request.fieldPath } : {}),
          requiresRevision: staleDependencies.length > 0, staleDependencies,
          planDigest: item.digest, assetUrn: value.saved.request.assetUrn, candidateCount: value.review.candidateIds.length,
          ...(value.saved.preview.definition ? { definition: { kind: value.saved.preview.definition.kind,
            urn: value.saved.preview.definition.proposedUrn, operation: value.saved.request.definition.operation,
            name: value.saved.preview.definition.after?.name ?? value.saved.preview.definition.after?.displayName ?? value.saved.request.definition.name,
            reference: { definitionItemId: item.id } } } : {}),
          dependencies: dependencies(value.saved),
          ...(subject.assetUrn === undefined ? {} : { preparedRequest: value.saved.request }) });
      }
    }
    if (subject.preparedItemId !== undefined) {
      const current = await readRoot(root.run.urn);
      requireValue(current.run.version === root.run.version, "semantic_maintenance_plan_changed");
    }
    return { format: "datahub-semantic.maintenance/1", ...receipt(root, items, assetAccounting(root, items)),
      offset, nextOffset: offset + page.length < visible.length ? offset + page.length : null,
      ...(subject.assetUrn === undefined ? {} : { assetView: { assetUrn: subject.assetUrn, itemCount: visible.length,
        definitionEvidenceAnchorsExcluded: true, completeInputs: true, semanticCompletenessClaimed: false } }),
      items: page };
  }
  async function continuePreparation(input) {
    // Foreground admission only, never native approval/publication or a saved
    // lease. A reload needs a new explicit intent in the original session.
    const root = await readRoot(input.maintenanceRunUrn, true);
    await pending(input);
    requireValue(root.run.value.sessionId === input.sessionId && !root.run.value.closedAt,
      "semantic_maintenance_binding_mismatch");
    const scope = catalogAssetScope(policy(root.run.value.source, true));
    requireValue(root.task.value.assets.every((asset) => scope.includes(asset)), "semantic_maintenance_scope_changed");
    const result = await view(root.run.urn);
    context.assertActive();
    return { ...result, foregroundPreparation: result.state === "DRAFT" };
  }
  async function reconcileStart(input) {
    requireValue(uuid.test(input.originalRequestId) && typeof input.sourceUrn === "string");
    const source = policy(input.sourceUrn);
    // Same current Source/recipe/asset ACL boundary as planning; never requires
    // publication capability merely to observe the original preparation.
    await inspectCatalogIntent({ contract: "catalog/1", action: "list_assets", requestId: input.requestId, sourceUrn: input.sourceUrn }, context);
    const locators = maintenanceStartLocators(context.actor.key, input.originalRequestId), client = semanticNativeClient(context);
    await client.identity();
    const projection = async (urn, kind, aspect) => {
      const row = await client.entity(urn, kind, [aspect], true), value = row[aspect];
      if (value === undefined) return { status: "NOT_FOUND" };
      requireValue(value?.value && /^[1-9][0-9]*$/.test(value.systemMetadata?.version), "semantic_maintenance_record_invalid");
      requireValue(value.value.actor === context.actor.urn && value.value.source === input.sourceUrn, "semantic_maintenance_binding_mismatch");
      return { status: "FOUND", version: value.systemMetadata.version, value: value.value };
    };
    const task = await projection(locators.taskUrn, "dataJob", "ekopAgentTask");
    const run = await projection(locators.runUrn, "dataProcessInstance", "ekopAgentRun");
    if (task.status === "FOUND") {
      const marker = parse(task.value.instructions, prefix);
      requireValue(marker.runUrn === locators.runUrn && marker.scopeDigest === hash(task.value.assets) &&
        task.value.assets.every(asset => catalogAssetScope(source).includes(asset)), "semantic_maintenance_binding_mismatch");
    }
    if (run.status === "FOUND") requireValue(run.value.task === locators.taskUrn &&
      (task.status !== "FOUND" || run.value.taskVersion === task.version), "semantic_maintenance_binding_mismatch");
    const saved = task.status === "FOUND" && run.status === "FOUND";
    const plan = saved ? await view(locators.runUrn) : undefined;
    let status = "PARTIAL_PREPARATION";
    if (saved) status = "SAVED_PLAN";
    else if (task.status === "NOT_FOUND" && run.status === "NOT_FOUND") status = "NO_CURRENT_RECORDS";
    context.assertActive();
    return { format: "datahub-semantic.start-reconciliation/1", sourceUrn: input.sourceUrn,
      originalRequestId: input.originalRequestId, ...locators,
      status,
      records: { task: { urn: locators.taskUrn, status: task.status, ...(task.version ? { version: task.version } : {}) },
        run: { urn: locators.runUrn, status: run.status, ...(run.version ? { version: run.version } : {}) } },
      ...(plan ? { state: plan.state, runVersion: plan.runVersion, planDigest: plan.planDigest } : {}),
      currentPolicy: semanticReviewPolicy(source, { catalog: true }), observedAt: now(),
      effect: "NOT_PROVEN", retryAllowed: false, readOnly: true, foregroundPreparation: false, publicationAuthorized: false,
      limitations: ["Current native records only; absence is not historical zero-effect proof.",
        "No original request replay, consent restoration, continuation or new-start authorization."] };
  }
  async function start(input) {
    const source = policy(input.sourceUrn, true), scope = catalogAssetScope(source);
    const focus = input.focus ?? "all";
    requireValue(governanceFocuses.includes(focus));
    const datasetOnly = ["table", "field"].includes(focus);
    const assets = input.assetUrns ?? scope.filter(asset => !datasetOnly || catalogAssetType(asset) === "dataset");
    requireValue(Array.isArray(assets) && (!datasetOnly || assets.every(asset => catalogAssetType(asset) === "dataset")));
    requireValue(Array.isArray(assets) && new Set(assets).size === assets.length && assets.every((asset) => scope.includes(asset)));
    requireValue(assets.length > 0 && assets.length <= 1024 && assets.every(catalogAssetType));
    await pending(input);
    // Validate Source recipe revision and real identity, without requiring a
    // synthetic latest-full-ingestion inventory or an AUTO policy.
    await inspectCatalogIntent({ contract: "catalog/1", action: "list_assets", requestId: input.requestId, sourceUrn: input.sourceUrn }, context);
    const urn = runUrn(input.requestId);
    await absent(urn);
    const { taskUrn } = maintenanceStartLocators(context.actor.key, input.requestId);
    try { await records.getTask(taskUrn); throw new TaskRecordError("semantic_maintenance_preparation_incomplete"); }
    catch (error) { if (!(error instanceof TaskRecordError) || error.message !== "task_record_not_found") throw error; }
    await pending(input);
    const task = await records.createTask(taskUrn, { agent: source.semanticAgentUrn, source: input.sourceUrn,
      assets, datasets: assets.filter((asset) => catalogAssetType(asset) === "dataset"),
      instructions: prefix + canonical({ runUrn: urn, scopeDigest: hash(assets), focus }), allowDecisions: true });
    await records.bindRun(urn, task.urn, task.version, input.sessionId);
    return view(urn);
  }
  async function prepare(input) {
    const root = await readRoot(input.maintenanceRunUrn, true);
    requireValue(!root.seal && !root.run.value.closedAt && root.run.value.sessionId === input.sessionId &&
      root.run.value.source === input.sourceUrn && root.task.value.assets.includes(input.assetUrn), "semantic_maintenance_plan_sealed");
    await pending(input);
    // The saved Task, not a later prompt or caller-supplied flag, owns the
    // narrowed category. Definition anchors do not expand its asset boundary.
    const focus = root.governance?.focus ?? "all";
    const allowedDefinition = focus === "glossary" ? ["node", "term"] : focus === "tag" ? ["tag"] : Object.keys(vocabularyTypes);
    const allowedCandidate = candidate => focus === "glossary" ? candidate.kind === "term" :
      focus === "tag" ? candidate.kind === "tag" : focus === "table" ? candidate.fieldPath === undefined :
      focus === "field" ? candidate.fieldPath !== undefined : true;
    if ((input.definition && !allowedDefinition.includes(input.definition.kind)) ||
        (Array.isArray(input.candidates) && !input.candidates.every(allowedCandidate)))
      throw new MaintenanceInputRejection(input, "semantic_maintenance_focus_mismatch");
    const items = links(root.run);
    if (input.version !== undefined) requireValue(root.run.version === input.version, "semantic_maintenance_plan_changed");
    if (items.some((entry) => entry.id === input.requestId))
      throw new TaskRecordError("semantic_maintenance_item_exists", 409, { runUrn: runUrn(input.requestId), retryAllowed: false });
    requireValue(links(root.run, undefined, true).length < 1024);
    let original;
    if (input.action === "revise_maintenance") {
      requireValue(uuid.test(input.itemId) && digest.test(input.planDigest) && root.run.version === input.version &&
        /^[1-9][0-9]*$/.test(input.childVersion), "semantic_maintenance_plan_changed");
      const item = items.find((entry) => entry.id === input.itemId);
      requireValue(item?.digest === input.planDigest, "semantic_maintenance_revision_binding_mismatch");
      original = await child(root, item);
      const subject = original.saved?.request ?? original.observation;
      requireValue(original.run.version === input.childVersion && !original.run.value.closedAt &&
        !original.decision.publicationAttempt && (!original.review || !original.decision.response),
        "semantic_maintenance_item_attempted");
      requireValue(subject.assetUrn === input.assetUrn && (subject.fieldPath ?? null) === (input.fieldPath ?? null) &&
        item.definition === Boolean(input.definition) && (!item.definition || subject.definition.kind === input.definition.kind),
        "semantic_maintenance_revision_binding_mismatch");
    }
    await absent(runUrn(input.requestId));
    const planning = { runUrn: root.run.urn, definitions: {}, priorChanges: [],
      ...(root.governance ? { governance: root.governance } : {}),
      ...(original ? { supersedes: { id: input.itemId, digest: input.planDigest, childVersion: input.childVersion } } : {}) }, previous = [];
    for (const item of items.filter((entry) => entry.id !== original?.decision.id &&
      (entry.definition || entry.asset === hash(input.assetUrn).slice(0, 24)))) {
      const value = await child(root, item);
      if (!value.review) continue;
      previous.push(value);
      const reference = { runUrn: value.run.urn, decisionId: value.decision.id };
      if (value.saved.request.definition) {
        const change = value.review.changes[0];
        planning.definitions[change.urn] = { kind: value.saved.request.definition.kind, urn: change.urn,
          expectedVersion: change.expectedVersion, before: parse(change.beforeValueJson, ""), after: parse(change.valueJson, ""), reviewRef: reference };
      }
      // A definition uses the asset as evidence, not as a pending association
      // prerequisite. Otherwise revising a definition creates a cycle through
      // the consumer that must subsequently be revised.
      for (const change of value.review.changes.filter((entry) => !input.definition && (entry.urn === input.assetUrn ||
        entry.urn.startsWith(`urn:li:schemaField:(${input.assetUrn},`))))
        planning.priorChanges.push({ ...change, reviewRef: reference });
    }
    const request = Object.fromEntries(["contract", "sourceUrn", "assetUrn", "fieldPath", "snapshotDigest", "evidenceMode", "candidates", "definition", "reason", "evidenceIds"]
      .filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
    // Selection only: resolve an explicitly named ACTIVE native definition
    // child, never a name/URI guess or a superseded item's replacement. Root
    // and child() already bind Source/actor/scope/digest; preserve URI callers.
    const definitionItems = new Map([...previous, ...(original?.saved?.request.definition ? [original] : [])]
      .filter(value => value.saved.request.definition).map(value => [value.decision.id, value]));
    const selectedReferences = new Map();
    const resolveReference = (value, kind) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      if (Object.keys(value).length !== 1 || !uuid.test(value.definitionItemId))
        throw new MaintenanceInputRejection(input, "semantic_maintenance_definition_reference_shape");
      if (input.version === undefined)
        throw new MaintenanceInputRejection(input, "semantic_maintenance_reference_version_required");
      if (selectedReferences.size === 0) {
        const scope = new Set(catalogAssetScope(policy(root.run.value.source, true)));
        requireValue(root.task.value.assets.every(asset => scope.has(asset)), "semantic_maintenance_scope_changed");
      }
      const selected = definitionItems.get(value.definitionItemId);
      // A locator absent from this verified active set is rejected locally;
      // never read/follow another Root or a superseded item's replacement.
      // Consumed or effect-uncertain children remain a hard stop.
      if (!selected)
        throw new MaintenanceInputRejection(input, "semantic_maintenance_definition_reference_not_active");
      requireValue(!selected.decision.response &&
        !selected.decision.publicationAttempt && !selected.run.value.closedAt,
        "semantic_maintenance_definition_reference_invalid");
      if (selected.saved.request.definition.kind !== kind)
        throw new MaintenanceInputRejection(input, "semantic_maintenance_definition_reference_kind_mismatch");
      selectedReferences.set(selected.decision.id, selected);
      return selected.review.changes[0].urn;
    };
    if (Array.isArray(request.candidates)) request.candidates = request.candidates.map(candidate => {
      if (!["domain", "tag", "term", "property"].includes(candidate.kind)) return candidate;
      return { ...candidate, ...(candidate.value === undefined ? {} : { value: resolveReference(candidate.value, candidate.kind) }),
        ...(candidate.values === undefined || candidate.kind === "property" ? {} :
          { values: Array.isArray(candidate.values) ? candidate.values.map(value => resolveReference(value, candidate.kind)) : candidate.values }) };
    });
    if (request.definition) request.definition = { ...request.definition,
      ...(request.definition.parentUrn === undefined ? {} :
        { parentUrn: resolveReference(request.definition.parentUrn, request.definition.kind === "domain" ? "domain" : "node") }) };
    Object.assign(request, { action: input.gap ? "inspect_asset" : input.definition ? "preview_definition" : "preview", requestId: input.requestId });
    // Catch ONLY the pure Catalog parser. This cannot hide ACL/CAS, I/O,
    // compilation or write failures; no child/decision has been written here.
    try { parseCatalogRequest(request); }
    catch (error) {
      if (error instanceof SemanticError) throw new MaintenanceInputRejection(input, error.message);
      throw error;
    }
    const inspected = await inspectCatalogIntent(request, context, {
      plannedDefinitions: new Map(Object.entries(planning.definitions)), priorChanges: planning.priorChanges,
      governance: planning.governance,
      rejectInput: (issue, location) => { throw new MaintenanceInputRejection(input, issue, location); },
    });
    if (input.gap) requireValue(inspected.preview.snapshotDigest === input.snapshotDigest, "semantic_snapshot_changed");
    else requireValue((inspected.preview.changes ?? []).every((entry) => entry.priorAgent?.status !== "UNVERIFIED_AGENT_BASELINE"),
      "semantic_maintenance_target_unresolved");
    if (input.definition?.operation === "update") {
      const aspect = vocabularyTypes[input.definition.kind].aspect;
      await records.assertResolvedSemanticTarget(input.definition.urn, aspect, inspected.definitionTarget[aspect], input.sourceUrn);
      planning.ownedDefinition = await records.ownedSemanticDefinition(input.definition.urn, aspect, inspected.definitionTarget[aspect], input.sourceUrn);
      planning.ownedImpact = await ownedDefinitionImpact(input.definition.kind, input.definition.urn, inspected.definitionTarget[aspect].value, input.sourceUrn,
        root.governance ? root.task.value.assets : undefined);
    }
    const changed = input.gap || request.definition ? undefined : request.candidates.filter((_, index) => inspected.preview.changes[index].operation !== "NO_CHANGE");
    let review, observation;
    const observationMode = input.evidenceMode ? { evidenceMode: input.evidenceMode } : {};
    if (input.gap) {
      observation = { runUrn: root.run.urn, assetUrn: input.assetUrn, ...(input.fieldPath ? { fieldPath: input.fieldPath } : {}), ...observationMode,
        snapshotDigest: input.snapshotDigest, requestDigest: hash(request), candidateCount: 0, observedAt: now(), gap: input.gap,
        ...(planning.supersedes ? { supersedes: planning.supersedes } : {}) };
    } else if (changed?.length === 0) {
      observation = { runUrn: root.run.urn, assetUrn: input.assetUrn, ...(input.fieldPath ? { fieldPath: input.fieldPath } : {}), ...observationMode,
        snapshotDigest: input.snapshotDigest, requestDigest: hash(request), candidateCount: request.candidates.length, observedAt: now(),
        ...(planning.supersedes ? { supersedes: planning.supersedes } : {}) };
    } else {
      if (changed) request.candidates = changed;
      review = await compileCatalogPublication(request, context, { planning, expiresAt: Number.MAX_SAFE_INTEGER });
      // Exact comparison of compiled targets, before bindRun/appendDecision.
      // A second field page must revise its whole saved item, not append a
      // competing Aspect. This proof permits only a NEW model input; recovery
      // of already saved children below remains a hard stop.
      if (!previous.every((value) => value.review.changes.every((before) =>
        review.changes.every((after) => before.urn !== after.urn || before.aspect !== after.aspect))))
        throw new MaintenanceInputRejection(input, "semantic_maintenance_aspect_overlap");
    }
    if (original?.saved?.request.definition) requireValue(review?.changes[0]?.urn === original.review.changes[0].urn,
      "semantic_maintenance_revision_binding_mismatch");
    await pending(input);
    if (input.version !== undefined) {
      const current = await readRoot(root.run.urn, true);
      requireValue(current.run.version === input.version && !current.seal &&
        (await records.getTask(root.task.urn)).version === root.task.version, "semantic_maintenance_plan_changed");
    }
    if (selectedReferences.size) {
      const scope = new Set(catalogAssetScope(policy(root.run.value.source, true)));
      requireValue(root.task.value.assets.every(asset => scope.has(asset)), "semantic_maintenance_scope_changed");
    }
    for (const selected of selectedReferences.values()) {
      const current = await records.getRun(selected.run.urn);
      requireValue(current.version === selected.run.version && isDeepStrictEqual(current.value, selected.run.value),
        "semantic_maintenance_dependency_changed");
    }
    if (original) {
      const prior = await records.getRun(original.run.urn);
      requireValue(prior.version === input.childVersion && isDeepStrictEqual(prior.value, original.run.value),
        "semantic_maintenance_plan_changed");
    }
    const childRun = await records.bindRun(runUrn(input.requestId), root.task.urn, root.task.version, input.sessionId);
    if (review) await records.appendPublicationReview(childRun.urn, childRun.version, input.sessionId,
      { id: input.requestId, question: "One item of the human-confirmed maintenance plan; no individual or automatic consent.", choices: [] }, review);
    else {
      const stored = await records.appendDecision(childRun.urn, childRun.version, input.sessionId,
        { id: input.requestId, question: (input.gap ? gapPrefix : keepPrefix) + canonical(observation), choices: [] });
      await records.respondDecision(childRun.urn, stored.version, input.sessionId, input.requestId, { action: "RESPOND", text: input.gap ? "EXPLICIT_GAP" : "OBSERVED_NO_CHANGE" });
    }
    const link = { id: input.requestId, digest: review?.planDigest ?? hash(observation),
      asset: hash(input.assetUrn).slice(0, 24), definition: Boolean(request.definition),
      ...(planning.supersedes ? { supersedes: planning.supersedes } : {}) };
    const current = await readRoot(root.run.urn, true);
    requireValue(!current.seal, "semantic_maintenance_plan_sealed");
    if (original) {
      const prior = await records.getRun(original.run.urn);
      requireValue(current.run.version === input.version && prior.version === input.childVersion &&
        isDeepStrictEqual(prior.value, original.run.value), "semantic_maintenance_plan_changed");
    }
    const appended = await records.appendDecision(root.run.urn, current.run.version, input.sessionId,
      { id: input.requestId, question: linkPrefix + canonical(link), choices: [] });
    const linked = await records.respondDecision(root.run.urn, appended.version, input.sessionId, input.requestId, { action: "RESPOND", text: "LINKED_NO_CONSENT" });
    if (input.responseMode === "incremental") {
      return { ...await view(root.run.urn, 0, { preparedItemId: input.requestId, version: linked.version }),
        delivery: "incremental", preparedItemId: input.requestId,
        ...(original ? { revisedItemId: input.itemId } : {}),
        delta: { baseVersion: root.run.version, completePlan: false,
          resyncRequired: current.run.version !== root.run.version || Boolean(original?.saved?.request.definition) } };
    }
    const index = original ? items.length - 1 : items.length;
    return { ...await view(root.run.urn, Math.floor(index / 20) * 20), preparedItemId: input.requestId,
      ...(original ? { revisedItemId: input.itemId } : {}) };
  }
  /** Repair only the manifest side of an exact, already saved native review.
   * No preparation, child rewrite, consent or target attempt is performed. An
   * interrupted append/response is handled by the same native root CAS. */
  async function recover(input) {
    requireValue(uuid.test(input.itemId) && digest.test(input.planDigest) &&
      /^[1-9][0-9]*$/.test(input.version) && /^[1-9][0-9]*$/.test(input.childVersion));
    const root = await readRoot(input.maintenanceRunUrn, true);
    requireValue(!root.seal && !root.run.value.closedAt && root.run.value.sessionId === input.sessionId,
      "semantic_maintenance_plan_sealed");
    requireValue(root.run.version === input.version, "semantic_maintenance_plan_changed");
    await pending(input);
    const scope = catalogAssetScope(policy(root.run.value.source, true));
    requireValue(root.task.value.assets.every((asset) => scope.includes(asset)), "semantic_maintenance_scope_changed");
    const items = links(root.run, input.itemId), allItems = links(root.run, input.itemId, true);
    requireValue(!allItems.some((entry) => entry.id === input.itemId) || items.some((entry) => entry.id === input.itemId),
      "semantic_maintenance_revision_binding_mismatch");
    const run = await records.getRun(runUrn(input.itemId)), decision = run.value.decisions[0];
    requireValue(run.version === input.childVersion && decision, "semantic_maintenance_preparation_incomplete");
    const review = decision.publicationReview ? validatePublicationReview(decision.publicationReview, now()) : undefined;
    const observation = review ? undefined : parse(decision.question, decision.question.startsWith(gapPrefix) ? gapPrefix : keepPrefix);
    // Observation recovery is only for this new revision path, never a means
    // to recreate/replay the historical missing-ID GAPs.
    requireValue(review || observation.supersedes, "semantic_maintenance_preparation_incomplete");
    const saved = review ? parse(review.semanticContextJson, "") : { actor: run.value.actor,
      request: observation, maintenance: { supersedes: observation.supersedes, definitions: {}, priorChanges: [] } };
    const link = { id: input.itemId, digest: review?.planDigest ?? hash(observation),
      asset: hash(saved.request.assetUrn).slice(0, 24), definition: Boolean(saved.request.definition),
      ...(saved.maintenance.supersedes ? { supersedes: saved.maintenance.supersedes } : {}) };
    requireValue(link.digest === input.planDigest && saved.actor === context.actor.urn &&
      root.task.value.assets.includes(saved.request.assetUrn), "semantic_maintenance_binding_mismatch");
    const value = await child(root, link);
    requireValue(!value.run.value.closedAt && (!review || !value.decision.response) && !value.decision.publicationAttempt,
      "semantic_maintenance_item_attempted");
    let original;
    if (link.supersedes) {
      const prior = allItems.find((entry) => entry.id === link.supersedes.id);
      requireValue(prior?.digest === link.supersedes.digest && prior.asset === link.asset && prior.definition === link.definition &&
        !allItems.some((entry) => entry.id !== link.id && entry.supersedes?.id === prior.id), "semantic_maintenance_revision_binding_mismatch");
      original = await child(root, prior);
      const subject = original.saved?.request ?? original.observation;
      requireValue(original.run.version === link.supersedes.childVersion && !original.run.value.closedAt &&
        !original.decision.publicationAttempt && (!original.review || !original.decision.response), "semantic_maintenance_item_attempted");
      requireValue(subject.assetUrn === saved.request.assetUrn && (subject.fieldPath ?? null) === (saved.request.fieldPath ?? null) &&
        (!link.definition || original.review.changes[0].urn === review?.changes[0].urn), "semantic_maintenance_revision_binding_mismatch");
    }
    const existing = items.find((entry) => entry.id === input.itemId);
    requireValue(!existing || isDeepStrictEqual(existing, link), "semantic_maintenance_binding_mismatch");
    requireValue(existing || items.length < 1024);
    const previous = new Map();
    for (const item of items.filter((entry) => entry.id !== input.itemId && entry.id !== link.supersedes?.id)) {
      const prior = await child(root, item);
      if (prior.review) {
        previous.set(item.id, prior);
        requireValue(!review || prior.review.changes.every((before) => review.changes.every((after) =>
          before.urn !== after.urn || before.aspect !== after.aspect)), "semantic_maintenance_aspect_overlap");
      }
    }
    for (const definition of Object.values(saved.maintenance.definitions)) {
      const prior = previous.get(definition.reviewRef.decisionId), change = prior?.review.changes[0];
      requireValue(prior?.saved.request.definition && definition.reviewRef.runUrn === prior.run.urn &&
        definition.kind === prior.saved.request.definition.kind && definition.urn === change.urn &&
        definition.expectedVersion === change.expectedVersion &&
        isDeepStrictEqual(definition.before, parse(change.beforeValueJson, "")) &&
        isDeepStrictEqual(definition.after, parse(change.valueJson, "")), "semantic_maintenance_dependency_changed");
    }
    for (const { reviewRef, ...change } of saved.maintenance.priorChanges) {
      const prior = previous.get(reviewRef.decisionId);
      requireValue(prior && reviewRef.runUrn === prior.run.urn &&
        prior.review.changes.some((entry) => isDeepStrictEqual(entry, change)), "semantic_maintenance_dependency_changed");
    }
    // Recheck the complete immutable review, current ACL, evidence, Source
    // policy and schema through the existing compiler. Never manufacture a
    // replacement digest or refresh the child to make recovery pass.
    if (review) await recompileSemanticPublication(review, context);
    else {
      const observed = await inspectCatalogIntent({ contract: "catalog/1", action: "inspect_asset", requestId: input.requestId,
        sourceUrn: root.run.value.source, assetUrn: observation.assetUrn,
        ...(observation.fieldPath ? { fieldPath: observation.fieldPath } : {}),
        ...(observation.evidenceMode ? { evidenceMode: observation.evidenceMode } : {}) }, context);
      requireValue(observed.preview.snapshotDigest === observation.snapshotDigest, "semantic_snapshot_changed");
    }
    await pending(input);
    const current = await readRoot(root.run.urn, true), currentChild = await records.getRun(run.urn);
    if (original) {
      const prior = await records.getRun(original.run.urn);
      requireValue(prior.version === original.run.version && isDeepStrictEqual(prior.value, original.run.value),
        "semantic_maintenance_plan_changed");
    }
    requireValue(current.run.version === input.version && !current.seal && !current.run.value.closedAt &&
      currentChild.version === input.childVersion && isDeepStrictEqual(currentChild.value, run.value) &&
      (await records.getTask(root.task.urn)).version === root.task.version, "semantic_maintenance_plan_changed");
    policy(root.run.value.source, true);
    if (!existing) {
      const appended = await records.appendDecision(root.run.urn, current.run.version, input.sessionId,
        { id: input.itemId, question: linkPrefix + canonical(link), choices: [] });
      await records.respondDecision(root.run.urn, appended.version, input.sessionId, input.itemId,
        { action: "RESPOND", text: "LINKED_NO_CONSENT" });
    } else if (!current.run.value.decisions.find((entry) => entry.id === input.itemId).response) {
      await records.respondDecision(root.run.urn, current.run.version, input.sessionId, input.itemId,
        { action: "RESPOND", text: "LINKED_NO_CONSENT" });
    }
    return { ...await view(root.run.urn, Math.floor((existing ? items.indexOf(existing) : items.length) / 20) * 20),
      recoveredItemId: input.itemId, recovery: "LINKED_EXISTING_REVIEW_NO_CONSENT" };
  }
  async function seal(input) {
    const root = await readRoot(input.maintenanceRunUrn, true);
    requireValue(root.run.value.sessionId === input.sessionId, "semantic_maintenance_plan_sealed");
    await pending(input);
    const items = links(root.run), assessment = await sealAssessment(root, items, assetAccounting(root, items));
    const failed = assessment.checks.find(check => !check.met);
    requireValue(!failed, failed?.error);
    await records.appendDecision(root.run.urn, root.run.version, input.sessionId,
      { id: sealId, question: prefix + canonical({ count: links(root.run).length, planDigest: planDigest(root) }), choices: [] });
    return view(root.run.urn);
  }
  async function approve(input) {
    const root = await readRoot(input.maintenanceRunUrn, true), items = links(root.run);
    requireValue(root.seal && !root.seal.response && root.run.version === input.version && root.planDigest === input.planDigest,
      "semantic_maintenance_plan_changed");
    const wanted = selected(input.selection, items.length);
    requireValue(wanted.some(Boolean), "semantic_maintenance_selection_invalid");
    for (let index = 0; index < items.length; index++) {
      if (!wanted[index]) continue;
      const value = await child(root, items[index]);
      if (value.review) {
        requireValue(!value.decision.response && !value.decision.publicationAttempt, "semantic_maintenance_item_attempted");
        for (const id of dependencies(value.saved)) requireValue(wanted[items.findIndex((entry) => entry.id === id)],
          "semantic_maintenance_selection_dependency_missing");
      }
    }
    await records.respondDecision(root.run.urn, root.run.version, root.run.value.sessionId, sealId,
      { action: "RESPOND", text: prefix + canonical({ planDigest: root.planDigest, selection: input.selection }) });
    return view(root.run.urn);
  }
  async function publish(input) {
    const root = await readRoot(input.maintenanceRunUrn, true);
    requireValue(root.planDigest === input.planDigest, "semantic_maintenance_plan_changed");
    const items = links(root.run), index = items.findIndex((entry) => entry.id === input.itemId);
    requireValue(index >= 0 && consent(root)[index], "semantic_maintenance_consent_required");
    const value = await child(root, items[index]);
    if (value.observation) return { ...await view(root.run.urn, Math.floor(index / 20) * 20), completedItemId: input.itemId, outcome: observationStatus(value.observation) };
    requireValue(!value.decision.publicationAttempt, "publication_already_attempted");
    const proof = { runUrn: root.run.urn, planDigest: root.planDigest };
    await authorizePublication(value.review, proof, { run: value.run, task: root.task });
    let approved = value.run;
    if (value.decision.response) {
      // A proven approval record with NO native attempt has not dispatched a
      // target. Continue the SAME consent; publisher's native claim CAS still
      // allows one attempt. Never infer this from equal target values.
      requireValue(value.decision.response.publicationVerdict?.verdict === "APPROVE" &&
        value.decision.response.publicationVerdict.planDigest === value.review.planDigest &&
        isDeepStrictEqual(parse(value.decision.response.text, prefix), proof), "semantic_maintenance_consent_required");
    } else approved = await records.respondPublicationReview(value.run.urn, value.run.version, value.run.value.sessionId, value.decision.id,
      { verdict: "APPROVE", planDigest: value.review.planDigest }, proof);
    const publication = await records.publishPublication(value.run.urn, approved.version, value.run.value.sessionId, value.decision.id, value.review);
    return { format: "datahub-semantic.maintenance-item/1", publicationAuthorized: false, maintenanceRunUrn: root.run.urn,
      planDigest: root.planDigest, itemId: input.itemId, reviewRef: { runUrn: value.run.urn, decisionId: value.decision.id },
      status: publication.status, retryAllowed: false };
  }
  return { view, authorizePublication, async handle(input) {
    requireValue(Object.hasOwn(maintenanceActions, input.action));
    context.assertActive();
    validateMaintenanceInput(input, context.actor.key);
    let result;
    if (input.action === "reconcile_maintenance_start") result = await reconcileStart(input);
    else if (input.action === "start_maintenance") result = await start(input);
    else if (["prepare_maintenance", "revise_maintenance"].includes(input.action)) result = await prepare(input);
    else if (input.action === "recover_maintenance") result = await recover(input);
    else if (input.action === "seal_maintenance") result = await seal(input);
    else if (input.action === "read_maintenance") result = await view(input.maintenanceRunUrn, input.offset ?? 0, input);
    else if (input.action === "continue_maintenance") result = await continuePreparation(input);
    else if (input.action === "approve_maintenance") result = await approve(input);
    else result = await publish(input);
    return { ...result, action: input.action, ...(input.requestId ? { requestId: input.requestId } : {}) };
  } };
}
