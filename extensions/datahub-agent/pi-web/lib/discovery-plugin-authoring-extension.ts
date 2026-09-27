import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCandidate, readCandidate } from "./discovery-plugin-candidates";
import { PLUGIN_DEVELOPMENT_TOOL } from "./tool-presets";

const LIMIT = 60_000;
const HOST_FORMATS: Record<string, string> = {
  contract: "dataflow-discovery.authoring-contract/1",
  references: "dataflow-discovery.authoring-references/1",
  reference: "dataflow-discovery.authoring-reference/1",
  verify: "dataflow-discovery.candidate-verification/1",
};

function stopForHostFailure(ctx: ExtensionContext, requestId: string, code: string): never {
  ctx.ui.notify(`Discovery request ${requestId}: ${code}. Stop and reconcile; do not retry an unknown Host outcome.`, "error");
  ctx.abort();
  throw new Error(code);
}

async function hostRequest(ctx: ExtensionContext, action: string, payload: Record<string, unknown>, signal?: AbortSignal) {
  const requestId = randomUUID();
  const request = JSON.stringify({ ...payload, action: `plugin_development_${action}`, requestId });
  if (Buffer.byteLength(request, "utf8") > LIMIT) throw new Error("development_request_too_large");
  const response = await ctx.ui.input("DataHub discovery request", request, { signal, timeout: 60000 });
  signal?.throwIfAborted();
  if (response === undefined) stopForHostFailure(ctx, requestId, "development_request_cancelled_or_unavailable");
  let value: Record<string, unknown>;
  try {
    if (Buffer.byteLength(response, "utf8") > LIMIT) throw new Error();
    value = JSON.parse(response);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  } catch { stopForHostFailure(ctx, requestId, "invalid_development_host_response"); }
  if (value.error) {
    const code = typeof value.error === "string" && /^[a-z_]{1,80}$/.test(value.error) ? value.error : "development_request_rejected";
    stopForHostFailure(ctx, requestId, code);
  }
  if (value.requestId !== requestId || value.format !== HOST_FORMATS[action] ||
      value.activationAuthorized !== false || value.publicationAuthorized !== false) {
    stopForHostFailure(ctx, requestId, "invalid_development_host_response");
  }
  return value;
}

/** One source-only tool; execution and acceptance are requests to the real Host.
 * root is trusted operator/runtime configuration, never part of the tool schema.
 */
export function registerPluginAuthoring(pi: ExtensionAPI, root = join(getAgentDir(), "discovery-plugin-candidates")) {
  pi.on("resources_discover", () => ({
    skillPaths: [join(dirname(fileURLToPath(import.meta.url)), "../skills/discovery-plugin-dev/SKILL.md")],
  }));
  pi.registerTool({
    name: PLUGIN_DEVELOPMENT_TOOL,
    label: "Discovery plugin development",
    description: "Develop candidate plugin source using the fixed contract and Host-provided reference cases. " +
      "Use the dedicated plugin-dev preset. contract/references/reference read the Host contract or approved input; " +
      "save creates an immutable revision of plugin.py, manifest.json and optional tests.py/README.md; " +
      "read reads only that native session's revision. verify requests credential-free isolated Host validation. " +
      "Never executes code/tests in this model runtime, installs packages, activates plugins or publishes metadata. " +
      "A candidate PASS is not activation authority. Stop on Host/runtime unavailability; never use a shell fallback.",
    parameters: Type.Object({
      action: StringEnum(["contract", "references", "reference", "save", "read", "verify"] as const),
      candidateId: Type.Optional(Type.String({ format: "uuid" })),
      candidateDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      referenceId: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,79}$" })),
      files: Type.Optional(Type.Object({
        "plugin.py": Type.String({ maxLength: 48000 }),
        "manifest.json": Type.String({ maxLength: 24000 }),
        "tests.py": Type.Optional(Type.String({ maxLength: 24000 })),
        "README.md": Type.Optional(Type.String({ maxLength: 24000 })),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (ctx.mode !== "rpc") throw new Error("datahub_host_required");
      const sessionId = ctx.sessionManager.getSessionId();
      const allowed: Record<string, string[]> = {
        contract: ["action"], references: ["action"], reference: ["action", "referenceId"],
        save: ["action", "files"], read: ["action", "candidateId"],
        verify: ["action", "candidateId", "candidateDigest", "referenceId"],
      };
      if (Object.keys(params).some(name => !allowed[params.action].includes(name))) throw new Error("development_parameters_invalid");
      let details: Record<string, unknown>;
      if (params.action === "save") {
        details = { format: "dataflow-discovery.candidate-source/1", ...await saveCandidate(root, sessionId, params.files) };
      } else if (params.action === "read" || params.action === "verify") {
        if (!params.candidateId) throw new Error("candidate_id_required");
        const candidate = await readCandidate(root, sessionId, params.candidateId);
        if (params.action === "read") {
          details = { format: "dataflow-discovery.candidate-source/1", ...candidate };
        } else {
          if (!params.candidateDigest || candidate.candidateDigest !== params.candidateDigest) throw new Error("candidate_revision_drift");
          if (!params.referenceId) throw new Error("reference_id_required");
          details = await hostRequest(ctx, "verify", { sessionId, referenceId: params.referenceId, candidate }, signal);
          if (details.candidateDigest !== candidate.candidateDigest) throw new Error("candidate_receipt_mismatch");
          // Runtime infrastructure errors are not automatic retry instructions.
          if (details.status === "BLOCKED") {
            ctx.ui.notify(`Discovery verification ${details.requestId} BLOCKED; reconcile the Host run before retrying.`, "error");
            ctx.abort();
          }
        }
      } else {
        if (params.action === "reference" && !params.referenceId) throw new Error("reference_id_required");
        details = await hostRequest(ctx, params.action, params.referenceId ? { referenceId: params.referenceId } : {}, signal);
      }
      signal?.throwIfAborted();
      const text = JSON.stringify(details);
      if (Buffer.byteLength(text, "utf8") > LIMIT) throw new Error("development_response_too_large");
      return { content: [{ type: "text", text }], details };
    },
  });
}
