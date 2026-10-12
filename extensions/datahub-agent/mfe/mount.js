import { installIngestionBridge } from "./ingestion.js";
import { installDiscoveryBridge } from "./discovery.js";
import { installCatalogBridge } from "./catalog.js";
import { installSqlBridge } from "./sql.js";
import { installGrafanaBridge } from "./grafana.js";
import { installSemanticBridge } from "./semantic.js";
import { installSourceSettingsBridge } from "./source-settings.js";
import { installConnectionSettingsBridge } from "./connection-settings.js";
import { installRegistryView } from "./registry.js";
import { installTaskDecisionBridge } from "./task-decision.js";

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    throw new Error("invalid_agent_url");
  }
}

/** Framework-independent DataHub Module Federation entrypoint. */
export function mount(container) {
  const gateway = parseUrl(__webpack_public_path__);
  const abort = new AbortController();
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Opening your isolated Agent workspace…";
  let frame;
  function createFrame() {
    const next = document.createElement("iframe");
    next.title = "DataHub Agent";
    next.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals");
    next.style.cssText = "display:block;width:100%;height:100%;min-height:min(560px,100dvh);border:0;background:transparent";
    return next;
  }
  const previousHeight = container.style.height;
  container.style.height = "100%";
  container.append(status);
  let grantId;
  let revokeToken;
  let heartbeat;
  let stopIngestion;
  let stopDiscovery;
  let stopCatalog;
  let stopSql;
  let stopGrafana;
  let stopSemantic;
  let stopSourceSettings;
  let stopConnectionSettings;
  let stopRegistry;
  let stopDecisions;
  let mounted = false;
  let renewing = false;
  let connecting = false;
  let connectionAbort = new AbortController();
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "重新連線 Agent";
  retry.style.cssText = "min-height:44px;max-width:100%;align-self:flex-start;padding:8px 12px;font:inherit;cursor:pointer";
  retry.onclick = () => openConnection();
  function post(path, data, keepalive = false, requestSignal = abort.signal, connectionSignal = connectionAbort.signal) {
    return fetch(new URL(path, gateway), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      keepalive,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
      signal: keepalive
        ? undefined
        : AbortSignal.any([
            abort.signal,
            connectionSignal,
            requestSignal,
            AbortSignal.timeout(
              path === "/agent/tasks"
                ? 90000
                : path === "/agent/sql"
                  ? 120000
                  : path === "/agent/grafana"
                    ? 105000
                    : path === "/agent/sql-result"
                      ? 30000
                      : [
                            "/agent/ingestion",
                            "/agent/discovery",
                            "/agent/semantic",
                            "/agent/source-settings",
                            "/agent/connection-settings",
                            "/agent/catalog",
                          ].includes(path)
                        ? 45000
                        : 10000,
            ),
          ]),
    });
  }
  function stopConnection() {
    connectionAbort.abort();
    stopGrafana?.();
    stopIngestion?.();
    stopDiscovery?.();
    stopCatalog?.();
    stopSql?.();
    stopSemantic?.();
    stopSourceSettings?.();
    stopConnectionSettings?.();
    stopDecisions?.();
    stopRegistry?.();
    stopGrafana = stopIngestion = stopDiscovery = stopCatalog = stopSql = stopSemantic =
      stopSourceSettings = stopConnectionSettings = stopDecisions = stopRegistry = undefined;
    clearInterval(heartbeat);
    heartbeat = undefined;
    frame?.remove();
    mounted = false;
  }
  function releaseGrant() {
    if (grantId) void post("/agent/revoke", { grantId, revokeToken }, true).catch(() => {});
    grantId = revokeToken = undefined;
  }
  function failed(reconnect = false) {
    stopConnection();
    releaseGrant();
    if (abort.signal.aborted) return;
    status.remove();
    status.textContent = "Agent could not open. Check your DataHub login and retry from the Agent menu.";
    container.append(status);
    // One fresh authenticated bootstrap, not a heartbeat/tool/model replay.
    // A failed bootstrap stops here and leaves an explicit user retry control.
    if (reconnect) openConnection();
    else { retry.disabled = false; container.append(retry); }
  }
  async function renew() {
    if (renewing || connecting || !mounted || abort.signal.aborted) return;
    const attempt = connectionAbort;
    renewing = true;
    try {
      const response = await post("/agent/heartbeat", { grantId, revokeToken }, false, attempt.signal);
      if (attempt !== connectionAbort || attempt.signal.aborted) return;
      if (!response.ok) failed(true);
    } catch {
      if (attempt === connectionAbort && !attempt.signal.aborted) failed(true);
    } finally { renewing = false; }
  }
  const wake = () => { if (document.visibilityState !== "hidden") void renew(); };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);

  // The gateway verifies the DataHub session server-side. No actor supplied by JS.
  function openConnection() {
    if (connecting || abort.signal.aborted) return;
    connecting = true;
    retry.remove();
    retry.disabled = true;
    status.textContent = "正在連線 Agent 工作區…";
    connectionAbort = new AbortController();
    const attempt = connectionAbort;
    // A new WindowProxy fences queued messages from the retired document,
    // even when the new authenticated actor has the same iframe origin.
    frame = createFrame();
    return post("/agent/bootstrap", {}, false, attempt.signal)
    .then(async (response) => {
      if (!response.ok) throw new Error("bootstrap_failed");
      const {
        launchUrl,
        grantId: issuedId,
        revokeToken: issuedProof,
        grafanaOrigin,
      } = await response.json();
      if (
        typeof issuedId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(issuedId) ||
        typeof issuedProof !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(issuedProof)
      )
        throw new Error("invalid_grant");
      const launch = parseUrl(launchUrl);
      const suffix = `.${gateway.hostname}`;
      const key = launch.hostname.endsWith(suffix)
        ? launch.hostname.slice(0, -suffix.length)
        : "";
      if (
        !/^[a-f0-9]{48}$/.test(key) ||
        launch.protocol !== gateway.protocol ||
        launch.port !== gateway.port ||
        launch.username ||
        launch.password ||
        launch.pathname !== "/bootstrap" ||
        launch.search ||
        !launch.hash
      ) {
        throw new Error("invalid_bootstrap_target");
      }
      if (abort.signal.aborted || attempt.signal.aborted) return;
      grantId = issuedId;
      revokeToken = issuedProof;
      // Bridges retain this exact grant and cancellation epoch. A late old
      // callback cannot acquire fresh authority after workspace reconnection.
      const activePost = (path, data, keepalive = false, signal = attempt.signal) =>
        post(path, { ...data, grantId: issuedId, revokeToken: issuedProof }, keepalive, signal, attempt.signal);
      frame.setAttribute(
        "allow",
        `clipboard-read ${launch.origin}; clipboard-write ${launch.origin}`,
      );
      frame.src = launch.href;
      status.remove();
      container.append(frame);
      stopRegistry = installRegistryView(container, frame);
      const sendTask = async (request, signal) => {
        const response = await activePost(
          "/agent/tasks",
          { grantId, revokeToken, request: JSON.stringify(request) },
          false,
          signal,
        );
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error ?? "task_request_failed");
        return result;
      };
      stopDecisions = installTaskDecisionBridge({
        container,
        frame,
        origin: launch.origin,
        send: sendTask,
      });
      mounted = true;
      stopIngestion = installIngestionBridge({
        container,
        frame,
        origin: launch.origin,
        send: async (request, signal) => {
          const response = await activePost(
            "/agent/ingestion",
            { grantId, revokeToken, request: JSON.stringify(request) },
            false,
            signal,
          );
          if (!response.ok) throw new Error("ingestion_request_failed");
          return response.json();
        },
      });
      stopCatalog = installCatalogBridge({
        frame,
        origin: launch.origin,
        send: async (request, signal) => {
          const response = await activePost(
            "/agent/catalog",
            { grantId, revokeToken, request: JSON.stringify(request) },
            false,
            signal,
          );
          return response.json();
        },
      });
      if (grafanaOrigin !== undefined) {
        const approved = parseUrl(grafanaOrigin);
        if (
          approved.hostname !== gateway.hostname ||
          approved.protocol !== gateway.protocol ||
          !approved.port ||
          approved.pathname !== "/" ||
          approved.search ||
          approved.hash ||
          approved.username ||
          approved.password ||
          approved.origin === gateway.origin
        )
          throw new Error("invalid_grafana_origin");
        stopGrafana = installGrafanaBridge({
          container,
          frame,
          origin: launch.origin,
          grafanaOrigin: approved.origin,
          send: async (request, signal) => {
            const response = await activePost(
              "/agent/grafana",
              { grantId, revokeToken, request: JSON.stringify(request) },
              false,
              signal,
            );
            if (!response.ok) throw new Error("grafana_request_denied");
            return response.json();
          },
        });
      }
      stopSql = installSqlBridge({
        frame,
        origin: launch.origin,
        execute: async (request, signal) => {
          const response = await activePost(
            "/agent/sql",
            { grantId, revokeToken, request: JSON.stringify(request) },
            false,
            signal,
          );
          return response.json();
        },
        readResult: async (request, signal) => {
          const response = await activePost(
            "/agent/sql-result",
            { grantId, revokeToken, request: JSON.stringify(request) },
            false,
            signal,
          );
          return response.json();
        },
      });
      stopDiscovery = installDiscoveryBridge({
        frame,
        origin: launch.origin,
        send: async (request, signal) => {
          const response = await activePost(
            "/agent/discovery",
            { grantId, revokeToken, request: JSON.stringify(request) },
            false,
            signal,
          );
          return response.json(); // Gateway errors are already bounded safe codes.
        },
      });
      stopSemantic = installSemanticBridge({
        container,
        actorKey: key,
        frame,
        origin: launch.origin,
        send: async (request, signal) => {
          const response = await activePost(
            "/agent/semantic",
            { grantId, revokeToken, request: JSON.stringify(request) },
            false,
            signal,
          );
          return response.json(); // Host returns bounded error codes, never upstream bodies.
        },
      });
      stopSourceSettings = installSourceSettingsBridge({
        container, frame, origin: launch.origin,
        send: async (request, signal) => {
          const response = await activePost("/agent/source-settings",
            { grantId, revokeToken, request: JSON.stringify(request) }, false, signal);
          return response.json();
        },
      });
      stopConnectionSettings = installConnectionSettingsBridge({
        container, frame, origin: launch.origin,
        send: async (request, signal) => {
          const response = await activePost("/agent/connection-settings",
            { grantId, revokeToken, request: JSON.stringify(request) }, false, signal);
          return response.json();
        },
      });
      heartbeat = setInterval(() => void renew(), 20000);
    })
    .catch(() => failed())
    .finally(() => { connecting = false; });
  }
  void openConnection();
  return () => {
    abort.abort();
    stopConnection();
    releaseGrant();
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("focus", wake);
    window.removeEventListener("online", wake);
    status.remove();
    retry.remove();
    container.style.height = previousHeight;
  };
}

export default mount;
