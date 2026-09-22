import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Intent only: identity, source scope, Catalog and all authority remain in Host. */
export default function datahubSemantic(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: [fileURLToPath(new URL("../skills/datahub-semantic/SKILL.md", import.meta.url))],
  }));
  pi.registerTool({
    name: "datahub_semantic",
    label: "DataHub 語義維護",
    description:
      "Evidence-backed semantic maintenance for an approved ingestion source. " +
      "First list_sources, then inspect_source, inspect_dataset (20 fields/page), and preview. " +
      "Use only returned dataset URNs, exact fieldPaths, evidenceIds and snapshotDigest. " +
      "Subsequent field pages require offset=nextOffset plus the same snapshotDigest. " +
      "Preview up to 8 candidates: description text, or an existing domain/tag/term/property URN as value; " +
      "Property assignments need values (string/number). For a column property, inspect_dataset with root fieldPath first, then preview with that same root fieldPath and snapshotDigest, and candidate.fieldPath. " +
      "owner candidates need value=approved owner URN, ownerType and policy:owner evidence; documentation needs value=approved HTTPS URL and description. " +
      "inspect_impact takes datasetUrn, kind, referenceUrn; use start=nextStart with definitionVersion for later dependency pages. Observed dependencies are not global change authorization. " +
      "An operator allowlist is not proof of ingestion membership or full-source coverage. " +
      "search_vocabulary finds visible domain/node/term/tag/property definitions with query and start=nextStart. " +
      "preview_definition proposes a new definition, separate from an association, with definition, reason, evidenceIds and dataset snapshotDigest. " +
      "Definitions require kind/name/description; domain/node/term may use an existing parentUrn. " +
      "Property definitions require valueType string/number and cardinality SINGLE/MULTIPLE, optional allowedValues, Dataset only. " +
      "After preview, prepare_review persists eligible candidates (or one definition) as an exact Task/Run/Decision; never include conflicts or NO_CHANGE items. " +
      "The human opens the custom review card and chooses/approves in the trusted Host sidepanel. read_review reloads reviewRef.runUrn/decisionId. " +
      "A persisted review is not consent; the model cannot approve or publish. A consumed attempt must never be retried. " +
      "Native run matches are per asset, never full source coverage. No SQL, arbitrary Aspects, approval or publication action. " +
      "Request <=24KB and response <=48KB; overflow is an error, never truncated success.",
    parameters: Type.Object({
      action: StringEnum(["list_sources", "inspect_source", "inspect_dataset", "preview", "search_vocabulary", "preview_definition", "inspect_impact", "prepare_review", "read_review"] as const),
      runUrn: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
      decisionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      sourceUrn: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
      datasetUrn: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
      fieldPath: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
      referenceUrn: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
      definitionVersion: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*$" })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      snapshotDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      kind: Type.Optional(StringEnum(["domain", "node", "term", "tag", "property"] as const)),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      start: Type.Optional(Type.Integer({ minimum: 0, maximum: 980 })),
      definition: Type.Optional(Type.Object({
        kind: StringEnum(["domain", "node", "term", "tag", "property"] as const),
        name: Type.String({ minLength: 1, maxLength: 160 }),
        description: Type.String({ minLength: 1, maxLength: 8000 }),
        parentUrn: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        valueType: Type.Optional(StringEnum(["string", "number"] as const)),
        cardinality: Type.Optional(StringEnum(["SINGLE", "MULTIPLE"] as const)),
        allowedValues: Type.Optional(Type.Array(Type.Union([Type.String({ maxLength: 500 }), Type.Number()]), { minItems: 1, maxItems: 64 })),
      }, { additionalProperties: false })),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
      evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 20 })),
      candidates: Type.Optional(Type.Array(Type.Object({
        kind: StringEnum(["description", "domain", "tag", "term", "property", "owner", "documentation"] as const),
        ownerType: Type.Optional(StringEnum(["TECHNICAL_OWNER", "BUSINESS_OWNER", "DATA_STEWARD"] as const)),
        description: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
        fieldPath: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
        value: Type.String({ minLength: 1, maxLength: 2048 }),
        values: Type.Optional(Type.Array(Type.Union([Type.String({ maxLength: 2048 }), Type.Number()]), { minItems: 1, maxItems: 16 })),
        reason: Type.String({ minLength: 1, maxLength: 2048 }),
        evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 8 }),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 8 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "rpc") throw new Error("datahub_host_required");
      signal?.throwIfAborted();
      const requestId = randomUUID();
      const body = JSON.stringify({ ...params, requestId,
        ...(params.action === "prepare_review" ? { sessionId: ctx.sessionManager.getSessionId() } : {}),
      });
      if (Buffer.byteLength(body) > 24000) throw new Error("semantic_request_too_large");
      const response = await ctx.ui.input("DataHub semantic request", body, { signal, timeout: 60000 });
      if (response === undefined) throw new Error("semantic_request_cancelled_or_unavailable");
      signal?.throwIfAborted();
      let value: Record<string, unknown>;
      try {
        if (Buffer.byteLength(response) > 48000) throw new Error();
        value = JSON.parse(response);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      } catch { throw new Error("invalid_semantic_host_response"); }
      if (value.error) {
        const error = typeof value.error === "string" && /^[a-z_]{1,80}$/.test(value.error) ? value.error : "semantic_request_rejected";
        if (params.action === "prepare_review" && value.reconciliation && typeof value.reconciliation === "object" && !Array.isArray(value.reconciliation)) {
          const ref = value.reconciliation as Record<string, unknown>;
          const reconciliation = Object.fromEntries(["taskUrn", "runUrn", "decisionId"].filter((key) => typeof ref[key] === "string" && (ref[key] as string).length <= 1024).map((key) => [key, ref[key]]));
          const details = { format: "datahub-semantic.error/1", action: params.action, requestId, error, reconciliation, retryAllowed: false,
            note: "Preparation is unconfirmed. Read these native records; do not repeat preparation or infer approval/publication." };
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        }
        throw new Error(error);
      }
      if (value.requestId !== requestId || value.action !== params.action ||
          value.publicationAuthorized !== false || value.format !== (["prepare_review", "read_review"].includes(params.action) ? "datahub-semantic.review/1" : "datahub-semantic.preview/1")) {
        throw new Error("invalid_semantic_host_response");
      }
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
    },
  });
}
