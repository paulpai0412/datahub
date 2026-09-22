// Operator policy only: approvals for existing Source recipe bytes, not a Source store.
export function ingestionPolicies(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_ingestion_policy");
  const result = new Map();
  for (const [actor, sources] of Object.entries(value)) {
    if (
      !/^[a-f0-9]{48}$/.test(actor) ||
      !Array.isArray(sources) ||
      sources.length > 8
    )
      throw new Error("invalid_ingestion_policy");
    const seen = new Set();
    for (const source of sources) {
      if (
        !source ||
        typeof source !== "object" ||
        Array.isArray(source) ||
        Object.keys(source).some(
          (key) =>
            !["cliVersion", "recipeSha256", "urn", "taskDatasets", "semanticModelContextApproved", "semanticPublicationApproved", "semanticDefinitionCreationApproved", "semanticAgentUrn", "semanticAuditAudience", "semanticOwners", "semanticDocumentationOrigins"].includes(
              key,
            ),
        ) ||
        ["semanticModelContextApproved", "semanticPublicationApproved", "semanticDefinitionCreationApproved"].some((key) => source[key] !== undefined && typeof source[key] !== "boolean") ||
        (source.semanticAgentUrn !== undefined && (typeof source.semanticAgentUrn !== "string" || !/^urn:li:aiAgent:[^\s]{1,480}$/.test(source.semanticAgentUrn))) ||
        (source.semanticAuditAudience !== undefined && source.semanticAuditAudience !== "EXISTING_TASK_RUN_ACL") ||
        (source.semanticPublicationApproved === true && (source.semanticModelContextApproved !== true || source.semanticAgentUrn === undefined || source.semanticAuditAudience !== "EXISTING_TASK_RUN_ACL")) ||
        (source.semanticDefinitionCreationApproved === true && source.semanticPublicationApproved !== true) ||
        (source.taskDatasets !== undefined &&
          (!Array.isArray(source.taskDatasets) ||
            source.taskDatasets.length === 0 ||
            source.taskDatasets.length > 16 ||
            new Set(source.taskDatasets).size !== source.taskDatasets.length ||
            source.taskDatasets.some(
              (urn) =>
                typeof urn !== "string" ||
                urn.length > 1024 ||
                !urn.startsWith("urn:li:dataset:"),
            ))) ||
        !/^urn:li:dataHubIngestionSource:[a-f0-9-]{36}$/.test(source.urn) ||
        !/^[a-f0-9]{64}$/.test(source.recipeSha256) ||
        source.cliVersion !== "1.7.0.9" ||
        seen.has(source.urn)
      )
        throw new Error("invalid_ingestion_policy");
      if (source.semanticOwners !== undefined && (!Array.isArray(source.semanticOwners) || source.semanticOwners.length > 16 ||
          source.semanticOwners.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry) ||
            Object.keys(entry).some((key) => !["urn", "type", "rule"].includes(key)) ||
            typeof entry.urn !== "string" || !/^urn:li:(corpuser|corpGroup):[^\s]+$/.test(entry.urn) || entry.urn.length > 1024 ||
            !["TECHNICAL_OWNER", "BUSINESS_OWNER", "DATA_STEWARD"].includes(entry.type) ||
            typeof entry.rule !== "string" || !entry.rule.trim() || entry.rule.length > 1000) ||
          new Set(source.semanticOwners.map((e) => JSON.stringify([e.urn, e.type]))).size !== source.semanticOwners.length)) throw new Error("invalid_ingestion_policy");
      if (source.semanticDocumentationOrigins !== undefined && (!Array.isArray(source.semanticDocumentationOrigins) || source.semanticDocumentationOrigins.length > 16 ||
          new Set(source.semanticDocumentationOrigins).size !== source.semanticDocumentationOrigins.length || source.semanticDocumentationOrigins.some((value) => {
            try { const url = new URL(value); return typeof value !== "string" || value.length > 256 || url.protocol !== "https:" || url.origin !== value; }
            catch { return true; }
          }))) throw new Error("invalid_ingestion_policy");
      seen.add(source.urn);
    }
    result.set(
      actor,
      sources.map((source) =>
        Object.freeze({
          ...source,
          ...(source.semanticOwners === undefined ? {} : { semanticOwners: Object.freeze(source.semanticOwners.map((e) => Object.freeze({ ...e }))) }),
          ...(source.semanticDocumentationOrigins === undefined ? {} : { semanticDocumentationOrigins: Object.freeze([...source.semanticDocumentationOrigins]) }),
          ...(source.taskDatasets === undefined
            ? {}
            : { taskDatasets: Object.freeze([...source.taskDatasets]) }),
        }),
      ),
    );
  }
  return result;
}
