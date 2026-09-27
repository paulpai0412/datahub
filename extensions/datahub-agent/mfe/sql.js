/** Two read-only channels: model intent gets an opaque receipt; cards alone read
 * ephemeral numbers after another parent-side actor and source-scope check. */
export function installSqlBridge({ frame, origin, execute, readResult }) {
  const active = new Set();
  const listener = async (event) => {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== origin ||
      !["datahub-sql", "datahub-sql-card"].includes(event.data?.type)
    )
      return;
    const port = event.ports?.[0];
    if (!port) return;
    const card = event.data.type === "datahub-sql-card";
    const reply = (result) => port.postMessage(JSON.stringify(result));
    if (
      active.size >= 2 ||
      typeof event.data.body !== "string" ||
      event.data.body.length > 32768
    ) {
      reply({ error: "sql_request_rejected" });
      port.close();
      return;
    }
    let input;
    try {
      input = JSON.parse(event.data.body);
      if (
        !input ||
        !(card
          ? input.action === "read_result"
          : ["execute", "execute_query"].includes(input.action))
      )
        throw new Error();
    } catch {
      reply({ error: "sql_request_rejected" });
      port.close();
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    port.onmessage = (message) => {
      if (message.data?.type === "cancel") controller.abort();
    };
    const timer = setTimeout(() => controller.abort(), card ? 25000 : 115000);
    try {
      const result = await (card
        ? readResult(input, controller.signal)
        : execute(input, controller.signal));
      if (!controller.signal.aborted) {
        if (
          result?.error &&
          /^(?:query|sql)_[a-z_]{1,60}$/.test(result.error)
        ) {
          reply({ error: result.error });
          return;
        }
        if (
          ![
            card ? "datahub-sql.card/1" : "datahub-sql.receipt/1",
            card ? "datahub-sql.source-card/1" : "datahub-sql.source-receipt/1",
            card ? "datahub-query.result/1" : "datahub-query.receipt/1",
          ].includes(result?.format) ||
          (!card &&
            ["points", "rows", "sql", "parameters", "salesAmount"].some(
              (k) => k in result,
            )) ||
          (!card &&
            result.format === "datahub-query.receipt/1" &&
            Object.keys(result).sort().join() !==
              "action,datasetUrns,format,requestId,resultExpiresAt,resultRef,state")
        )
          throw new Error();
        const encoded = JSON.stringify(result);
        if (encoded.length > (card ? 1048576 : 32768)) throw new Error();
        port.postMessage(encoded);
      }
    } catch {
      if (!controller.signal.aborted) reply({ error: "sql_request_failed" });
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
