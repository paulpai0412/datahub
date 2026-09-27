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
    if (typeof event.data.body !== "string" || new TextEncoder().encode(event.data.body).length > 60000) {
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
      const development = ["plugin_development_contract", "plugin_development_references", "plugin_development_reference", "plugin_development_verify"].includes(request?.action);
      if (!development && event.data.body.length > 8192) throw new Error("invalid_discovery_request");
      if (
        !request ||
        ![
          "list_sources",
          "analyze",
          "list_workspaces",
          "list_plugins",
          "analyze_workspace",
          "plugin_development_contract",
          "plugin_development_references",
          "plugin_development_reference",
          "plugin_development_verify",
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
