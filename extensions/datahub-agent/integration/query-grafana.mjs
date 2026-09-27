import { isDeepStrictEqual } from "node:util";
import {
  exactKeys,
  rejectQuery,
  isRecord,
  queryUuid,
} from "./query-metadata.mjs";
import { readQuerySecret } from "./query-source.mjs";
import { createQueryFolderResolver } from "./query-grafana-folder.mjs";

export function validateQueryChart(chart, columns) {
  if (
    !exactKeys(chart, ["title", "type"], ["x", "y"]) ||
    typeof chart.title !== "string" ||
    !chart.title.trim() ||
    chart.title.length > 160 ||
    /[\x00-\x1f<>]/.test(chart.title) ||
    !["table", "bar", "timeseries", "stat"].includes(chart.type)
  )
    rejectQuery("query_chart_invalid");
  const field = (name) => columns.find((c) => c.name === name);
  if (chart.type === "table") {
    if (chart.x !== undefined || chart.y !== undefined)
      rejectQuery("query_chart_invalid");
  } else {
    if (
      !Array.isArray(chart.y) ||
      !chart.y.length ||
      chart.y.length > 16 ||
      new Set(chart.y).size !== chart.y.length ||
      chart.y.some((n) => field(n)?.type !== "number")
    )
      rejectQuery("query_chart_invalid");
    if (
      chart.type === "stat"
        ? chart.x !== undefined
        : typeof chart.x !== "string" ||
          !field(chart.x) ||
          chart.y.includes(chart.x)
    )
      rejectQuery("query_chart_invalid");
    if (chart.type === "timeseries" && field(chart.x)?.type !== "time")
      rejectQuery("query_chart_invalid");
  }
  return chart;
}

export function queryGrafanaConfig(value, datahubOrigin) {
  if (
    !exactKeys(
      value,
      [
        "origin",
        "orgId",
        "folderNamespace",
        "datasourceUid",
        "dataUrl",
        "writerTokenPath",
      ],
      ["subjectLogins"],
    )
  )
    throw new Error("query_grafana_configuration_invalid");
  let origin, frontend, data;
  try {
    origin = new URL(value.origin);
    frontend = new URL(datahubOrigin);
    data = new URL(value.dataUrl);
  } catch {
    throw new Error("query_grafana_configuration_invalid");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.hostname !== frontend.hostname ||
    origin.protocol !== frontend.protocol ||
    origin.origin === frontend.origin ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    !Number.isSafeInteger(value.orgId) ||
    value.orgId < 1 ||
    ["folderNamespace", "datasourceUid"].some(
      (k) => !/^[A-Za-z0-9_-]{1,40}$/.test(value[k]),
    ) ||
    !["http:", "https:"].includes(data.protocol) ||
    data.username ||
    data.password ||
    data.pathname !== "/agent/grafana-data" ||
    data.search ||
    data.hash ||
    typeof value.writerTokenPath !== "string"
  )
    throw new Error("query_grafana_configuration_invalid");
  const subjectLogins = value.subjectLogins ?? {};
  if (
    !isRecord(subjectLogins) ||
    Object.entries(subjectLogins).some(
      ([subject, login]) =>
        !/^urn:li:corpuser:[A-Za-z0-9_.@-]{1,100}$/.test(subject) ||
        typeof login !== "string" ||
        !/^[A-Za-z0-9_.@-]{1,100}$/.test(login),
    ) ||
    new Set(Object.values(subjectLogins)).size !==
      Object.keys(subjectLogins).length
  )
    throw new Error("query_grafana_identity_configuration_invalid");
  return Object.freeze({
    ...value,
    origin: origin.origin,
    subjectLogins: Object.freeze({ ...subjectLogins }),
  });
}

/** Native JSON is built from typed columns, not model-provided dashboard JSON,
 * HTML, datasource URLs or SQL. The table always preserves the complete result. */
export function buildQueryDashboard({
  uid,
  displayRef,
  chart,
  columns,
  config,
  rows = [],
  observedAt,
  truncated = false,
}) {
  if (!/^dq-[a-f0-9]{32}$/.test(uid) || !queryUuid(displayRef))
    rejectQuery("query_chart_invalid");
  validateQueryChart(chart, columns);
  const datasource = {
    type: "yesoreyeram-infinity-datasource",
    uid: config.datasourceUid,
  };
  const target = (fields, exact = false) => ({
    refId: "A",
    datasource,
    type: "json",
    source: "url",
    parser: "backend",
    format: "table",
    url: `${config.dataUrl}?display=${displayRef}`,
    // Infinity's URL query adapter requires this even for the default GET.
    url_options: { method: "GET" },
    columns: fields.map((c) => ({
      selector: c.name,
      text: c.name,
      type: exact
        ? "string"
        : c.type === "time"
          ? "timestamp"
          : c.type === "number"
            ? "number"
            : "string",
    })),
  });
  // Visible on every panel, not only hidden in dashboard settings or SQL preview.
  // Count is UI-only; the model's opaque receipt/embed contract is unchanged.
  const clipped = truncated ? `（已截斷，僅含前 ${rows.length} 筆）` : "";
  const panels = [
    {
      id: 1,
      title: `查詢結果${clipped}`,
      type: "table",
      datasource,
      gridPos: { x: 0, y: chart.type === "table" ? 0 : 10, w: 24, h: 10 },
      targets: [target(columns, true)],
      fieldConfig: { defaults: {}, overrides: [] },
      options: { showHeader: true },
    },
  ];
  if (chart.type !== "table") {
    const chosen = columns.filter(
      (c) => c.name === chart.x || chart.y.includes(c.name),
    );
    // Grafana categorical charts expect the category field before numeric fields.
    chosen.sort((a, b) =>
      a.name === chart.x ? -1 : b.name === chart.x ? 1 : 0,
    );
    panels.unshift({
      id: 2,
      title: `${chart.title}${clipped}`,
      type: chart.type === "bar" ? "barchart" : chart.type,
      datasource,
      gridPos: { x: 0, y: 0, w: 24, h: 10 },
      targets: [target(chosen)],
      fieldConfig: { defaults: {}, overrides: [] },
      options:
        chart.type === "bar"
          ? {
              xField: chart.x,
              orientation: "auto",
              legend: { displayMode: "list", placement: "bottom" },
            }
          : chart.type === "stat"
            ? { reduceOptions: { values: true, calcs: [], fields: "/.*/" } }
            : { legend: { displayMode: "list", placement: "bottom" } },
    });
  }
  let time = { from: "now-1y", to: "now" };
  if (chart.type === "timeseries") {
    const dates = rows
      .map((r) => (r[chart.x] === null ? NaN : Date.parse(r[chart.x])))
      .filter(Number.isFinite);
    if (dates.length)
      time = {
        from: new Date(Math.min(...dates) - 60000).toISOString(),
        to: new Date(Math.max(...dates) + 60000).toISOString(),
      };
  }
  const description = `DataHub query result; observed ${observedAt ?? "unknown"}; ${truncated ? "TRUNCATED at requested row limit" : rows.length ? "returned rows only, not a completeness guarantee" : "EMPTY result"}; refreshing does not execute SQL.`;
  return {
    uid,
    title: chart.title,
    description,
    schemaVersion: 39,
    version: 0,
    editable: false,
    refresh: "",
    tags: ["datahub-query"],
    timezone: "browser",
    time,
    timepicker: { hidden: true },
    templating: { list: [] },
    annotations: { list: [] },
    panels,
  };
}

export function createQueryGrafana({
  config,
  getToken = () => readQuerySecret(config.writerTokenPath, false),
  fetchImpl = fetch,
}) {
  async function call(path, token, options, signal, allowMissing = false) {
    let response;
    try {
      response = await fetchImpl(new URL(path, config.origin), {
        ...options,
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "X-Grafana-Org-Id": String(config.orgId),
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(10000),
          ...(signal ? [signal] : []),
        ]),
      });
      if (allowMissing && response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok || !response.body)
        rejectQuery("query_grafana_unavailable", 502);
      const reader = response.body.getReader(),
        chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 262144) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      rejectQuery("query_grafana_unconfirmed", 502);
    }
  }
  const privateFolder = createQueryFolderResolver(config, call);
  return async (args, context) => {
    context = {
      ...context,
      signal: AbortSignal.any([
        AbortSignal.timeout(90000),
        ...(context.signal ? [context.signal] : []),
      ]),
    };
    const dashboard = buildQueryDashboard({ ...args, config });
    context.assertActive();
    const token = await getToken();
    context.assertActive();
    if (typeof token !== "string" || !token || /[\r\n]/.test(token))
      rejectQuery("query_grafana_unavailable", 503);
    const folderUid = await privateFolder(args.viewerLogin, token, context);
    context.assertActive();
    const result = await call(
      "/api/dashboards/db",
      token,
      {
        method: "POST",
        body: JSON.stringify({
          dashboard,
          folderUid,
          overwrite: false,
          message: "DataHub metadata query",
        }),
      },
      context.signal,
    );
    if (result.uid !== args.uid || result.status !== "success")
      rejectQuery("query_grafana_unconfirmed", 502);
    const readback = await call(
      `/api/dashboards/uid/${args.uid}`,
      token,
      { method: "GET" },
      context.signal,
    );
    if (
      readback.dashboard?.uid !== args.uid ||
      readback.meta?.folderUid !== folderUid ||
      !isRecord(readback.dashboard) ||
      !isDeepStrictEqual(readback.dashboard.panels, dashboard.panels)
    )
      rejectQuery("query_grafana_readback_mismatch", 502);
    context.assertActive();
    return { dashboardUid: args.uid };
  };
}
