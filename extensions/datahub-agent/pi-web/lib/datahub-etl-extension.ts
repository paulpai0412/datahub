import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Metadata intent only; all WSL reads and Catalog authority stay in the Host. */
export default function datahubEtl(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: [
      fileURLToPath(new URL("../skills/datahub-etl/SKILL.md", import.meta.url)),
    ],
  }));
  pi.registerTool({
    name: "datahub_etl",
    label: "datahub_etl",
    description:
      "Analyze an authorized WSL ETL directory/program and show a structured metadata preview in this chat. " +
      "First list_workspaces; then analyze_workspace with its sourceId and the user's path as selection. " +
      "Host discovers files and entrypoints. Ask only for ambiguous entrypoint/connection choices. " +
      "Use returned connection IDs and scopeChoices, never per-statement mappings or user-written URNs. " +
      "Connection selections require the returned snapshotSha256. Response is bounded to 60 KB; overflow is an error, not a truncated success. " +
      "After a complete preview, import_workspace requests trusted human confirmation in this same chat. " +
      "The Host binds native Task/Run/Decision, compiles the exact diff and publishes only after the human clicks Approve and import. " +
      "Never supply approval or Aspects. read_import reads native evidence using the returned runUrn and decisionId; it never retries writes. " +
      "No source execution, SQL or credentials. Report blockers; declarations are not proof of runtime business semantics.",
    parameters: Type.Object(
      {
        action: StringEnum([
          "list_workspaces",
          "analyze_workspace",
          "import_workspace",
          "read_import",
        ] as const),
        runUrn: Type.Optional(Type.String({ maxLength: 1024 })),
        decisionId: Type.Optional(Type.String({ format: "uuid" })),
        sourceId: Type.Optional(Type.String({ maxLength: 128 })),
        selection: Type.Optional(Type.String({ maxLength: 1024 })),
        pythonPath: Type.Optional(Type.String({ maxLength: 512 })),
        entrypoint: Type.Optional(
          Type.String({ pattern: "^[A-Za-z_]\\w{0,127}$" }),
        ),
        snapshotSha256: Type.Optional(
          Type.String({ pattern: "^[a-f0-9]{64}$" }),
        ),
        connections: Type.Optional(
          Type.Record(
            Type.String({ pattern: "^connection:[a-f0-9]{64}$" }),
            Type.String({ maxLength: 128 }),
            { maxProperties: 128 },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "rpc") throw new Error("datahub_host_required");
      if (
        ["analyze_workspace", "import_workspace"].includes(params.action) &&
        (!params.sourceId || !params.selection)
      )
        throw new Error(
          "Choose an authorized workspace and supply the user's WSL path",
        );
      if (params.connections && !params.snapshotSha256)
        throw new Error(
          "Connection choices require the analyzed snapshotSha256",
        );
      const importing = params.action === "import_workspace";
      const reading = params.action === "read_import";
      if (importing && (!params.snapshotSha256 || !params.connections))
        throw new Error(
          "Analyze and resolve connections before requesting import",
        );
      if (reading && (!params.runUrn || !params.decisionId))
        throw new Error("Use the Host-returned runUrn and decisionId");
      if (
        !reading &&
        (params.runUrn !== undefined || params.decisionId !== undefined)
      )
        throw new Error("Run references are only for read_import");
      const requestId = reading ? params.decisionId! : randomUUID();
      const request = importing
        ? {
            action: "import_workspace",
            requestId,
            sessionId: ctx.sessionManager.getSessionId(),
            analysis: { ...params, action: "analyze_workspace", requestId },
          }
        : reading
          ? {
              action: "read_workspace_import",
              requestId,
              runUrn: params.runUrn,
            }
          : { ...params, requestId };
      const response = await ctx.ui.input(
        importing
          ? "DataHub workspace import"
          : reading
            ? "DataHub import readback"
            : "DataHub discovery request",
        JSON.stringify(request),
        importing ? { signal } : { signal, timeout: 60000 },
      );
      if (response === undefined)
        throw new Error("etl_request_cancelled_or_unavailable");
      let value: Record<string, unknown>;
      try {
        if (Buffer.byteLength(response, "utf8") > 60000) throw new Error();
        value = JSON.parse(response);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
      } catch {
        throw new Error("invalid_etl_host_response");
      }
      if (value.error) {
        const code =
          typeof value.error === "string" && /^[a-z_]{1,80}$/.test(value.error)
            ? value.error
            : "etl_request_rejected";
        throw new Error(code);
      }
      if (
        value.requestId !== requestId ||
        value.publicationAuthorized !== false ||
        (params.action === "analyze_workspace" &&
          value.format !== "datahub-etl.preview/3") ||
        ((importing || reading) && value.format !== "datahub-etl.import/1")
      )
        throw new Error("invalid_etl_host_response");
      if (importing || reading) value.decisionId = requestId;
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        details: value,
      };
    },
  });
}
