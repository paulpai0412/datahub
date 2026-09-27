export type SqlReceipt = {
  format: "datahub-sql.receipt/1" | "datahub-sql.source-receipt/1";
  action: "execute";
  requestId: string;
  resultRef: string;
  metric: "sales_by_category";
  datasetUrn: string;
  chartUrn: string;
  dashboardUrn: string;
  panelId: 5;
  resultExpiresAt: number;
};
export type SqlCard = {
  format: "datahub-sql.card/1" | "datahub-sql.source-card/1";
  resultRef: string;
  metric: "sales_by_category";
  datasetUrn: string;
  chartUrn: string;
  dashboardUrn: string;
  panelId: 5;
  from: string;
  through: string;
  observedAt: string;
  dataAsOf: string | null;
  points: { month: string; category: string; salesAmount: string }[];
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const ref = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const asset = (value: unknown, type: string): value is string =>
  typeof value === "string" &&
  value.startsWith(`urn:li:${type}:`) &&
  value.length <= 1024 &&
  !/[\x00-\x1f\x7f]/.test(value);
const iso = (value: unknown): value is string =>
  typeof value === "string" && /^20\d{2}-\d{2}-\d{2}T[\d:.]+Z$/.test(value);
const date = (value: unknown): value is string =>
  typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value);

export function isSqlReceipt(value: unknown): value is SqlReceipt {
  return (
    object(value) &&
    (value.format === "datahub-sql.receipt/1" ||
      value.format === "datahub-sql.source-receipt/1") &&
    value.action === "execute" &&
    ref(value.requestId) &&
    ref(value.resultRef) &&
    value.metric === "sales_by_category" &&
    asset(value.datasetUrn, "dataset") &&
    asset(value.chartUrn, "chart") &&
    asset(value.dashboardUrn, "dashboard") &&
    value.panelId === 5 &&
    typeof value.resultExpiresAt === "number" &&
    Number.isSafeInteger(value.resultExpiresAt)
  );
}

export function isSqlCard(value: unknown): value is SqlCard {
  return (
    object(value) &&
    (value.format === "datahub-sql.card/1" ||
      value.format === "datahub-sql.source-card/1") &&
    ref(value.resultRef) &&
    value.metric === "sales_by_category" &&
    asset(value.datasetUrn, "dataset") &&
    asset(value.chartUrn, "chart") &&
    asset(value.dashboardUrn, "dashboard") &&
    value.panelId === 5 &&
    date(value.from) &&
    date(value.through) &&
    iso(value.observedAt) &&
    (value.dataAsOf === null || iso(value.dataAsOf)) &&
    Array.isArray(value.points) &&
    value.points.length > 0 &&
    value.points.length <= 200 &&
    value.points.every(
      (point) =>
        object(point) &&
        date(point.month) &&
        typeof point.category === "string" &&
        point.category.length > 0 &&
        point.category.length <= 80 &&
        typeof point.salesAmount === "string" &&
        /^(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/.test(point.salesAmount),
    )
  );
}
