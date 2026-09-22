import { installIngestionBridge } from "./ingestion.js";
import { installDiscoveryBridge } from "./discovery.js";
import { installSemanticBridge } from "./semantic.js";
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
  const frame = document.createElement("iframe");
  frame.title = "DataHub Agent";
  frame.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals",
  );
  frame.style.cssText =
    "display:block;width:100%;height:100%;min-height:min(560px,100dvh);border:0;background:transparent";
  const previousHeight = container.style.height;
  container.style.height = "100%";
  container.append(status);
  let grantId;
  let revokeToken;
  let heartbeat;
  let stopIngestion;
  let stopDiscovery;
  let stopSemantic;
  let stopRegistry;
  let stopDecisions;
  let mounted = false;
  let renewing = false;
  function post(path, data, keepalive = false, requestSignal = abort.signal) {
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
            requestSignal,
            AbortSignal.timeout(
              path === "/agent/tasks"
                ? 90000
                : ["/agent/ingestion", "/agent/discovery", "/agent/semantic"].includes(path)
                  ? 45000
                  : 10000,
            ),
          ]),
    });
  }
  function failed() {
    stopIngestion?.();
    stopDiscovery?.();
    stopSemantic?.();
    stopDecisions?.();
    stopRegistry?.();
    clearInterval(heartbeat);
    if (abort.signal.aborted) return;
    frame.remove();
    status.textContent =
      "Agent could not open. Check your DataHub login and retry from the Agent menu.";
    if (mounted) container.append(status);
    mounted = false;
  }

  // The gateway verifies the DataHub session server-side. No actor supplied by JS.
  post("/agent/bootstrap", {})
    .then(async (response) => {
      if (!response.ok) throw new Error("bootstrap_failed");
      const {
        launchUrl,
        grantId: issuedId,
        revokeToken: issuedProof,
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
      if (abort.signal.aborted) return;
      grantId = issuedId;
      revokeToken = issuedProof;
      frame.setAttribute(
        "allow",
        `clipboard-read ${launch.origin}; clipboard-write ${launch.origin}`,
      );
      frame.src = launch.href;
      status.remove();
      container.append(frame);
      stopRegistry = installRegistryView(container, frame);
      const sendTask = async (request, signal) => {
        const response = await post(
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
          const response = await post(
            "/agent/ingestion",
            { grantId, revokeToken, request: JSON.stringify(request) },
            false,
            signal,
          );
          if (!response.ok) throw new Error("ingestion_request_failed");
          return response.json();
        },
      });
      stopDiscovery = installDiscoveryBridge({
        frame,
        origin: launch.origin,
        send: async (request, signal) => {
          const response = await post(
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
          const response = await post(
            "/agent/semantic",
            { grantId, revokeToken, request: JSON.stringify(request) },
            false,
            signal,
          );
          return response.json(); // Host returns bounded error codes, never upstream bodies.
        },
      });
      heartbeat = setInterval(async () => {
        if (renewing) return;
        renewing = true;
        try {
          const response = await post("/agent/heartbeat", {
            grantId,
            revokeToken,
          });
          if (!response.ok) failed();
        } catch {
          failed();
        } finally {
          renewing = false;
        }
      }, 20000);
    })
    .catch(failed);
  return () => {
    stopIngestion?.();
    stopDiscovery?.();
    stopSemantic?.();
    stopDecisions?.();
    stopRegistry?.();
    clearInterval(heartbeat);
    abort.abort();
    if (grantId) {
      void post("/agent/revoke", { grantId, revokeToken }, true).catch(
        () => {},
      );
      grantId = undefined;
      revokeToken = undefined;
    }
    frame.remove();
    status.remove();
    container.style.height = previousHeight;
  };
}

export default mount;
