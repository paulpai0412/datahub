import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Active-branch correlation only. Does not restore authority, resolve effects,
 * look at other sessions, or read arbitrary paths. Host ACL must be rechecked
 * before exposing these locators. Missing fields stay missing.
 */
export function recordedOperations(ctx: ExtensionContext, subject: {
  sourceUrn?: string; assetUrn?: string; fieldPath?: string;
}) {
  if (!subject.sourceUrn || !subject.assetUrn) return [];
  const operations: { referenceId: string; operation: { action: string; maintenanceRunUrn: string; requestId?: string; itemId?: string };
    sessionId: string; sourceUrn: string; assetUrn: string; fieldPath?: string; fieldLocatorRecorded: boolean;
    effect: "NOT_PROVEN"; retryAllowed: false }[] = [];
  for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
    if (entry.type !== "custom" || entry.customType !== "datahub-semantic.intent/1" || !entry.id) continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (!data || data.sessionId !== ctx.sessionManager.getSessionId() || data.sourceUrn !== subject.sourceUrn ||
        data.assetUrn !== subject.assetUrn || (data.fieldPath ?? null) !== (subject.fieldPath ?? null) ||
        data.deferredObservation === true || !["prepare_maintenance", "revise_maintenance", "publish_maintenance_item"].includes(String(data.action))) continue;
    const ref = data.reconciliation as Record<string, unknown> | undefined;
    if (!ref || typeof ref.maintenanceRunUrn !== "string" || ref.maintenanceRunUrn.length > 1024) continue;
    const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
    operations.push({ referenceId: entry.id, sessionId: data.sessionId as string, sourceUrn: subject.sourceUrn,
      assetUrn: subject.assetUrn, ...(typeof data.fieldPath === "string" ? { fieldPath: data.fieldPath } : {}),
      fieldLocatorRecorded: Object.hasOwn(data, "fieldPath"),
      operation: { action: data.action as string, maintenanceRunUrn: ref.maintenanceRunUrn,
        ...(validId(data.requestId) ? { requestId: data.requestId } : {}), ...(validId(ref.itemId) ? { itemId: ref.itemId } : {}) },
      effect: "NOT_PROVEN", retryAllowed: false });
  }
  return operations;
}

/** Original source-wide starts in THIS active branch only. Pair the trusted
 * intent with its unconfirmed receipt; this never resolves the old effects. */
export function recordedUnconfirmedStarts(ctx: ExtensionContext) {
  const intents = new Map<string, { requestId: string; sourceUrn: string }>();
  const unresolved = new Map<string, { requestId: string; sourceUrn: string }>();
  for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
    if (entry.type !== "custom") continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (!data || data.action !== "start_maintenance" || typeof data.requestId !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.requestId)) continue;
    if (entry.customType === "datahub-semantic.intent/1" && data.sessionId === ctx.sessionManager.getSessionId() &&
        typeof data.sourceUrn === "string" && data.sourceUrn.startsWith("urn:li:dataHubIngestionSource:") && data.sourceUrn.length <= 1024)
      intents.set(data.requestId, { requestId: data.requestId, sourceUrn: data.sourceUrn });
    else if (entry.customType === "datahub-semantic.unconfirmed/1" && intents.has(data.requestId))
      unresolved.set(data.requestId, intents.get(data.requestId)!);
  }
  return [...unresolved.values()];
}

export function operationHistoryDigest(operations: ReturnType<typeof recordedOperations>) {
  return createHash("sha256").update(JSON.stringify(operations)).digest("hex");
}
