import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SemanticError } from "./semantic-native-client.mjs";

export const catalogContract = "catalog/1";
// Item count only. Byte caps, Aspect count, policy targets and CAS stay separate.
export const semanticCandidateLimit = 1024;
export const catalogStewardVersion = "semantic-catalog/1";
// A human-confirmed, dependency-aware plan. Not an operator AUTO grant.
export const maintenanceStewardVersion = "semantic-maintenance/1";
export const isCatalogSteward = (version) =>
  [catalogStewardVersion, maintenanceStewardVersion].includes(version);
export const catalogTypes = Object.freeze({
  dataset: {
    privilege: "DATASET",
    info: "datasetProperties",
    editable: "editableDatasetProperties",
    key: "datasetKey",
  },
  container: {
    privilege: "CONTAINER",
    info: "containerProperties",
    editable: "editableContainerProperties",
    key: "containerKey",
  },
  dataFlow: {
    privilege: "DATA_FLOW",
    info: "dataFlowInfo",
    editable: "editableDataFlowProperties",
    key: "dataFlowKey",
  },
  dataJob: {
    privilege: "DATA_JOB",
    info: "dataJobInfo",
    editable: "editableDataJobProperties",
    key: "dataJobKey",
  },
  chart: {
    privilege: "CHART",
    info: "chartInfo",
    editable: "editableChartProperties",
    key: "chartKey",
  },
  dashboard: {
    privilege: "DASHBOARD",
    info: "dashboardInfo",
    editable: "editableDashboardProperties",
    key: "dashboardKey",
  },
});
export const vocabularyTypes = Object.freeze({
  domain: {
    entity: "domain",
    aspect: "domainProperties",
    privilege: "DOMAIN",
    parent: "parentDomain",
  },
  node: {
    entity: "glossaryNode",
    aspect: "glossaryNodeInfo",
    privilege: "GLOSSARY_NODE",
    parent: "parentNode",
  },
  term: {
    entity: "glossaryTerm",
    aspect: "glossaryTermInfo",
    privilege: "GLOSSARY_TERM",
    parent: "parentNode",
  },
  tag: { entity: "tag", aspect: "tagProperties", privilege: "TAG" },
  property: {
    entity: "structuredProperty",
    aspect: "propertyDefinition",
    privilege: "STRUCTURED_PROPERTY",
  },
});
export const catalogAspects = Object.freeze({
  ...Object.fromEntries(
    Object.entries(catalogTypes).map(([kind, type]) => [
      kind,
      [
        type.editable,
        "domains",
        "globalTags",
        "glossaryTerms",
        "structuredProperties",
        ...(kind === "dataset" ? ["editableSchemaMetadata"] : []),
      ],
    ]),
  ),
  schemaField: ["schemaFieldKey", "structuredProperties"],
  ...Object.fromEntries(
    Object.values(vocabularyTypes).map((type) => [type.entity, [type.aspect]]),
  ),
});
export const semanticText = (value, max = 2048) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
export function semanticRequire(
  condition,
  code = "invalid_semantic_catalog_request",
  status = 400,
) {
  if (!condition) throw new SemanticError(code, status);
}
export function semanticObject(value, allowed) {
  semanticRequire(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => allowed.includes(key)),
  );
}
export function catalogAssetType(urn) {
  if (!semanticText(urn, 1024)) return null;
  const type = /^urn:li:([A-Za-z]+):\S+$/.exec(urn)?.[1];
  return Object.hasOwn(catalogTypes, type ?? "") ? type : null;
}
export const catalogAssetScope = (policy) => [
  ...new Set([
    ...(policy.taskDatasets ?? []),
    ...(policy.semanticCatalogAssets ?? []),
  ]),
];
export const encodedSemanticField = (path) =>
  path.replace(/[(),]/g, (c) => ({ "(": "%28", ")": "%29", ",": "%2C" })[c]);
export const semanticFieldUrn = (urn, path) =>
  `urn:li:schemaField:(${urn},${encodedSemanticField(path)})`;
function reference(kind, value) {
  const type = vocabularyTypes[kind];
  semanticRequire(
    type &&
      semanticText(value, 1024) &&
      value.startsWith(`urn:li:${type.entity}:`) &&
      value.length > type.entity.length + 8,
    "semantic_invalid_reference",
  );
}
function stringSet(values, max = 16) {
  semanticRequire(
    Array.isArray(values) &&
      values.length <= max &&
      new Set(values).size === values.length &&
      values.every((v) => semanticText(v)),
    "semantic_invalid_candidate",
  );
}

export function validateCatalogCandidate(candidate) {
  semanticObject(candidate, [
    "kind",
    "operation",
    "fieldPath",
    "value",
    "values",
    "reason",
    "evidenceIds",
  ]);
  const { kind, operation } = candidate;
  semanticRequire(
    ["description", "domain", "tag", "term", "property"].includes(kind) &&
      ["add", "remove", "set"].includes(operation),
    "semantic_invalid_candidate",
  );
  semanticRequire(
    semanticText(candidate.reason) &&
      Array.isArray(candidate.evidenceIds) &&
      candidate.evidenceIds.length > 0 &&
      candidate.evidenceIds.every((v) => semanticText(v, 128)),
    "semantic_invalid_candidate",
  );
  if (candidate.fieldPath !== undefined)
    semanticRequire(
      semanticText(candidate.fieldPath) && kind !== "domain",
      "semantic_invalid_field",
    );
  if (kind === "description") {
    semanticRequire(
      operation !== "add" &&
        candidate.values === undefined &&
        (operation === "remove"
          ? candidate.value === undefined
          : semanticText(candidate.value, 8000)),
      "semantic_invalid_candidate",
    );
  } else if (kind === "property") {
    reference(kind, candidate.value);
    semanticRequire(operation !== "add", "semantic_invalid_candidate");
    if (operation === "remove")
      semanticRequire(
        candidate.values === undefined,
        "semantic_invalid_candidate",
      );
    else
      semanticRequire(
        Array.isArray(candidate.values) &&
          candidate.values.length > 0 &&
          candidate.values.length <= 16 &&
          new Set(candidate.values).size === candidate.values.length &&
          candidate.values.every(
            (v) =>
              semanticText(v) || (typeof v === "number" && Number.isFinite(v)),
          ),
        "semantic_invalid_property",
      );
  } else if (operation === "set") {
    semanticRequire(
      candidate.value === undefined,
      "semantic_invalid_candidate",
    );
    stringSet(candidate.values);
    candidate.values.forEach((v) => reference(kind, v));
  } else {
    semanticRequire(
      candidate.values === undefined,
      "semantic_invalid_candidate",
    );
    reference(kind, candidate.value);
  }
  return candidate;
}

export function validateCatalogDefinition(definition) {
  semanticObject(definition, [
    "kind",
    "operation",
    "urn",
    "version",
    "name",
    "description",
    "parentUrn",
    "valueType",
    "cardinality",
    "entityTypes",
    "allowedValues",
  ]);
  const { kind, operation } = definition;
  semanticRequire(
    Object.hasOwn(vocabularyTypes, kind) &&
      ["create", "update"].includes(operation),
    "semantic_invalid_definition",
  );
  if (operation === "update") {
    reference(kind, definition.urn);
    semanticRequire(
      typeof definition.version === "string" &&
        /^[1-9][0-9]*$/.test(definition.version),
      "semantic_definition_version_required",
    );
    semanticRequire(
      ["name", "description", "parentUrn"].some(
        (key) => definition[key] !== undefined,
      ),
      "semantic_empty_definition_update",
    );
    semanticRequire(
      ["valueType", "cardinality", "entityTypes", "allowedValues"].every(
        (key) => definition[key] === undefined,
      ),
      "semantic_property_definition_migration_unsupported",
    );
  } else {
    semanticRequire(
      definition.urn === undefined &&
        definition.version === undefined &&
        semanticText(definition.name, 160) &&
        semanticText(definition.description, 8000),
      "semantic_invalid_definition",
    );
  }
  if (definition.name !== undefined)
    semanticRequire(
      semanticText(definition.name, 160),
      "semantic_invalid_definition",
    );
  if (definition.description !== undefined)
    semanticRequire(
      semanticText(definition.description, 8000),
      "semantic_invalid_definition",
    );
  if (definition.parentUrn !== undefined) {
    semanticRequire(
      ["domain", "node", "term"].includes(kind),
      "semantic_invalid_definition",
    );
    if (definition.parentUrn !== null)
      reference(kind === "domain" ? "domain" : "node", definition.parentUrn);
  }
  if (kind !== "property")
    semanticRequire(
      ["valueType", "cardinality", "entityTypes", "allowedValues"].every(
        (key) => definition[key] === undefined,
      ),
      "semantic_invalid_definition",
    );
  if (kind === "property" && operation === "create") {
    semanticRequire(
      ["string", "number"].includes(definition.valueType) &&
        ["SINGLE", "MULTIPLE"].includes(definition.cardinality),
      "semantic_invalid_definition",
    );
    stringSet(definition.entityTypes, 7);
    semanticRequire(
      definition.entityTypes.length > 0 &&
        definition.entityTypes.every(
          (v) => v === "schemaField" || Object.hasOwn(catalogTypes, v),
        ),
      "semantic_invalid_definition",
    );
    if (definition.allowedValues !== undefined)
      semanticRequire(
        Array.isArray(definition.allowedValues) &&
          definition.allowedValues.length > 0 &&
          definition.allowedValues.length <= 64 &&
          new Set(definition.allowedValues).size ===
            definition.allowedValues.length &&
          definition.allowedValues.every((v) =>
            definition.valueType === "string"
              ? semanticText(v, 500)
              : typeof v === "number" && Number.isFinite(v),
          ),
        "semantic_invalid_definition",
      );
  }
  return definition;
}

export function catalogDefinitionUrn(definition, tenant, source) {
  validateCatalogDefinition(definition);
  if (definition.operation === "update") return definition.urn;
  const name = definition.name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        tenant,
        source,
        definition.kind,
        name,
        definition.parentUrn ?? null,
      ]),
    )
    .digest("hex");
  return `urn:li:${vocabularyTypes[definition.kind].entity}:ekop-semantic-${id}`;
}

export function applyCatalogDefinition(before, definition, urn) {
  validateCatalogDefinition(definition);
  const value = structuredClone(before ?? {});
  const type = vocabularyTypes[definition.kind];
  if (definition.operation === "create") {
    semanticRequire(before === null, "semantic_definition_target_exists", 409);
    if (definition.kind === "term") value.termSource = "INTERNAL";
    if (definition.kind === "property")
      Object.assign(value, {
        qualifiedName: `ekop.semantic.${urn.split(":").at(-1).slice(14)}`,
        valueType: `urn:li:dataType:datahub.${definition.valueType}`,
        cardinality: definition.cardinality,
        entityTypes: definition.entityTypes.map(
          (kind) => `urn:li:entityType:datahub.${kind}`,
        ),
        ...(definition.allowedValues
          ? {
              allowedValues: definition.allowedValues.map((item) => ({
                value: {
                  [typeof item === "number" ? "double" : "string"]: item,
                },
              })),
            }
          : {}),
      });
  } else
    semanticRequire(
      before && typeof before === "object" && !Array.isArray(before),
      "semantic_definition_target_missing",
      409,
    );
  if (definition.name !== undefined)
    value[definition.kind === "property" ? "displayName" : "name"] =
      definition.name.trim();
  if (definition.description !== undefined)
    value[
      ["node", "term"].includes(definition.kind) ? "definition" : "description"
    ] = definition.description;
  if (definition.parentUrn === null) delete value[type.parent];
  else if (definition.parentUrn !== undefined)
    value[type.parent] = definition.parentUrn;
  return value;
}

// One pure mutation implementation is used by compilation and the publisher's
// before-value protection. Only the selected paths can change; unknown members survive.
function associate(before, candidate, key) {
  semanticRequire(Array.isArray(before), "semantic_catalog_invalid", 409);
  const ids = before.map((item) => (key ? item?.[key] : item));
  semanticRequire(
    ids.every((id) => typeof id === "string") &&
      new Set(ids).size === ids.length,
    "semantic_catalog_invalid",
    409,
  );
  const desired =
    candidate.operation === "set"
      ? candidate.values
      : candidate.operation === "remove"
        ? ids.filter((id) => id !== candidate.value)
        : [...new Set([...ids, candidate.value])];
  // Keep the order and annotations of retained entries, appending only new ones.
  return [
    ...before.filter((_item, i) => desired.includes(ids[i])),
    ...desired
      .filter((id) => !ids.includes(id))
      .map((id) => (key ? { [key]: id } : id)),
  ];
}
export function catalogCandidateTarget(assetUrn, candidate) {
  const type = catalogAssetType(assetUrn);
  semanticRequire(type, "semantic_asset_type_unsupported");
  validateCatalogCandidate(candidate);
  if (candidate.fieldPath !== undefined) {
    semanticRequire(type === "dataset", "semantic_invalid_field");
    return candidate.kind === "property"
      ? {
          urn: semanticFieldUrn(assetUrn, candidate.fieldPath),
          aspect: "structuredProperties",
        }
      : { urn: assetUrn, aspect: "editableSchemaMetadata" };
  }
  return {
    urn: assetUrn,
    aspect: {
      description: catalogTypes[type].editable,
      domain: "domains",
      tag: "globalTags",
      term: "glossaryTerms",
      property: "structuredProperties",
    }[candidate.kind],
  };
}
/** Public Domains v2 encoding: both arrays describe the same associations.
 * Retain all metadata (including multiple attributions for one domain). The
 * pinned native API orders manual associations before propagated associations;
 * stable ordering within each group preserves the existing native order.
 */
export function applySemanticDomains(before, desired) {
  const value = structuredClone(before ?? {});
  const existing = value.domainAssociations ?? [];
  semanticRequire(
    Array.isArray(existing) &&
      existing.every(
        (entry) =>
          entry &&
          typeof entry.domain === "string" &&
          (value.domains ?? []).includes(entry.domain),
      ),
    "semantic_catalog_invalid",
    409,
  );
  const retained = existing.filter((entry) => desired.includes(entry.domain));
  const known = new Set(retained.map((entry) => entry.domain));
  const associations = [
    ...retained,
    ...desired
      .filter((domain) => !known.has(domain))
      .map((domain) => ({ domain })),
  ];
  const propagated = (entry) =>
    String(entry.attribution?.sourceDetail?.propagated ?? "").toLowerCase() ===
    "true";
  associations.sort((a, b) => Number(propagated(a)) - Number(propagated(b)));
  value.domainAssociations = associations;
  value.domains = [...new Set(associations.map((entry) => entry.domain))];
  return value;
}

export function applyCatalogCandidates(
  before,
  aspect,
  candidates,
  stamp,
  domainsAspectVersion = 2,
) {
  const value = structuredClone(before ?? {});
  for (const candidate of candidates) {
    validateCatalogCandidate(candidate);
    let target = value;
    if (
      candidate.fieldPath !== undefined &&
      aspect === "editableSchemaMetadata"
    ) {
      value.editableSchemaFieldInfo ??= [];
      target = value.editableSchemaFieldInfo.find(
        (field) => field.fieldPath === candidate.fieldPath,
      );
      if (!target) {
        target = { fieldPath: candidate.fieldPath };
        value.editableSchemaFieldInfo.push(target);
      }
    }
    if (candidate.kind === "description") {
      if (candidate.operation === "remove") delete target.description;
      else target.description = candidate.value;
    } else if (candidate.kind === "domain") {
      const domains = associate(target.domains ?? [], candidate);
      // Version 1 is only for reconstructing already sealed historical plans.
      if (domainsAspectVersion === 1) target.domains = domains;
      else Object.assign(target, applySemanticDomains(target, domains));
    } else if (candidate.kind === "tag") {
      const container = candidate.fieldPath
        ? (target.globalTags ??= {})
        : target;
      container.tags = associate(container.tags ?? [], candidate, "tag");
    } else if (candidate.kind === "term") {
      const container = candidate.fieldPath
        ? (target.glossaryTerms ??= {})
        : target;
      const terms = associate(container.terms ?? [], candidate, "urn");
      if (!isDeepStrictEqual(container.terms ?? [], terms))
        container.auditStamp = stamp;
      container.terms = terms;
    } else {
      target.properties ??= [];
      const item = target.properties.find(
        (entry) => entry.propertyUrn === candidate.value,
      );
      if (candidate.operation === "remove")
        target.properties = target.properties.filter(
          (entry) => entry.propertyUrn !== candidate.value,
        );
      else {
        const values = candidate.values.map((v) => ({
          [typeof v === "number" ? "double" : "string"]: v,
        }));
        if (item) item.values = values;
        else target.properties.push({ propertyUrn: candidate.value, values });
      }
    }
  }
  if (
    aspect === "editableSchemaMetadata" &&
    !isDeepStrictEqual(before ?? {}, value)
  ) {
    value.created ??= stamp;
    value.lastModified = stamp;
  }
  return value;
}

export function validateCatalogStewardChange(review, change, current, actor) {
  try {
    if (
      review.purpose !== "SEMANTIC" ||
      !isCatalogSteward(review.analysisVersion)
    )
      return false;
    const saved = JSON.parse(review.semanticContextJson),
      request = saved.request;
    if (
      saved.domainsAspectVersion !== undefined &&
      saved.domainsAspectVersion !== 2
    )
      return false;
    if (
      saved.actor !== actor ||
      request.contract !== catalogContract ||
      !Number.isSafeInteger(saved.createdAt) ||
      saved.createdAt >= review.expiresAt
    )
      return false;
    const before = JSON.parse(change.beforeValueJson);
    if (!isDeepStrictEqual(before, current ?? null)) return false;
    let after;
    if (request.definition) {
      const d = request.definition;
      if (
        change.urn !== saved.preview.definition.proposedUrn ||
        change.aspect !== vocabularyTypes[d.kind]?.aspect
      )
        return false;
      if (
        d.operation === "update" &&
        (change.urn !== d.urn || change.expectedVersion !== d.version)
      )
        return false;
      after = applyCatalogDefinition(before, d, change.urn);
    } else if (change.aspect === "schemaFieldKey") {
      const candidate = request.candidates.find(c => c.kind === "property" && c.operation === "set" &&
        c.fieldPath !== undefined && change.urn === semanticFieldUrn(request.assetUrn, c.fieldPath));
      if (before !== null || !candidate) return false;
      after = {
        parent: request.assetUrn,
        fieldPath: encodedSemanticField(candidate.fieldPath),
      };
    } else {
      const candidates = request.candidates.filter((c) => {
        const target = catalogCandidateTarget(request.assetUrn, c);
        return target.urn === change.urn && target.aspect === change.aspect;
      });
      if (!candidates.length) return false;
      after = applyCatalogCandidates(
        before,
        change.aspect,
        candidates,
        { actor, time: saved.createdAt },
        saved.domainsAspectVersion ?? 1,
      );
    }
    return isDeepStrictEqual(JSON.parse(change.valueJson), after);
  } catch {
    return false;
  }
}
