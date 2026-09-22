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
            !["cliVersion", "recipeSha256", "urn", "taskDatasets"].includes(
              key,
            ),
        ) ||
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
      seen.add(source.urn);
    }
    result.set(
      actor,
      sources.map((source) =>
        Object.freeze({
          ...source,
          ...(source.taskDatasets === undefined
            ? {}
            : { taskDatasets: Object.freeze([...source.taskDatasets]) }),
        }),
      ),
    );
  }
  return result;
}
