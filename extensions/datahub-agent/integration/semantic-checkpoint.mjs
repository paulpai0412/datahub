import { invokePythonBridge } from "./python-bridge.mjs";

const errors = new Set([
  "semantic_checkpoint_invalid", "semantic_checkpoint_format_unsupported",
  "semantic_checkpoint_sdk_unsupported", "semantic_checkpoint_too_large",
  "semantic_checkpoint_decoder_unavailable",
]);

export class CheckpointAdapterError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Host-generated payload only. The model never supplies a checkpoint, script or decoder. */
export async function semanticCheckpoint(payload) {
  if (Buffer.byteLength(JSON.stringify(payload)) > 65536) throw new CheckpointAdapterError("semantic_checkpoint_too_large");
  const { failed, stdout } = await invokePythonBridge("semanticCheckpoint", payload, 60000);
  let result;
  try { result = JSON.parse(stdout); } catch { /* Never project process stderr. */ }
  if (errors.has(result?.error)) throw new CheckpointAdapterError(result.error);
  if (failed || result?.format !== "datahub-semantic.checkpoint/1" || result.sdkVersion !== "1.7.0.9" ||
      result.pipelineName !== payload.pipelineName || typeof result.jobName !== "string" ||
      typeof result.jobUrn !== "string" || !result.jobUrn.startsWith("urn:li:dataJob:")) {
    throw new CheckpointAdapterError("semantic_checkpoint_decoder_unavailable");
  }
  if (payload.mode === "decode" && (typeof result.runId !== "string" || !Array.isArray(result.datasetUrns) ||
      result.datasetUrns.length > 200 || result.datasetUrns.some((u) => typeof u !== "string" || !u.startsWith("urn:li:dataset:") || u.length > 2048) ||
      new Set(result.datasetUrns).size !== result.datasetUrns.length)) throw new CheckpointAdapterError("semantic_checkpoint_invalid");
  return result;
}
