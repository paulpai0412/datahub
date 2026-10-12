import { createHash } from "node:crypto";

/** Called only on an authenticated Host reply for this exact dispatched body.
 * A bare 400/error name, missing reconciliation, or model text is not evidence.
 * This permits a NEW model intent, never replay/recovery of this or older writes.
 */
export function canCorrectMaintenanceInput(request, response) {
  if (!request || !response || !["prepare_maintenance", "revise_maintenance"].includes(request.action) ||
      response.error !== "invalid_semantic_maintenance_request" || response.reconciliation !== undefined) return false;
  const proof = response.inputRejection;
  return Boolean(proof && typeof proof === "object" && !Array.isArray(proof) &&
    proof.format === "datahub-semantic.input-rejection/1" && proof.phase === "INPUT_VALIDATION" &&
    proof.nativeWriteStarted === false && proof.correction === "NEW_INTENT_ONLY" &&
    proof.action === request.action && proof.requestId === request.requestId &&
    typeof request.maintenanceRunUrn === "string" && proof.maintenanceRunUrn === request.maintenanceRunUrn &&
    // Parent-only UI correlation is added AFTER the SDK body. Host excludes
    // exactly that field too; all semantic fields/order remain request-bound.
    proof.requestDigest === createHash("sha256").update(JSON.stringify(
      Object.fromEntries(Object.entries(request).filter(([key]) => key !== "uiRequestId")),
    )).digest("hex"));
}
