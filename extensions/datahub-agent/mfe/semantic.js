import { semanticReviewPanel } from "./semantic-review.js";

/** Model intents never include verdicts or mutations. Only the trusted parent
 * review panel can call the consent/publication actions. */
export function installSemanticBridge({ container, frame, origin, actorKey, send }) {
  let pending;
  const listener = async (event) => {
    if (event.source !== frame.contentWindow || event.origin !== origin ||
        !["datahub-semantic", "datahub-semantic-review"].includes(event.data?.type)) return;
    const port = event.ports?.[0];
    if (!port) return;
    const reply = (value) => {
      port.postMessage(JSON.stringify(value));
      port.close();
    };
    if (pending) { reply({ error: "semantic_request_busy" }); return; }
    if (typeof event.data.body !== "string" || new TextEncoder().encode(event.data.body).length > 24000) {
      reply({ error: "invalid_semantic_request" }); return;
    }
    const abort = new AbortController();
    pending = abort;
    const reviewing = event.data.type === "datahub-semantic-review";
    const timer = reviewing ? undefined : setTimeout(() => abort.abort(), 45000);
    port.onmessage = (message) => {
      if (message.data?.type === "cancel") abort.abort();
    };
    let recovery;
    try {
      const request = JSON.parse(event.data.body);
      if (reviewing) {
        if (!container || !request || Object.keys(request).some((key) => !["runUrn", "decisionId"].includes(key)) ||
            typeof request.runUrn !== "string" || typeof request.decisionId !== "string") throw new Error("invalid_semantic_request");
        const result = await semanticReviewPanel({ container, reference: request, send, signal: abort.signal });
        if (!abort.signal.aborted) reply(result ?? { error: "semantic_review_unconfirmed" });
        return;
      }
      if (!request || !["list_sources", "inspect_source", "inspect_dataset", "preview", "search_vocabulary", "preview_definition", "inspect_impact", "prepare_review", "read_review"].includes(request.action)) {
        throw new Error("invalid_semantic_request");
      }
      if (request.action === "prepare_review") {
        if (typeof event.data.uiRequestId !== "string" || Object.hasOwn(request, "uiRequestId")) throw new Error("invalid_semantic_request");
        request.uiRequestId = event.data.uiRequestId;
        if (/^[a-f0-9]{48}$/.test(actorKey ?? "") && /^[a-f0-9-]{36}$/.test(request.requestId ?? "")) {
          const id = `semantic-${actorKey}-${request.requestId}`;
          recovery = { runUrn: `urn:li:dataProcessInstance:${id}`, taskUrn: `urn:li:dataJob:(urn:li:dataFlow:(pi,ekop-agent-${actorKey},DEV),${id})`, decisionId: request.requestId, retryAllowed: false };
          // Reuse existing Tasks navigation locators, not a business-state store.
          // These identify the intent even if the whole HTTP response is lost;
          // their presence never means that a Task or Run was created.
          const url = new URL(window.location.href);
          url.searchParams.set("agentTask", recovery.taskUrn); url.searchParams.set("agentRun", recovery.runUrn);
          window.history.replaceState(window.history.state, "", url);
        }
      }
      const result = await send(request, abort.signal);
      if (!abort.signal.aborted) reply(result);
    } catch {
      if (!abort.signal.aborted || recovery) reply(recovery
        ? { error: "semantic_preparation_unconfirmed", reconciliation: recovery }
        : { error: "semantic_request_failed" });
    } finally {
      clearTimeout(timer);
      port.close();
      pending = undefined;
    }
  };
  window.addEventListener("message", listener);
  return () => {
    window.removeEventListener("message", listener);
    pending?.abort();
  };
}
