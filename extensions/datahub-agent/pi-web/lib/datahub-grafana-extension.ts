import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { isGrafanaEmbed, type GrafanaEmbed } from "./grafana-embed-contract";

/** Return a message-card launcher for the approved Grafana sidecard.
 *  The Host verifies the actor, org isolation and dashboard approval;
 *  the visual portal is managed by the MFE same-site bridge, never
 *  by the Pi iframe or this tool. No Grafana credentials, datasource
 *  tokens or arbitrary URLs are accepted. */
export default function datahubGrafana(pi: ExtensionAPI) {
  pi.registerTool({
    name: "datahub_grafana",
    label: "互動式 Grafana 儀表板",
    description:
      "After datahub_sql returns an unexpired resultRef, create a dynamic native Grafana Dashboard from its actual result columns and requested chart. " +
      "The pi-web right-side launcher opens the interactive Dashboard in light theme. " +
      "Bar, timeseries and stat Dashboards already include a result table with the same returned rows and columns, subject to the query limit and truncation; table creates a table-only Dashboard. " +
      "This is not a drill-down into underlying transaction rows omitted by aggregation. Do not repeat the same query or create another Dashboard solely for the companion table. " +
      "This tool NEVER re-executes SQL or accepts arbitrary URLs, datasource settings or dashboard JSON. " +
      "The Host rechecks all referenced metadata visibility and binds display to the current user. " +
      "An expired result fails without replay; a Grafana write with unknown outcome must not be blindly retried. " +
      "The browser needs its own Grafana Viewer login. Do not claim a mount proves data loaded.",
    parameters: Type.Object(
      {
        resultRef: Type.String({
          pattern: "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$",
          description:
            "Opaque resultRef returned by this actor's just-completed datahub_sql call.",
        }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      if (ctx.mode !== "rpc") throw new Error("datahub_host_required");
      signal?.throwIfAborted();
      const requestId = randomUUID();
      const response = await ctx.ui.input(
        "DataHub Grafana request",
        JSON.stringify({
          action: "grafana_authorize",
          resultRef: params.resultRef,
          requestId,
        }),
        { signal, timeout: 120000 },
      );
      if (response === undefined)
        throw new Error("grafana_request_cancelled_or_unavailable");
      signal?.throwIfAborted();
      if (Buffer.byteLength(response) > 32768)
        throw new Error("grafana_invalid_host_response");
      let value: unknown;
      try {
        value = JSON.parse(response);
      } catch {
        throw new Error("grafana_invalid_host_response");
      }
      if (value && typeof value === "object" && "error" in value) {
        const code = value.error;
        throw new Error(
          typeof code === "string" && /^grafana_[a-z_]{1,60}$/.test(code)
            ? code
            : typeof code === "string" && /^query_[a-z_]{1,60}$/.test(code)
              ? code
              : "grafana_request_rejected",
        );
      }
      if (
        !isGrafanaEmbed(value) ||
        value.requestId !== requestId ||
        Date.now() >= value.resultExpiresAt
      )
        throw new Error("grafana_invalid_host_response");
      // Both versions reject unknown fields; no source values or URL can leak.
      const details: GrafanaEmbed = value;
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  });
}
