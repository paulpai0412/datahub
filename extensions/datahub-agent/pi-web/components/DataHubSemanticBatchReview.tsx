"use client";

import { useEffect, useRef, useState } from "react";
import { useContext } from "react";
import { CatalogContext } from "../lib/catalog-context";

/** The iframe can only open the trusted parent's fresh review list. Selection,
 * displayed revisions and every approval stay in the parent, never in a tool. */
export function DataHubSemanticBatchReview({ cycleRunUrn }: { cycleRunUrn: string }) {
  const catalogControl = useContext(CatalogContext);
  const dispose = useRef<(() => void) | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => () => dispose.current?.(), [cycleRunUrn]);
  function open() {
    if (busy) return;
    if (window.parent === window) { setNotice("請從 DataHub 開啟；此頁不能自行核准。"); return; }
    catalogControl?.(null, false);
    const channel = new MessageChannel(); let closed = false;
    const cleanup = () => { if (closed) return; closed = true; channel.port1.postMessage({ type: "cancel" }); channel.port1.close(); };
    dispose.current = cleanup; setBusy(true);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      let confirmed = false;
      try {
        if (typeof event.data === "string" && new TextEncoder().encode(event.data).length <= 524288) {
          const value = JSON.parse(event.data);
          confirmed = value?.format === "datahub-semantic.batch-review/1" && value.publicationAuthorized === false && value.cycleRunUrn === cycleRunUrn;
        }
      } catch { /* Untrusted replies never imply success. */ }
      cleanup(); setBusy(false);
      setNotice(confirmed ? "Host 審核視窗已關閉。此歷史快照未更新；請讀回輪次原生記錄，不推定整批完成。" : "審核結果未確認；只讀核對原生記錄，不重送發布。");
    };
    window.parent.postMessage({ type: "datahub-semantic-batch-review", body: JSON.stringify({ cycleRunUrn }) }, "*", [channel.port2]);
  }
  return <div>
    <button type="button" onClick={open} disabled={busy} style={{ minHeight: 44, padding: "8px 12px" }}>在 Host 開啟批次審核</button>
    <p role="status">{busy ? "請在 DataHub Host 視窗核對提案；此按鈕不批准任何內容。" : notice}</p>
  </div>;
}
