/** Fixed read-only intent bridge. No credentials or UI-supplied actor enter the runtime. */
export function installCatalogBridge({ frame, origin, send }) {
  const active = new Set();
  const listener = async (event) => {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== origin ||
      event.data?.type !== "datahub-catalog"
    )
      return;
    const port = event.ports?.[0];
    if (!port) return;
    const reply = (value) => port.postMessage(JSON.stringify(value));
    if (
      active.size >= 2 ||
      typeof event.data.body !== "string" ||
      event.data.body.length > 8192
    ) {
      reply({ error: "catalog_request_rejected" });
      port.close();
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    port.onmessage = (e) => {
      if (e.data?.type === "cancel") controller.abort();
    };
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const request = JSON.parse(event.data.body);
      if (
        !request ||
        !["search", "entity", "lineage", "fieldLineage"].includes(
          request.action,
        )
      )
        throw new Error();
      const result = await send(request, controller.signal);
      if (!controller.signal.aborted) reply(result);
    } catch {
      if (!controller.signal.aborted)
        reply({ error: "catalog_request_failed" });
    } finally {
      clearTimeout(timer);
      active.delete(controller);
      port.close();
    }
  };
  window.addEventListener("message", listener);
  return () => {
    window.removeEventListener("message", listener);
    for (const controller of active) controller.abort();
  };
}
