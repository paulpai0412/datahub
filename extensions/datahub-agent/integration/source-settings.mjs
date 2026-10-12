import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createOperatorConfigStore } from "./operator-config.mjs";
import { ingestionPolicies, sourceDatasetLimit } from "./ingestion-policy.mjs";
import { SemanticError, semanticNativeClient } from "./semantic-native-client.mjs";
import { canonicalPublicationJson } from "./publication-review.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => hash(canonicalPublicationJson(value));
const requireValue = (value, code, status = 409) => {
  if (!value) throw new SemanticError(code, status);
};
const sourcePattern = /^urn:li:dataHubIngestionSource:[a-f0-9-]{36}$/;
const editable = (policy) => !policy || (
  policy.ingestionExecutionApproved === false &&
  policy.semanticAutoManagement === undefined && policy.semanticAuditRecovery === undefined &&
  (policy.sourceSettingsManaged === true || (
    policy.semanticPublicationApproved !== true &&
    policy.semanticDefinitionCreationApproved !== true && policy.semanticDefinitionUpdatesApproved !== true))
);
const publicationState = (policy) => ({
  review: policy?.semanticPublicationApproved === true,
  createDefinitions: policy?.semanticDefinitionCreationApproved === true,
  updateDefinitions: policy?.semanticDefinitionUpdatesApproved === true,
  agentUrn: policy?.semanticAgentUrn ?? null,
});
const publicationInput = (value) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === 4 && ["review", "createDefinitions", "updateDefinitions"].every((key) => typeof value[key] === "boolean") &&
  (value.agentUrn === null || typeof value.agentUrn === "string");

/** The server rechecks captured operator grants at every awaited boundary.
 * Additions don't invalidate existing work; removed or changed grants do. */
export function sourcePolicyContext(context, policies) {
  const sources = policies.get(context.actor.key) ?? [], originalAssertActive = context.assertActive;
  return { ...context, sources, assertActive() {
    originalAssertActive();
    const current = policies.get(context.actor.key) ?? [];
    requireValue(sources.every((source) => isDeepStrictEqual(source, current.find((s) => s.urn === source.urn))),
      "source_settings_access_changed", 403);
  } };
}

/** Existing deployment configuration only, never a second metadata datastore.
 * All Host writers use one exclusive lock. External operator edits require a
 * Host reload; they are not silently merged into the running control plane. */
export async function createSourceSettingsStore(path, apply, shared) {
  const store = shared ?? await createOperatorConfigStore(path,
    (config) => ingestionPolicies(config.ingestionSourcesByActor),
    (config) => apply(ingestionPolicies(config.ingestionSourcesByActor)));
  const initial = await store.current();
  requireValue(initial.config.sourceSettingsEnabled === true && initial.config.readOnlyCore !== true, "source_settings_not_enabled", 403);
  return {
    async current() {
      const { revision, config } = await store.current();
      return { revision, policies: config.ingestionSourcesByActor ?? {} };
    },
    async save(expected, actorKey, entry, authorize) {
      const result = await store.save(expected, (config) => {
        const old = config.ingestionSourcesByActor?.[actorKey] ?? [];
        const sources = old.some((s) => s.urn === entry.urn)
          ? old.map((s) => s.urn === entry.urn ? entry : s) : [...old, entry];
        const next = { ...config, ingestionSourcesByActor: { ...config.ingestionSourcesByActor, [actorKey]: sources } };
        ingestionPolicies(next.ingestionSourcesByActor);
        return next;
      }, authorize);
      return { ...result, policy: entry };
    },
  };
}

/** Admin browser operation. Not exposed as a Pi tool. All data comes from
 * authenticated fixed DataHub APIs; recipe/Secret values never leave Host. */
export function createSourceSettingsHost({ store, frontendOrigin, fetchImpl = fetch }) {
  return async (text, context) => {
    let input;
    try { input = JSON.parse(text); } catch { throw new SemanticError("source_settings_invalid_request", 400); }
    const keys = {
      list: ["action", "offset"], inspect: ["action", "sourceUrn"],
      preview: ["action", "sourceUrn", "revision", "sourceVersion", "datasetUrns", "enabled", "publication"],
      save: ["action", "sourceUrn", "revision", "sourceVersion", "datasetUrns", "enabled", "publication", "planDigest"],
    };
    requireValue(input && Object.hasOwn(keys, input.action) && Object.keys(input).every((k) => keys[input.action].includes(k)) &&
      Buffer.byteLength(text) <= 262144, "source_settings_invalid_request", 400);
    const client = semanticNativeClient({ ...context, frontendOrigin, fetchImpl });
    async function authorize() {
      context.assertActive();
      const me = (await client.call("/api/v2/graphql", {
        query: "query { me { corpUser { urn } platformPrivileges { manageIngestion managePolicies } } }",
      })).data?.me;
      requireValue(me?.corpUser?.urn === context.actor.urn && me.platformPrivileges?.manageIngestion === true &&
        me.platformPrivileges?.managePolicies === true, "source_settings_admin_required", 403);
      context.assertActive();
    }
    await authorize();
    const state = await store.current(), actorSources = state.policies[context.actor.key] ?? [];
    // Only identities already configured by the trusted Host for this actor.
    // The browser cannot invent an Agent identity or an audit audience.
    const agentUrns = [...new Set(actorSources.map((p) => p.semanticAgentUrn).filter(Boolean))].sort();
    const base = { format: "datahub-source-settings/1", revision: state.revision, actorUrn: context.actor.urn };
    if (input.action === "list") {
      const start = input.offset ?? 0;
      requireValue(Number.isSafeInteger(start) && start >= 0 && start <= 1000, "source_settings_invalid_page", 400);
      const page = (await client.call("/api/v2/graphql", {
        query: "query($input:ListIngestionSourcesInput!){listIngestionSources(input:$input){start count total ingestionSources{urn name type latestSuccessfulExecution{urn}}}}",
        variables: { input: { start, count: 20 } },
      })).data?.listIngestionSources;
      requireValue(page?.start === start && Array.isArray(page.ingestionSources) && page.ingestionSources.length <= 20,
        "source_settings_native_invalid");
      const end = start + page.ingestionSources.length;
      requireValue(end > start || end >= page.total, "source_settings_native_invalid");
      await authorize();
      return { ...base, nextOffset: end < page.total && end <= 1000 ? end : null,
        truncated: end <= 1000 && end < page.total && end === 1000,
        sources: page.ingestionSources.map((source) => {
          const policy = actorSources.find((p) => p.urn === source.urn);
          return { ...source, enabled: policy?.semanticModelContextApproved === true, configured: !!policy,
            datasetCount: policy?.taskDatasets?.length ?? 0, editable: editable(policy), supported: source.type === "mssql",
            publication: publicationState(policy) };
        }) };
    }
    requireValue(sourcePattern.test(input.sourceUrn), "source_settings_invalid_source", 400);
    await client.authorize(input.sourceUrn, "INGESTION_SOURCE");
    const row = await client.entity(input.sourceUrn, "dataHubIngestionSource", ["dataHubIngestionSourceInfo"]);
    const envelope = row.dataHubIngestionSourceInfo, info = envelope?.value;
    requireValue(typeof info?.config?.recipe === "string" && typeof envelope.systemMetadata?.version === "string",
      "source_settings_native_invalid");
    let recipe;
    try { recipe = JSON.parse(info.config.recipe); } catch { throw new SemanticError("source_settings_recipe_invalid", 409); }
    const sourceConfig = recipe?.source?.config;
    requireValue(info.type === "mssql" && recipe.source.type === "mssql" && info.config.version === "1.7.0.9" &&
      typeof sourceConfig?.database === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(sourceConfig.database) &&
      sourceConfig.platform_instance === undefined, "source_settings_connector_not_supported");
    const source = { urn: input.sourceUrn, name: info.name, type: info.type, version: envelope.systemMetadata.version,
      recipeSha256: hash(info.config.recipe), cliVersion: info.config.version, database: sourceConfig.database };
    const assets = [];
    let start = 0, total;
    do {
      const page = (await client.call("/api/v2/graphql", {
        query: "query($input:SearchInput!){search(input:$input){start count total searchResults{entity{urn}}}}",
        variables: { input: { type: "DATASET", query: source.database, start, count: 20 } },
      })).data?.search;
      requireValue(page?.start === start && Number.isSafeInteger(page.total) && page.total <= sourceDatasetLimit &&
        Array.isArray(page.searchResults) && (page.searchResults.length > 0 || start >= page.total), "source_settings_inventory_incomplete");
      total = page.total;
      for (const hit of page.searchResults) {
        const urn = hit.entity?.urn, match = /^urn:li:dataset:\(urn:li:dataPlatform:mssql,([^,]+),([^,]+)\)$/.exec(urn ?? "");
        if (!match || match[1].split(".")[0].toLowerCase() !== source.database.toLowerCase()) continue;
        if (!(await client.canRead(urn, "DATASET"))) continue;
        const asset = await client.entity(urn, "dataset", ["schemaMetadata", "status"]);
        if (asset.status?.value?.removed === true || asset.schemaMetadata?.systemMetadata?.pipelineName !== source.urn) continue;
        const schema = asset.schemaMetadata;
        requireValue(Array.isArray(schema.value?.fields), "source_settings_native_invalid");
        assets.push({ urn, fieldCount: schema.value.fields.length, runId: schema.systemMetadata.runId ?? null });
      }
      start += page.searchResults.length;
    } while (start < total);
    requireValue(new Set(assets.map((a) => a.urn)).size === assets.length, "source_settings_inventory_changed");
    assets.sort((a, b) => a.urn.localeCompare(b.urn));
    const prior = actorSources.find((p) => p.urn === source.urn);
    const editablePolicy = editable(prior);
    await authorize();
    if (input.action === "inspect") return { ...base, source, assets, editable: editablePolicy,
      enabled: prior?.semanticModelContextApproved === true, selectedDatasetUrns: prior?.taskDatasets ?? [],
      scopeBasis: "existing_source_provenance_and_current_acl_not_latest_full_scan", autoPublicationEnabled: false,
      publication: publicationState(prior), agentUrns };
    requireValue(editablePolicy, "source_settings_deployment_managed", 403);
    requireValue(input.revision === state.revision && input.sourceVersion === source.version, "source_settings_version_conflict");
    requireValue(typeof input.enabled === "boolean" && Array.isArray(input.datasetUrns) && input.datasetUrns.length > 0 &&
      input.datasetUrns.length <= sourceDatasetLimit && new Set(input.datasetUrns).size === input.datasetUrns.length &&
      input.datasetUrns.every((urn) => assets.some((asset) => asset.urn === urn)), "source_settings_scope_not_authorized", 403);
    // Legacy metadata-only callers remain valid, but cannot silently revoke an
    // existing publishing policy without an explicit capability diff.
    requireValue(input.publication !== undefined || prior?.semanticPublicationApproved !== true,
      "source_settings_publication_confirmation_required", 400);
    const publication = input.publication ?? { review: false, createDefinitions: false, updateDefinitions: false, agentUrn: null };
    requireValue(publicationInput(publication) &&
      (!publication.review || input.enabled) &&
      (!(publication.createDefinitions || publication.updateDefinitions) || publication.review),
      "source_settings_publication_invalid", 400);
    requireValue((publication.agentUrn === null || agentUrns.includes(publication.agentUrn)) &&
      (!publication.review || publication.agentUrn !== null), "source_settings_agent_not_configured", 403);
    const entry = { ...prior, urn: source.urn, recipeSha256: source.recipeSha256, cliVersion: source.cliVersion,
      sourceSettingsManaged: true, taskDatasets: [...input.datasetUrns].sort(), semanticModelContextApproved: input.enabled,
      semanticCatalogUpdatesApproved: input.enabled, semanticPublicationApproved: publication.review,
      semanticDefinitionCreationApproved: publication.createDefinitions, semanticDefinitionUpdatesApproved: publication.updateDefinitions,
      ingestionExecutionApproved: false };
    if (publication.agentUrn) {
      entry.semanticAgentUrn = publication.agentUrn;
      entry.semanticAuditAudience = "EXISTING_TASK_RUN_ACL";
    } else {
      delete entry.semanticAgentUrn;
      delete entry.semanticAuditAudience;
    }
    ingestionPolicies({ [context.actor.key]: [entry] });
    const plan = { ...base, source, before: { enabled: prior?.semanticModelContextApproved === true, datasetUrns: prior?.taskDatasets ?? [], publication: publicationState(prior) },
      after: { enabled: input.enabled, datasetUrns: entry.taskDatasets, publication: publicationState(entry) },
      publicationApproved: publication.review, ingestionExecutionApproved: false, autoPublicationEnabled: false,
      scopeBasis: "existing_source_provenance_and_current_acl_not_latest_full_scan" };
    const planDigest = digest(plan);
    if (input.action === "preview") return { ...plan, planDigest };
    requireValue(input.planDigest === planDigest, "source_settings_plan_changed");
    const saved = await store.save(input.revision, context.actor.key, entry, authorize);
    return { ...base, revision: saved.revision, source, enabled: entry.semanticModelContextApproved,
      selectedDatasetUrns: entry.taskDatasets, status: "SAVED_AND_ACTIVE", publicationApproved: publication.review,
      publication: publicationState(entry), autoPublicationEnabled: false, ingestionExecutionApproved: false, planDigest };
  };
}
