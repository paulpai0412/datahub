import { semanticReviewPanel } from "./semantic-review.js";
import { semanticBatchReviewPanel } from "./semantic-batch-review.js";
import { semanticMaintenancePanel } from "./semantic-maintenance-review.js";
import { validWorkspaceRect } from "./workspace-portal.js";

/** Model intents never include verdicts or mutations. Only the trusted parent
 * review panel can call the consent/publication actions. */
export function installSemanticBridge({
  container,
  frame,
  origin,
  actorKey,
  send: sendImmediate,
}) {
  let pending;
  const active = new Set();
  // Host's analysis pool admits one operation per actor. Queue first dispatch,
  // not retries, independently of the long-lived mutation/consent lock.
  let dispatchTail = Promise.resolve(), queued = 0;
  function send(request, signal) {
    if (queued >= 32) return Promise.resolve({ error: "semantic_request_busy" });
    queued++;
    const result = dispatchTail.then(() => {
      signal.throwIfAborted();
      return sendImmediate(request, signal);
    });
    dispatchTail = result.then(() => undefined, () => undefined).finally(() => { queued--; });
    return result;
  }
  const listener = async (event) => {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== origin ||
      !["datahub-semantic", "datahub-semantic-review", "datahub-semantic-batch-review", "datahub-semantic-maintenance", "datahub-semantic-maintenance-portal"].includes(
        event.data?.type,
      )
    )
      return;
    const port = event.ports?.[0];
    if (!port) return;
    const reply = (value) => {
      port.postMessage(JSON.stringify(value));
      port.close();
    };
    if (
      typeof event.data.body !== "string" ||
      new TextEncoder().encode(event.data.body).length > 24000
    ) {
      reply({ error: "invalid_semantic_request" });
      return;
    }
    const abort = new AbortController();
    active.add(abort);
    const batching = event.data.type === "datahub-semantic-batch-review";
    const portal = event.data.type === "datahub-semantic-maintenance-portal";
    const maintaining = portal || event.data.type === "datahub-semantic-maintenance";
    const reviewing = maintaining || batching || event.data.type === "datahub-semantic-review";
    let timer;
    port.onmessage = (message) => {
      if (message.data?.type === "cancel") abort.abort();
    };
    let recovery;
    try {
      const request = JSON.parse(event.data.body);
      const continuing = request?.action === "continue_maintenance";
      const maintenanceWrite = ["start_maintenance", "prepare_maintenance", "revise_maintenance", "recover_maintenance", "seal_maintenance"].includes(request?.action);
      const writing = maintenanceWrite || ["link_managed_definition", "prepare_review", "prepare_managed",
        "start_managed_cycle", "record_managed_exception", "finish_managed_cycle"].includes(request?.action);
      // Card refreshes must not own the mutation/consent lock. Reads still go
      // through Host ACL and version/digest checks; there is no retry queue.
      if (pending && (reviewing || writing || continuing)) {
        reply({ error: "semantic_request_busy" });
        return;
      }
      if (reviewing || writing || continuing) pending = abort;
      if (!reviewing)
        timer = setTimeout(
          () => abort.abort(),
          [
            "link_managed_definition",
            "prepare_managed",
            "start_managed_cycle",
            "read_managed_cycle",
            "record_managed_exception",
            "finish_managed_cycle",
            "reconcile_maintenance_start",
            "start_maintenance", "prepare_maintenance", "revise_maintenance", "recover_maintenance", "seal_maintenance", "read_maintenance", "continue_maintenance",
          ].includes(request.action)
            ? 150000
            : 45000,
        );
      if (maintaining) {
        if (!container || !request || Array.isArray(request) ||
            Object.keys(request).sort().join() !== (portal ? "maintenanceRunUrn,rect,visible" : "maintenanceRunUrn") ||
            typeof request.maintenanceRunUrn !== "string" || !request.maintenanceRunUrn.startsWith("urn:li:dataProcessInstance:") ||
            request.maintenanceRunUrn.length > 1024 || (portal && (!validWorkspaceRect(request.rect) || typeof request.visible !== "boolean")))
          throw new Error("invalid_semantic_request");
        const slot = portal ? { frame, rect: request.rect, visible: request.visible } : null;
        if (slot) port.onmessage = (message) => {
          if (message.data?.type === "cancel") { abort.abort(); return; }
          let update;
          try {
            if (typeof message.data !== "string" || message.data.length > 512) throw new Error();
            update = JSON.parse(message.data);
            if (Object.keys(update).sort().join() !== "action,rect,visible" || update.action !== "reposition" ||
              !validWorkspaceRect(update.rect) || typeof update.visible !== "boolean") throw new Error();
          } catch { abort.abort(); return; }
          slot.rect = update.rect; slot.visible = update.visible; slot.place?.();
        };
        const result = await semanticMaintenancePanel({ container,
          reference: { maintenanceRunUrn: request.maintenanceRunUrn }, send, signal: abort.signal, slot,
          onMounted: () => { if (slot) port.postMessage(JSON.stringify({ status: "mounted" })); } });
        if (!abort.signal.aborted) reply(result ?? { error: "semantic_maintenance_unconfirmed" });
        return;
      }
      if (batching) {
        if (!container || !request || Object.keys(request).length !== 1 ||
            typeof request.cycleRunUrn !== "string" || !request.cycleRunUrn.startsWith("urn:li:dataProcessInstance:") ||
            request.cycleRunUrn.length > 1024) throw new Error("invalid_semantic_request");
        const result = await semanticBatchReviewPanel({ container, reference: request, send, signal: abort.signal });
        if (!abort.signal.aborted) reply(result);
        return;
      }
      if (reviewing) {
        if (
          !container ||
          !request ||
          Object.keys(request).some(
            (key) => !["runUrn", "decisionId"].includes(key),
          ) ||
          typeof request.runUrn !== "string" ||
          typeof request.decisionId !== "string"
        )
          throw new Error("invalid_semantic_request");
        const result = await semanticReviewPanel({
          container,
          reference: request,
          send,
          signal: abort.signal,
        });
        if (!abort.signal.aborted)
          reply(result ?? { error: "semantic_review_unconfirmed" });
        return;
      }
      if (
        !request ||
        ![
          "list_sources",
          "inspect_source",
          "inspect_dataset",
          "list_assets",
          "inspect_managed_scope",
          "inspect_managed_maintenance",
          "inspect_asset",
          "inspect_definition",
          "preview",
          "search_vocabulary",
          "preview_definition",
          "inspect_impact",
          "link_managed_definition",
          "start_managed_cycle",
          "read_managed_cycle",
          "record_managed_exception",
          "finish_managed_cycle",
          "prepare_review",
          "prepare_managed",
          "read_review",
          "read_review_detail",
          "reconcile_maintenance_start",
          "start_maintenance", "prepare_maintenance", "revise_maintenance", "recover_maintenance", "seal_maintenance", "read_maintenance", "continue_maintenance",
        ].includes(request.action)
      ) {
        throw new Error("invalid_semantic_request");
      }
      if (writing || continuing) {
        if (
          typeof event.data.uiRequestId !== "string" ||
          Object.hasOwn(request, "uiRequestId")
        )
          throw new Error("invalid_semantic_request");
        request.uiRequestId = event.data.uiRequestId;
      }
      if (writing) {
        if (
          /^[a-f0-9]{48}$/.test(actorKey ?? "") &&
          /^[a-f0-9-]{36}$/.test(request.requestId ?? "")
        ) {
          if (maintenanceWrite) {
            const root = request.action === "start_maintenance"
              ? `urn:li:dataProcessInstance:semantic-${actorKey}-${request.requestId}` : request.maintenanceRunUrn;
            if (typeof root !== "string" || !new RegExp(`^urn:li:dataProcessInstance:semantic-${actorKey}-[a-f0-9-]{36}$`).test(root))
              throw new Error("invalid_semantic_request");
            recovery = { maintenanceRunUrn: root,
              runUrn: request.action === "prepare_maintenance" || request.action === "recover_maintenance"
                ? `urn:li:dataProcessInstance:semantic-${actorKey}-${request.action === "recover_maintenance" ? request.itemId : request.requestId}` : root,
              ...(request.action === "recover_maintenance" ? { itemId: request.itemId } : {}),
              requestId: request.requestId, retryAllowed: false };
            const url = new URL(window.location.href); url.searchParams.set("agentRun", root);
            window.history.replaceState(window.history.state, "", url);
          } else {
          const id =
            request.action === "prepare_review"
              ? `semantic-${actorKey}-${request.requestId}`
              : request.cycleRunUrn?.slice(
                  "urn:li:dataProcessInstance:".length,
                );
          if (
            typeof id !== "string" ||
            !new RegExp(`^semantic-${actorKey}-[a-f0-9-]{36}$`).test(id) ||
            (request.action !== "prepare_review" &&
              request.cycleRunUrn !== `urn:li:dataProcessInstance:${id}`)
          )
            throw new Error("invalid_semantic_request");
          const taskUrn = request.action === "prepare_review" ||
            (request.action === "start_managed_cycle" && !request.previousCycleRunUrn && !request.cycleTaskUrn)
            ? `urn:li:dataJob:(urn:li:dataFlow:(pi,ekop-agent-${actorKey},DEV),${id})`
            : request.cycleTaskUrn;
          const taskPrefix = `urn:li:dataJob:(urn:li:dataFlow:(pi,ekop-agent-${actorKey},DEV),semantic-${actorKey}-`;
          if (taskUrn !== undefined && (typeof taskUrn !== "string" || !taskUrn.startsWith(taskPrefix) ||
            !taskUrn.endsWith(")") || !/^[a-f0-9-]{36}$/.test(taskUrn.slice(taskPrefix.length, -1))))
            throw new Error("invalid_semantic_request");
          recovery = {
            runUrn: `urn:li:dataProcessInstance:${id}`,
            ...(taskUrn ? { taskUrn } : {}),
            ...(["start_managed_cycle", "finish_managed_cycle"].includes(
              request.action,
            )
              ? {}
              : { decisionId: request.requestId }),
            retryAllowed: false,
          };
          // Reuse existing Tasks navigation locators, not a business-state store.
          // These identify the intent even if the whole HTTP response is lost;
          // their presence never means that a Task or Run was created.
          const url = new URL(window.location.href);
          if (recovery.taskUrn) url.searchParams.set("agentTask", recovery.taskUrn);
          else url.searchParams.delete("agentTask");
          url.searchParams.set("agentRun", recovery.runUrn);
          window.history.replaceState(window.history.state, "", url);
          }
        }
      }
      const result = await send(request, abort.signal);
      if (!abort.signal.aborted) reply(result);
    } catch {
      if (!abort.signal.aborted || recovery)
        reply(
          recovery
            ? {
                error: "semantic_preparation_unconfirmed",
                reconciliation: recovery,
              }
            : { error: "semantic_request_failed" },
        );
    } finally {
      clearTimeout(timer);
      port.close();
      active.delete(abort);
      if (pending === abort) pending = undefined;
    }
  };
  window.addEventListener("message", listener);
  return () => {
    window.removeEventListener("message", listener);
    for (const abort of active) abort.abort();
  };
}
