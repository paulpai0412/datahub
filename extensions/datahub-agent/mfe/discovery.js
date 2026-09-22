/** Read-only Discovery intents; Host owns paths, privacy scope and fresh identity. */
export function installDiscoveryBridge({ frame, origin, send }) {
  let pending;
  const listener = async (event) => {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== origin ||
      event.data?.type !== "datahub-discovery"
    )
      return;
    const port = event.ports?.[0];
    if (!port) return;
    const reply = (value) => {
      port.postMessage(JSON.stringify(value));
      port.close();
    };
    if (pending) {
      reply({ error: "discovery_request_busy" });
      return;
    }
    if (typeof event.data.body !== "string" || event.data.body.length > 8192) {
      reply({ error: "invalid_discovery_request" });
      return;
    }
    const abort = new AbortController();
    pending = abort;
    const timer = setTimeout(() => abort.abort(), 45000);
    port.onmessage = (message) => {
      if (message.data?.type === "cancel") abort.abort();
    };
    try {
      const request = JSON.parse(event.data.body);
      if (
        !request ||
        ![
          "list_sources",
          "analyze",
          "list_workspaces",
          "analyze_workspace",
        ].includes(request.action)
      )
        throw new Error("invalid_discovery_request");
      const result = await send(request, abort.signal);
      if (!abort.signal.aborted) reply(result);
    } catch {
      reply({ error: "discovery_request_failed" });
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
