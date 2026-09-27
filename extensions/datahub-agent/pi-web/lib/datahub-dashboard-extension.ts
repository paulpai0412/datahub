import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { isCatalogResult } from "./catalog-contract";
import {
  isDashboardDraft,
  type DashboardDraft,
} from "./dashboard-draft-contract";

/** Natural language may propose any visible Dataset. It cannot authorize an
 * invented metric, generate SQL, create a Grafana object or obtain values. */
export default function datahubDashboard(pi: ExtensionAPI) {
  pi.registerTool({
    name: "datahub_dashboard",
    label: "資料儀表板草稿",
    description:
      "Propose a chat dashboard for one exact DataHub Dataset returned by datahub_catalog. " +
      "Use its verified URN; identify the requested metric and optional grouping in plain " +
      "language, and choose a visualization. The Host rechecks the current actor and " +
      "Dataset visibility through native DataHub. This produces an UNAPPROVED draft " +
      "with no SQL, business figures, Grafana query, saved dashboard or execution. " +
      "For already approved SalesDatamart sales_by_category queries only, use " +
      "datahub_sql separately; unsupported metrics require source/semantic/SQL approval.",
    promptGuidelines: [
      "For an arbitrary dashboard request, first use datahub_catalog to identify the exact Dataset; never guess URNs or infer a Join from lineage.",
      "A draft is not an executed Grafana dashboard. Do not promise figures, claim source authorization, or call arbitrary SQL on its behalf.",
    ],
    parameters: Type.Object(
      {
        datasetUrn: Type.String({
          minLength: 16,
          maxLength: 1024,
          pattern: "^urn:li:dataset:",
        }),
        title: Type.String({ minLength: 1, maxLength: 120 }),
        metric: Type.String({ minLength: 1, maxLength: 120 }),
        dimension: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        visualization: StringEnum(["stat", "bar", "line", "table"] as const),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (ctx.mode !== "rpc") throw new Error("datahub_host_required");
      signal?.throwIfAborted();
      const requestId = randomUUID();
      const response = await ctx.ui.input(
        "DataHub catalog request",
        JSON.stringify({
          action: "entity",
          urn: params.datasetUrn,
          offset: 0,
          limit: 1,
          requestId,
        }),
        { signal, timeout: 30000 },
      );
      if (response === undefined || Buffer.byteLength(response) > 60000)
        throw new Error("dashboard_catalog_unavailable");
      signal?.throwIfAborted();
      let value: unknown;
      try {
        value = JSON.parse(response);
      } catch {
        throw new Error("dashboard_catalog_unavailable");
      }
      if (
        !isCatalogResult(value) ||
        value.requestId !== requestId ||
        value.action !== "entity" ||
        value.entity?.type !== "DATASET" ||
        value.entity.urn !== params.datasetUrn
      )
        throw new Error("dashboard_catalog_denied");
      const draft: DashboardDraft = {
        format: "datahub-dashboard.draft/1",
        requestId,
        state: "UNAPPROVED_NOT_EXECUTED",
        datasetUrn: value.entity.urn,
        datasetName: value.entity.name,
        title: params.title.trim(),
        metric: params.metric.trim(),
        dimension: params.dimension?.trim() || null,
        visualization: params.visualization,
        queriedAt: value.queriedAt,
      };
      if (!isDashboardDraft(draft)) throw new Error("dashboard_draft_invalid");
      return {
        content: [{ type: "text", text: JSON.stringify(draft) }],
        details: draft,
      };
    },
  });
}
