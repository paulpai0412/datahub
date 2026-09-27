export type QueryReceipt = {
  format: "datahub-query.receipt/1";
  action: "execute_query";
  requestId: string;
  resultRef: string;
  datasetUrns: string[];
  resultExpiresAt: number;
  state: "AVAILABLE" | "EMPTY";
};
const uuid = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
export const queryDatasets = (x: unknown): x is string[] =>
  Array.isArray(x) &&
  x.length > 0 &&
  x.length <= 8 &&
  x.every(
    (u) =>
      typeof u === "string" &&
      /^urn:li:dataset:[^\x00-\x1f\x7f]{1,1000}$/.test(u),
  );
export function isQueryReceipt(value: unknown): value is QueryReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).sort().join() ===
      "action,datasetUrns,format,requestId,resultExpiresAt,resultRef,state" &&
    v.format === "datahub-query.receipt/1" &&
    v.action === "execute_query" &&
    uuid(v.requestId) &&
    uuid(v.resultRef) &&
    queryDatasets(v.datasetUrns) &&
    typeof v.resultExpiresAt === "number" &&
    Number.isSafeInteger(v.resultExpiresAt) &&
    v.resultExpiresAt > 0 &&
    ["AVAILABLE", "EMPTY"].includes(String(v.state))
  );
}
