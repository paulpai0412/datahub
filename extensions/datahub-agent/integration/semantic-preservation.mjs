import { isDeepStrictEqual } from "node:util";

// Only the typed Steward compiler may use these; the legacy semantic publisher
// retains its original allowlist and whole-Aspect ownership requirement.
export const stewardAspects = Object.freeze({
  dataset: ["editableDatasetProperties", "editableSchemaMetadata", "globalTags", "glossaryTerms", "domains", "structuredProperties", "ownership", "institutionalMemory"],
  schemaField: ["schemaFieldKey", "structuredProperties"],
  domain: ["domainProperties"], glossaryNode: ["glossaryNodeInfo"],
  glossaryTerm: ["glossaryTermInfo"], tag: ["tagProperties"], structuredProperty: ["propertyDefinition"],
});
export const stewardVersion = "semantic-steward/1";

/** A narrow addition/fill-only exception, NOT adoption of an entire Aspect.
 * Preserve every pre-existing value, unknown member, array entry and ordering.
 * Only the native edit audit stamps may advance to this review's fixed stamp.
 */
export function preservesSemanticValue(before, after, stamp, aspect, path = []) {
  if (isDeepStrictEqual(before, after)) return true;
  const key = path.at(-1);
  const editStamp = key === "lastModified" && path.length === 1 && ["editableSchemaMetadata", "ownership"].includes(aspect);
  const termStamp = key === "auditStamp" && ((aspect === "glossaryTerms" && path.length === 1) ||
    (aspect === "editableSchemaMetadata" && path.length === 4 && path[0] === "editableSchemaFieldInfo" && path[2] === "glossaryTerms"));
  if ((editStamp || termStamp) && isDeepStrictEqual(after, stamp)) return true;
  if (Array.isArray(before)) return Array.isArray(after) && after.length >= before.length &&
    before.every((value, index) => preservesSemanticValue(value, after[index], stamp, aspect, [...path, String(index)]));
  if (before && typeof before === "object" && after && typeof after === "object" && !Array.isArray(after)) {
    return Object.entries(before).every(([name, value]) => Object.hasOwn(after, name) &&
      preservesSemanticValue(value, after[name], stamp, aspect, [...path, name]));
  }
  return false;
}

export function validateStewardChange(review, change, current, actor) {
  if (review.purpose !== "SEMANTIC" || review.analysisVersion !== stewardVersion || typeof review.semanticContextJson !== "string") return false;
  const context = JSON.parse(review.semanticContextJson);
  if (context.actor !== actor || !Number.isSafeInteger(context.createdAt) || context.createdAt < 0 ||
      context.createdAt >= review.expiresAt || !Object.hasOwn(change, "beforeValueJson")) return false;
  const before = JSON.parse(change.beforeValueJson), after = JSON.parse(change.valueJson);
  if (!isDeepStrictEqual(before, current ?? null)) return false;
  const entity = change.urn.split(":")[2];
  if (!["dataset", "schemaField"].includes(entity)) return before === null && change.expectedVersion === "-1";
  if (change.aspect === "schemaFieldKey") return before === null && change.expectedVersion === "-1";
  return before === null || preservesSemanticValue(before, after, { actor, time: context.createdAt }, change.aspect);
}
