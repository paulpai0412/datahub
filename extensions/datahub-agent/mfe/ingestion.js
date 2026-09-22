function confirmation(container, action, details, signal) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    const title = document.createElement("h2");
    title.id = "datahub-ingestion-confirmation";
    title.textContent = `DataHub ingestion: ${action}`;
    const text = document.createElement("pre");
    text.textContent = JSON.stringify(details, null, 2).replace(
      /[\u202a-\u202e\u2066-\u2069]/g,
      "",
    );
    if (text.textContent.length > 16384 || signal.aborted) {
      resolve(false);
      return;
    }
    text.style.cssText =
      "white-space:pre-wrap;overflow-wrap:anywhere;max-height:55vh;overflow:auto";
    dialog.style.cssText =
      "max-width:min(720px,90vw);border:1px solid #ececec;border-radius:12px;padding:24px;background:white;color:#171717";
    dialog.setAttribute("aria-labelledby", title.id);
    const warning = document.createElement("p");
    warning.textContent =
      "This confirmation is in the DataHub host, outside the Agent workspace. Cancellation cannot roll back metadata already written.";
    const approve = document.createElement("button"),
      reject = document.createElement("button");
    approve.type = reject.type = "button";
    approve.textContent = "Confirm operation";
    reject.textContent = "Do not execute";
    reject.style.cssText = approve.style.cssText = "min-height:44px;padding:8px 16px;margin:4px;border:1px solid #ececec;border-radius:8px;font:inherit;cursor:pointer";
    approve.style.background = "#533FD1";
    approve.style.color = "white";
    const abort = () => finish(false);
    function finish(value) {
      signal.removeEventListener("abort", abort);
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    }
    approve.onclick = () => finish(true);
    reject.onclick = abort;
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      abort();
    });
    signal.addEventListener("abort", abort, { once: true });
    dialog.append(title, warning, text, reject, approve);
    container.append(dialog);
    if (typeof dialog.showModal !== "function") {
      finish(false);
      return;
    }
    dialog.showModal();
    reject.focus();
  });
}

/** Transient UI only; Source, secrets and execution history remain in DataHub. */
export function installIngestionBridge({ container, frame, origin, send }) {
  let pending;
  const listener = async (event) => {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== origin ||
      event.data?.type !== "datahub-ingestion"
    )
      return;
    const port = event.ports?.[0];
    if (!port) return;
    const reply = (value) => {
      port.postMessage(JSON.stringify(value));
      port.close();
    };
    if (pending) {
      reply({ error: "ingestion_request_busy" });
      return;
    }
    if (typeof event.data.body !== "string" || event.data.body.length > 2048) {
      reply({ error: "invalid_ingestion_request" });
      return;
    }
    const abort = new AbortController();
    pending = abort;
    const timer = setTimeout(() => abort.abort(), 110000);
    port.onmessage = (event) => {
      if (event.data?.type === "cancel") abort.abort();
    };
    try {
      const request = JSON.parse(event.data.body);
      if (
        !request ||
        ![
          "list_sources",
          "inspect_source",
          "test_connection",
          "run",
          "get_execution",
          "cancel",
        ].includes(request.action)
      )
        throw new Error("invalid_ingestion_request");
      if (["run", "test_connection", "cancel"].includes(request.action)) {
        const preview = await send(
          {
            ...request,
            action:
              request.action === "cancel" ? "get_execution" : "inspect_source",
          },
          abort.signal,
        );
        if (
          !(await confirmation(
            container,
            request.action,
            { ...preview, sourceUrn: request.sourceUrn },
            abort.signal,
          )) ||
          abort.signal.aborted
        ) {
          reply({ state: "declined", submitted: false });
          return;
        }
        if (request.action !== "cancel")
          request.expectedSourceVersion = preview.sourceVersion;
      }
      if (abort.signal.aborted) throw new Error("request_cancelled");
      reply(await send(request, abort.signal));
    } catch {
      reply({
        state: "unconfirmed",
        error: "ingestion_request_failed",
        note: "Check the proposed execution URN before retrying a write. No raw server errors are returned.",
      });
    } finally {
      clearTimeout(timer);
      pending = undefined;
    }
  };
  window.addEventListener("message", listener);
  return () => {
    window.removeEventListener("message", listener);
    pending?.abort();
  };
}
