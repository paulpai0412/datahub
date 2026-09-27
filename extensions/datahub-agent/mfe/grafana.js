/** Parent-owned, one-view same-site portal. No credentials, URL or actor accepted
 * from Pi. Display leases do not authorize SQL or Grafana datasource queries. */
export function installGrafanaBridge({
  container,
  frame,
  origin,
  grafanaOrigin,
  send,
}) {
  let portal = null;
  let disposed = false;
  const active = new Set();
  function close(entry = portal, error) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    entry.controller.abort();
    clearTimeout(entry.renew);
    clearTimeout(entry.expiry);
    entry.element?.remove();
    if (error) entry.port.postMessage(JSON.stringify({ error }));
    entry.port.close();
    if (portal === entry) portal = null;
  }
  function place(entry) {
    if (!entry.element) return;
    const r = entry.rect,
      bounds = frame.getBoundingClientRect();
    // Clip to both the trusted Pi frame and the actual browser viewport.
    const left = Math.max(0, bounds.left, bounds.left + r.left);
    const top = Math.max(0, bounds.top, bounds.top + r.top);
    const right = Math.min(
      window.innerWidth,
      bounds.right,
      bounds.left + r.left + r.width,
    );
    const bottom = Math.min(
      window.innerHeight,
      bounds.bottom,
      bounds.top + r.top + r.height,
    );
    Object.assign(entry.element.style, {
      display:
        entry.visible && !document.hidden && right > left && bottom > top
          ? "block"
          : "none",
      left: `${bounds.left + r.left}px`,
      top: `${bounds.top + r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      clipPath: `inset(${Math.max(0, top - bounds.top - r.top)}px ${Math.max(0, bounds.left + r.left + r.width - right)}px ${Math.max(0, bounds.top + r.top + r.height - bottom)}px ${Math.max(0, left - bounds.left - r.left)}px)`,
    });
  }
  function rect(value) {
    return (
      value &&
      ["left", "top", "width", "height"].every(
        (k) => Number.isFinite(value[k]) && Math.abs(value[k]) <= 20000,
      ) &&
      value.width > 0 &&
      value.height > 0
    );
  }
  async function authorize(entry) {
    try {
      const result = await send(
        { action: "grafana_open", ...entry.intent },
        entry.controller.signal,
      );
      if (entry.closed || disposed || portal !== entry) return;
      const url = new URL(result.url);
      const dynamic = result.format === "datahub-grafana.portal/2";
      if (
        !["datahub-grafana.portal/1", "datahub-grafana.portal/2"].includes(
          result.format,
        ) ||
        result.requestId !== entry.intent.requestId ||
        result.displayRef !== entry.intent.displayRef ||
        typeof result.dashboardUid !== "string" ||
        !/^[a-z0-9_-]{1,40}$/.test(result.dashboardUid) ||
        !Number.isSafeInteger(result.orgId) ||
        result.orgId <= 0 ||
        url.origin !== grafanaOrigin ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== `/d/${result.dashboardUid}` ||
        url.searchParams.get("orgId") !== String(result.orgId) ||
        (!dynamic &&
          (!/^20\d{2}-\d{2}-\d{2}$/.test(url.searchParams.get("from") ?? "") ||
            !/^20\d{2}-\d{2}-\d{2}$/.test(url.searchParams.get("to") ?? ""))) ||
        (dynamic && url.searchParams.get("theme") !== "light") ||
        url.searchParams.get("var-display") !== entry.intent.displayRef ||
        [...url.searchParams.keys()].sort().join() !==
          (dynamic
            ? "kiosk,orgId,theme,var-display"
            : "from,kiosk,orgId,to,var-display") ||
        !Number.isSafeInteger(result.expiresAt) ||
        result.expiresAt <= Date.now() ||
        result.expiresAt > Date.now() + 21000 ||
        (entry.approved &&
          (entry.approved.dashboardUid !== result.dashboardUid ||
            entry.approved.orgId !== result.orgId ||
            entry.approved.from !== url.searchParams.get("from") ||
            entry.approved.to !== url.searchParams.get("to")))
      )
        throw new Error("invalid_portal");
      if (!entry.element) {
        entry.approved = {
          dashboardUid: result.dashboardUid,
          orgId: result.orgId,
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
        };
        const iframe = document.createElement("iframe");
        iframe.title = dynamic
          ? "Grafana 動態查詢儀表板"
          : "Grafana 來源聚合（尚未對帳既有面板）";
        iframe.setAttribute(
          "sandbox",
          "allow-scripts allow-same-origin allow-forms",
        );
        iframe.referrerPolicy = "no-referrer";
        iframe.style.cssText = `position:fixed;border:0;background:${dynamic ? "#ffffff" : "#181b1f"};z-index:10;`;
        iframe.src = url.href;
        entry.element = iframe;
        container.append(iframe);
        entry.port.postMessage(JSON.stringify({ status: "mounted" }));
      }
      // Renew authorization, not iframe navigation: no repeated datasource load.
      clearTimeout(entry.expiry);
      entry.expiry = setTimeout(
        () => close(entry, "grafana_display_expired"),
        result.expiresAt - Date.now(),
      );
      entry.renew = setTimeout(
        () => authorize(entry),
        Math.min(12000, result.expiresAt - Date.now()),
      );
      place(entry);
    } catch {
      close(entry, "grafana_display_denied");
    }
  }
  const listener = async (event) => {
    if (
      disposed ||
      event.source !== frame.contentWindow ||
      event.origin !== origin ||
      !["datahub-grafana", "datahub-grafana-portal"].includes(event.data?.type)
    )
      return;
    const port = event.ports?.[0];
    if (!port) return;
    const fail = () => {
      port.postMessage(JSON.stringify({ error: "grafana_invalid_request" }));
      port.close();
    };
    let input;
    try {
      if (typeof event.data.body !== "string" || event.data.body.length > 2048)
        throw new Error();
      input = JSON.parse(event.data.body);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error();
    } catch {
      fail();
      return;
    }
    if (event.data.type === "datahub-grafana") {
      if (
        input.action !== "grafana_authorize" ||
        Object.keys(input).sort().join() !== "action,requestId,resultRef" ||
        !/^[a-f0-9-]{36}$/.test(input.resultRef) ||
        !/^[a-f0-9-]{36}$/.test(input.requestId) ||
        active.size >= 2
      ) {
        fail();
        return;
      }
      const controller = new AbortController();
      active.add(controller);
      port.onmessage = (msg) => {
        if (msg.data?.type === "cancel") controller.abort();
      };
      const timeout = setTimeout(() => controller.abort(), 110000);
      try {
        const result = await send(input, controller.signal);
        if (!controller.signal.aborted && !disposed) {
          if (
            !["datahub-grafana.embed/1", "datahub-grafana.embed/2"].includes(
              result.format,
            ) ||
            "url" in result ||
            result.requestId !== input.requestId
          )
            throw new Error();
          port.postMessage(JSON.stringify(result));
        }
      } catch {
        if (!disposed)
          port.postMessage(JSON.stringify({ error: "grafana_request_denied" }));
      } finally {
        clearTimeout(timeout);
        active.delete(controller);
        port.close();
      }
      return;
    }
    if (
      input.action !== "open" ||
      !rect(input.rect) ||
      typeof input.visible !== "boolean" ||
      Object.keys(input).sort().join() !==
        "action,displayRef,rect,requestId,visible" ||
      !/^[a-f0-9-]{36}$/.test(input.displayRef) ||
      !/^[a-f0-9-]{36}$/.test(input.requestId)
    ) {
      fail();
      return;
    }
    close(portal, "grafana_display_replaced");
    const entry = {
      port,
      rect: input.rect,
      visible: input.visible,
      controller: new AbortController(),
      intent: { displayRef: input.displayRef, requestId: input.requestId },
    };
    portal = entry;
    port.onmessage = (msg) => {
      if (entry.closed) return;
      let update;
      try {
        if (typeof msg.data !== "string" || msg.data.length > 512)
          throw new Error();
        update = JSON.parse(msg.data);
      } catch {
        close(entry, "grafana_invalid_request");
        return;
      }
      if (update?.action === "close") {
        close(entry);
        return;
      }
      if (
        update?.action !== "reposition" ||
        !rect(update.rect) ||
        typeof update.visible !== "boolean"
      ) {
        close(entry, "grafana_invalid_request");
        return;
      }
      entry.rect = update.rect;
      entry.visible = update.visible;
      place(entry);
    };
    await authorize(entry);
  };
  const reposition = () => {
    if (portal) place(portal);
  };
  const unload = () => close(portal, "grafana_workspace_changed");
  window.addEventListener("message", listener);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
  document.addEventListener("visibilitychange", reposition);
  frame.addEventListener("load", unload);
  return () => {
    disposed = true;
    close();
    for (const controller of active) controller.abort();
    window.removeEventListener("message", listener);
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
    document.removeEventListener("visibilitychange", reposition);
    frame.removeEventListener("load", unload);
  };
}
