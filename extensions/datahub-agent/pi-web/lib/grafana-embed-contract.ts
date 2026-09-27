import { queryDatasets } from "./query-contract";

export type QueryGrafanaEmbed = {
  format: "datahub-grafana.embed/2";
  requestId: string;
  displayRef: string;
  dashboardUid: string;
  orgId: number;
  title: string;
  datasetUrns: string[];
  resultExpiresAt: number;
  status: "QUERY_RESULT" | "EMPTY";
};
export type GrafanaEmbed = QueryGrafanaEmbed | LegacyGrafanaEmbed;
export type LegacyGrafanaEmbed = {
  format: "datahub-grafana.embed/1";
  requestId: string;
  displayRef: string;
  dashboardUid: string;
  orgId: number;
  title: string;
  datasetUrn: string;
  from: string;
  to: string;
  resultExpiresAt: number;
  status: "SOURCE_ONLY_NOT_RECONCILED";
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
/** Historical metadata only; opening always rechecks the current actor.
 * This receipt cannot supply a Grafana URL, SQL or numeric business values. */
export function isGrafanaEmbed(value: unknown): value is GrafanaEmbed {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.format === "datahub-grafana.embed/2")
    return (
      Object.keys(v).sort().join() ===
        "dashboardUid,datasetUrns,displayRef,format,orgId,requestId,resultExpiresAt,status,title" &&
      uuid(v.requestId) &&
      uuid(v.displayRef) &&
      typeof v.dashboardUid === "string" &&
      /^dq-[a-f0-9]{32}$/.test(v.dashboardUid) &&
      typeof v.orgId === "number" &&
      Number.isSafeInteger(v.orgId) &&
      v.orgId > 0 &&
      typeof v.title === "string" &&
      !!v.title.trim() &&
      v.title.length <= 160 &&
      !/[\x00-\x1f<>]/.test(v.title) &&
      queryDatasets(v.datasetUrns) &&
      typeof v.resultExpiresAt === "number" &&
      Number.isSafeInteger(v.resultExpiresAt) &&
      v.resultExpiresAt > 0 &&
      (v.status === "QUERY_RESULT" || v.status === "EMPTY")
    );
  return (
    Object.keys(v).sort().join() ===
      "dashboardUid,datasetUrn,displayRef,format,from,orgId,requestId,resultExpiresAt,status,title,to" &&
    v.format === "datahub-grafana.embed/1" &&
    uuid(v.requestId) &&
    uuid(v.displayRef) &&
    typeof v.dashboardUid === "string" &&
    /^[a-z0-9_-]{1,40}$/.test(v.dashboardUid) &&
    Number.isSafeInteger(v.orgId) &&
    (v.orgId as number) > 0 &&
    typeof v.datasetUrn === "string" &&
    /^urn:li:dataset:[^\x00-\x1f]{1,1000}$/.test(v.datasetUrn) &&
    typeof v.title === "string" &&
    !!v.title.trim() &&
    v.title.length <= 200 &&
    !/[\x00-\x1f]/.test(v.title) &&
    date(v.from) &&
    date(v.to) &&
    v.from <= v.to &&
    Number.isSafeInteger(v.resultExpiresAt) &&
    (v.resultExpiresAt as number) > 0 &&
    v.status === "SOURCE_ONLY_NOT_RECONCILED"
  );
}
