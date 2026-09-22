import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

/** A native blocking UI request, not an approval authority or a new executor. */
export default function datahubDecision(pi: ExtensionAPI) {
  pi.registerTool({
    name: "datahub_decision",
    label: "DataHub Task decision",
    description:
      "Ask the human running the DataHub Task for input, then wait. Use the exact runUrn supplied by the Host. The Host persists the question and human response. A response grants no SQL, Join, metadata-write or credential access. Dismissal ends the Task rather than continuing it.",
    parameters: Type.Object(
      {
        runUrn: Type.String({ maxLength: 1024 }),
        question: Type.String({ minLength: 1, maxLength: 2048 }),
        choices: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
          maxItems: 8,
        }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const requestId = randomUUID();
      const result = (value: Record<string, unknown>) => {
        const details = { ...value, runUrn: params.runUrn, requestId };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details) }],
          details,
        };
      };
      if (ctx.mode !== "rpc") return result({ error: "datahub_host_required" });
      const response = await ctx.ui.input(
        "DataHub task decision",
        JSON.stringify({ requestId, ...params }),
        { signal },
      );
      if (response === undefined)
        return result({
          state: "unconfirmed",
          note: "Read the Task record; do not infer a human response or resume it automatically.",
        });
      try {
        const value = JSON.parse(response);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("invalid_response");
        return result(value);
      } catch {
        return result({ state: "unconfirmed", error: "invalid_host_response" });
      }
    },
  });
}
