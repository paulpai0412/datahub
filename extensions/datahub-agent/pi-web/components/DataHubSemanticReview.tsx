"use client";

import { useEffect, useRef, useState } from "react";
import { isSemanticPreview, type SemanticPreview } from "./DataHubSemanticPreview";

type Review = {
  format: "datahub-semantic.review/1"; publicationAuthorized: false;
  reviewRef: { runUrn: string; decisionId: string };
  taskUrn: string; runVersion: string; planDigest: string; expiresAt: number;
  state: "PENDING" | "APPROVE" | "REJECT" | "ATTEMPTED";
  expired: boolean; closed: boolean; stale: boolean;
  preview: SemanticPreview; candidateIds: string[];
  reconciliation?: { status: string };
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function isSemanticReview(value: unknown): value is Review {
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 48000) return false; } catch { return false; }
  if (!record(value) || value.format !== "datahub-semantic.review/1" || value.publicationAuthorized !== false || !record(value.reviewRef) ||
      typeof value.reviewRef.runUrn !== "string" || !value.reviewRef.runUrn.startsWith("urn:li:dataProcessInstance:") || typeof value.reviewRef.decisionId !== "string" ||
      typeof value.taskUrn !== "string" || !value.taskUrn.startsWith("urn:li:dataJob:") || typeof value.runVersion !== "string" || !/^[1-9][0-9]*$/.test(value.runVersion) ||
      typeof value.planDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.planDigest) || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) ||
      !["PENDING", "APPROVE", "REJECT", "ATTEMPTED"].includes(String(value.state)) ||
      typeof value.expired !== "boolean" || typeof value.closed !== "boolean" || typeof value.stale !== "boolean" || !isSemanticPreview(value.preview) ||
      (value.reconciliation !== undefined && (!record(value.reconciliation) || typeof value.reconciliation.status !== "string")) ||
      !Array.isArray(value.candidateIds) || !value.candidateIds.length || value.candidateIds.length > 8 ||
      value.candidateIds.some((id) => typeof id !== "string" || !/^cand_[a-f0-9]{24}$/.test(id))) return false;
  return value.candidateIds.length === (value.preview.definition ? 1 : value.preview.changes?.length);
}

/** This card opens the parent review surface. It never posts a verdict or an
 * Aspect payload; even stored tool details are only an untrusted record locator.
 */
export function DataHubSemanticReview({ review }: { review: Review }) {
  const [current, setCurrent] = useState(review);
  const [notice, setNotice] = useState("尚未重新向 Host 核對目前狀態。");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false);
  const pending = useRef<(() => void) | undefined>(undefined);
  function request(open: boolean, signal?: AbortSignal, reference = current.reviewRef) {
    if (window.parent === window) { setNotice("請在 DataHub 內開啟此對話；此頁不能自行核准。"); return () => {}; }
    pending.current?.();
    const channel = new MessageChannel(); let closed = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setBusy(true);
    const dispose = () => {
      if (closed) return; closed = true; clearTimeout(timeout); channel.port1.postMessage({ type: "cancel" }); channel.port1.close();
      signal?.removeEventListener("abort", dispose);
    };
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (closed || typeof event.data !== "string" || event.data.length > 48000) return;
      try {
        const value: unknown = JSON.parse(event.data);
        if (!isSemanticReview(value)) throw new Error();
        setCurrent(value); setFresh(true); setNotice("已從可信 Host 讀回；核准仍須在 Host sidepanel 完成。");
      } catch { setFresh(false); setNotice("目前狀態未確認；請讀回，不要重送發布。"); }
      dispose(); setBusy(false);
    };
    pending.current = dispose;
    if (!open) timeout = setTimeout(() => { dispose(); setBusy(false); setFresh(false); setNotice("讀回逾時；沒有自動重送。"); }, 50000);
    signal?.addEventListener("abort", dispose, { once: true });
    window.parent.postMessage({ type: open ? "datahub-semantic-review" : "datahub-semantic", body: JSON.stringify({
      ...(open ? {} : { action: "read_review" }), ...reference,
    }) }, "*", [channel.port2]);
    return dispose;
  }
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => request(false, abort.signal, review.reviewRef), 0);
    return () => { clearTimeout(timer); abort.abort(); pending.current?.(); };
    // A persisted result identifies one audit record; local selection can move
    // current to its replacement without changing the original tool message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review.reviewRef.runUrn, review.reviewRef.decisionId]);
  const mutable = fresh && !current.expired && !current.closed && !current.stale && ["PENDING", "APPROVE"].includes(current.state);
  return <section aria-label="Semantic Steward 審核卡片" style={{ padding: 16, color: "var(--text)", overflowWrap: "anywhere" }}>
    <h3 style={{ margin: "0 0 8px" }}>Semantic Steward · {current.candidateIds.length} 項提案</h3>
    <p>{current.preview.source.name}</p>
    <p>{current.preview.datasetUrn}</p>
    <p>{fresh ? `狀態：${current.state}` : "歷史提案；目前狀態待核對"}{current.expired ? " · 已過期" : ""}{current.stale ? " · 快照已變更" : ""}</p>
    {current.state === "ATTEMPTED" && <p>已有 attempt：{current.reconciliation?.status ?? "尚未確認"}。不得自動重送。</p>}
    <p role="status">{notice}</p>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button type="button" disabled={busy} onClick={() => request(true)} style={{ minHeight: 44, padding: "8px 14px" }}>
        {mutable ? "Review / Approve" : "開啟明細與稽核記錄"}
      </button>
      <button type="button" disabled={busy} onClick={() => request(false)} style={{ minHeight: 44, padding: "8px 14px" }}>讀回狀態</button>
    </div>
    <p style={{ color: "var(--text-muted)", fontSize: 12 }}>卡片不持有批准權限。Host 明細提供逐項 before／after、證據、選取與最終核准。</p>
  </section>;
}
