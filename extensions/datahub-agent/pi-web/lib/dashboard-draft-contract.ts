export type DashboardDraft = {
  format: "datahub-dashboard.draft/1";
  requestId: string;
  state: "UNAPPROVED_NOT_EXECUTED";
  datasetUrn: string;
  datasetName: string;
  title: string;
  metric: string;
  dimension: string | null;
  visualization: "stat" | "bar" | "line" | "table";
  queriedAt: string;
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const label = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f\x7f]/.test(value);

/** Display shape only; a draft is NEVER an execution grant or a Grafana dashboard. */
export function isDashboardDraft(value: unknown): value is DashboardDraft {
  if (
    !object(value) ||
    Object.keys(value).sort().join() !==
      "datasetName,datasetUrn,dimension,format,metric,queriedAt,requestId,state,title,visualization"
  )
    return false;
  return (
    value.format === "datahub-dashboard.draft/1" &&
    value.state === "UNAPPROVED_NOT_EXECUTED" &&
    typeof value.requestId === "string" &&
    /^[a-f0-9-]{36}$/.test(value.requestId) &&
    typeof value.datasetUrn === "string" &&
    value.datasetUrn.startsWith("urn:li:dataset:") &&
    value.datasetUrn.length <= 1024 &&
    !/[\x00-\x1f\x7f]/.test(value.datasetUrn) &&
    label(value.datasetName, 200) &&
    label(value.title, 120) &&
    label(value.metric, 120) &&
    (value.dimension === null || label(value.dimension, 120)) &&
    ["stat", "bar", "line", "table"].includes(String(value.visualization)) &&
    typeof value.queriedAt === "string" &&
    /^20\d{2}-\d{2}-\d{2}T[\d:.]+Z$/.test(value.queriedAt)
  );
}
