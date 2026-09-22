import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

/** Intent only. The trusted DataHub parent performs authorization and writes. */
export default function datahubIngestion(pi: ExtensionAPI) {
  pi.registerTool({
    name: "datahub_ingestion",
    label: "DataHub ingestion",
    description:
      "Operate operator-approved existing DataHub ingestion sources via the DataHub host. " +
      "Actions: list_sources, inspect_source, test_connection, run, get_execution, cancel. " +
      "Writes require human confirmation outside the runtime. No raw recipe, SQL or credentials accepted. " +
      "An unknown submission must be reconciled using its executionUrn, never blindly retried. " +
      "Job SUCCESS is not connection capability or metadata readback; inspect the returned details.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("list_sources"),
          Type.Literal("inspect_source"),
          Type.Literal("test_connection"),
          Type.Literal("run"),
          Type.Literal("get_execution"),
          Type.Literal("cancel"),
        ]),
        sourceUrn: Type.Optional(Type.String({ maxLength: 512, description: "Required for every action except list_sources, including get_execution and cancel." })),
        executionUrn: Type.Optional(Type.String({ maxLength: 512, description: "Required together with sourceUrn for get_execution and cancel." })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate, ctx) {
      if (params.action !== "list_sources" && !params.sourceUrn)
        throw new Error("sourceUrn is required for every action except list_sources.");
      if (["get_execution", "cancel"].includes(params.action) && !params.executionUrn)
        throw new Error("get_execution and cancel require executionUrn together with sourceUrn.");
      const requestId = randomUUID();
      const executionUrn = `urn:li:dataHubExecutionRequest:${requestId}`;
      const correlation = ["run", "test_connection"].includes(params.action)
        ? { proposedExecutionUrn: executionUrn }
        : ["get_execution", "cancel"].includes(params.action)
          ? { executionUrn: params.executionUrn }
          : {};
      const result = (value: Record<string, unknown>) => {
        const details = { ...value, requestId, ...correlation };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      };
      if (ctx.mode !== "rpc") return result({ error: "datahub_host_required" });
      onUpdate?.(result({ submitted: false }));
      const response = await ctx.ui.input(
        "DataHub ingestion request",
        JSON.stringify({ requestId, ...params }),
        { signal, timeout: 120000 },
      );
      if (response === undefined)
        return result({
          state: "unconfirmed",
          note: "No host response. Check execution state before retrying; this is not proof that no write occurred.",
        });
      try {
        const value = JSON.parse(response);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("invalid_response");
        return result(value);
      } catch {
        return result({
          error: "invalid_host_response",
        });
      }
    },
  });
}
