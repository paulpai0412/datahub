import { canCorrectMaintenanceInput } from "../extensions/datahub-agent/pi-web/lib/semantic-input-correction.mjs";

/** For a bounded driver's authenticated response to its recorded request.
 * Pure classification only: does not send/stop/retry anything or grant scope.
 * SDK-local schema refusals never dispatched, so they produce no HTTP reply.
 */
export function maintenanceDriverResponse(request, response, httpOk) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return "STOP";
  if (canCorrectMaintenanceInput(request, response)) return "MODEL_CORRECTION";
  if (!httpOk || response.error) {
    const readCorrection = request.action === "inspect_asset" && response.error === "semantic_asset_type_unsupported" ||
      ["list_assets", "inspect_asset", "search_vocabulary", "inspect_definition", "list_sources"].includes(request.action) &&
      ["invalid_semantic_catalog_request", "invalid_semantic_request"].includes(response.error);
    return readCorrection ? "MODEL_CORRECTION" : "STOP";
  }
  return response.action === request.action && response.requestId === request.requestId &&
    response.publicationAuthorized === false &&
    (!["prepare_maintenance", "revise_maintenance", "recover_maintenance", "seal_maintenance", "continue_maintenance"].includes(request.action) ||
      response.maintenanceRunUrn === request.maintenanceRunUrn) ? "ACK" : "STOP";
}
