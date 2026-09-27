import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { queryParameters } from "./query-schema";
import { isQueryReceipt } from "./query-contract";

/** Metadata is the query authorization; source credentials never enter Pi. */
export default function datahubSql(pi: ExtensionAPI) {
  pi.registerTool({
    name: "datahub_sql",
    label: "Metadata SQL 與圖表查詢",
    description:
      "Execute a metadata-driven read-only query for any supported configured DataHub SQL source visible to this user. " +
      "First use datahub_catalog to obtain exact Dataset URNs and field paths. No extra per-user source grant or per-query human approval is required. " +
      "Declare table aliases in datasets; field refs use {dataset: alias, field: exact path}. Same-source inner/left/full joins support composite ON conditions: left must reference an already joined alias and right the new alias. " +
      "Preserve tenant/date predicates and grain; lineage is not a Join definition. Ask about materially ambiguous join meaning rather than guessing. " +
      "Select fields or sum/avg/min/max/count/count_distinct; field:null with count means COUNT(*). Optional bucket day/month/year applies to date fields. " +
      "groupBy lists all nonaggregate output aliases when aggregating. Filters are ANDed; values are bound parameters. orderBy uses output aliases. " +
      "Choose table, bar, timeseries or stat; x/y use output aliases, y must be numeric. No SQL text, endpoint, credentials or dashboard JSON is accepted. " +
      "Bar, timeseries and stat Dashboards automatically include a result table with the same returned rows and columns, subject to the query limit and truncation. " +
      "This is not a drill-down into underlying transaction rows omitted by aggregation. For a chart plus its result table, choose the chart type; do not repeat the same query with chart.type=table just to add that table. " +
      "Host checks current metadata, generates SQL, and lets the database enforce its connection permissions. Unsupported source, missing connection, DB refusal or timeout is an error, not fabricated data. " +
      "Return contains only an opaque resultRef. Next call datahub_grafana with that resultRef to create the dynamic interactive light-theme Dashboard in pi-web. " +
      "Never retry SQL after cancellation/timeout/unknown outcome; never claim a chart loaded solely from this receipt.",
    parameters: queryParameters,
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (ctx.mode !== "rpc") throw new Error("datahub_host_required");
      signal?.throwIfAborted();
      const requestId = randomUUID();
      const response = await ctx.ui.input(
        "DataHub SQL request",
        JSON.stringify({ action: "execute_query", ...params, requestId }),
        { signal, timeout: 120000 },
      );
      if (response === undefined)
        throw new Error("query_request_cancelled_or_unavailable");
      signal?.throwIfAborted();
      if (Buffer.byteLength(response) > 32768)
        throw new Error("query_invalid_host_response");
      let value: unknown;
      try {
        value = JSON.parse(response);
      } catch {
        throw new Error("query_invalid_host_response");
      }
      if (value && typeof value === "object" && "error" in value)
        throw new Error(
          typeof value.error === "string" &&
            /^(?:query|sql)_[a-z_]{1,60}$/.test(value.error)
            ? value.error
            : "query_request_rejected",
        );
      if (!isQueryReceipt(value) || value.requestId !== requestId)
        throw new Error("query_invalid_host_response");
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        details: value,
      };
    },
  });
}
