import { appendSemanticChange, loadSemanticReview } from "./semantic-review.js";

const key = (ref) => JSON.stringify([ref.runUrn, ref.decisionId]);
const fail = (message) => { throw new Error(message); };
const active = (review) => review.state === "PENDING" && !review.attempt &&
  !review.readOnly && !review.expired && !review.closed && !review.stale;
function checkedReview(value, ref, sourceUrn) {
  if (value?.error || value?.format !== "datahub-semantic.review/1" || value.publicationAuthorized !== false ||
      key(value.reviewRef ?? {}) !== key(ref) || value.preview?.source?.urn !== sourceUrn ||
      !/^[1-9][0-9]*$/.test(value.runVersion ?? "") || !/^[a-f0-9]{64}$/.test(value.planDigest ?? "") ||
      !Array.isArray(value.candidateIds) || !value.candidateIds.length) fail("semantic_batch_review_unconfirmed");
  return value;
}

/** Parent-only read: an iframe supplies just the managed Run locator, never the
 * list, versions, selections or verdict. Pages must describe one Run version. */
export async function loadSemanticReviewBatch(reference, send, signal) {
  const refs = new Map(); let cycle, offset = 0;
  do {
    if (signal.aborted) fail("semantic_batch_cancelled");
    const page = await send({ action: "read_managed_cycle", requestId: crypto.randomUUID(), cycleRunUrn: reference.cycleRunUrn, offset }, signal);
    if (page?.error || page?.format !== "datahub-semantic.managed-cycle/1" || page.runUrn !== reference.cycleRunUrn ||
        !/^[1-9][0-9]*$/.test(page.runVersion ?? "") || page.offset !== offset || !Array.isArray(page.publications) ||
        !Array.isArray(page.definitions) || (cycle && (page.runVersion !== cycle.runVersion || page.sourceUrn !== cycle.sourceUrn)))
      fail("semantic_batch_snapshot_changed");
    cycle ??= page;
    for (const row of page.publications.filter((row) => row.status === "NO_ATTEMPT")) {
      const ref = { runUrn: cycle.runUrn, decisionId: row.decisionId }; refs.set(key(ref), ref);
    }
    for (const row of page.definitions.filter((row) => row.status === "PENDING")) {
      const ref = { runUrn: row.runUrn, decisionId: row.decisionId }; refs.set(key(ref), ref);
    }
    const next = page.nextReceiptOffset;
    if (next !== null && (!Number.isSafeInteger(next) || next !== offset + 20 || next > 1000)) fail("semantic_batch_snapshot_changed");
    offset = next;
  } while (offset !== null);
  const reviews = [];
  for (const ref of refs.values()) {
    if (signal.aborted) fail("semantic_batch_cancelled");
    const review = checkedReview(await loadSemanticReview(ref, send, signal), ref, cycle.sourceUrn);
    if (ref.runUrn === cycle.runUrn && review.runVersion !== cycle.runVersion) fail("semantic_batch_snapshot_changed");
    reviews.push(review);
  }
  // Definitions precede their asset associations. Approval of one never approves another.
  reviews.sort((a, b) => Number(Boolean(b.preview.definition)) - Number(Boolean(a.preview.definition)));
  return { cycle, reviews };
}

/** Exactly one dispatch per selected stored review. Run versions are re-read
 * between items (each prior success advances CAS); approved content is NOT rebased. */
export async function approveSemanticReviewBatch(batch, selected, send, signal, progress = () => {}, shouldStop = () => false) {
  const results = [], wanted = new Set(selected);
  const chosen = batch.reviews.filter((review) => wanted.has(key(review.reviewRef)));
  if (!chosen.length || chosen.length !== wanted.size || batch.cycle.closed || chosen.some((review) => !active(review)))
    fail("semantic_batch_selection_invalid");
  for (const original of chosen) {
    const result = { ...original.reviewRef, status: "NOT_ATTEMPTED" }; results.push(result);
    try {
      if (signal.aborted || shouldStop()) fail("semantic_batch_cancelled");
      const current = checkedReview(await loadSemanticReview(original.reviewRef, send, signal), original.reviewRef, batch.cycle.sourceUrn);
      if (!active(current) || current.planDigest !== original.planDigest || current.taskUrn !== original.taskUrn ||
          JSON.stringify(current.candidateIds) !== JSON.stringify(original.candidateIds)) fail("semantic_batch_review_changed");
      if (signal.aborted || shouldStop()) fail("semantic_batch_cancelled");
      result.status = "UNCONFIRMED"; progress([...results]);
      const receipt = await send({ action: "approve_review", ...current.reviewRef,
        version: current.runVersion, planDigest: original.planDigest, responseMode: "receipt" }, signal);
      if (receipt?.error || receipt?.format !== "datahub-semantic.review/1" || receipt.publicationAuthorized !== false ||
          key(receipt.reviewRef) !== key(current.reviewRef) || receipt.planDigest !== current.planDigest ||
          receipt.taskUrn !== current.taskUrn || receipt.preview?.source?.urn !== batch.cycle.sourceUrn ||
          !/^[1-9][0-9]*$/.test(receipt.runVersion ?? "") || receipt.publication?.status !== "VERIFIED_CURRENT_VALUES") fail("semantic_batch_publication_unconfirmed");
      // The trusted Host already persisted the initial outcome and read it back.
      // Detail delivery is not another publication-success condition after ACK.
      const published = receipt;
      let initial = receipt.delivery === "receipt" ? receipt.initialOutcome : undefined;
      if (!initial) try { initial = JSON.parse(published.attempt?.outcomeJson); } catch { /* UNKNOWN remains UNKNOWN. */ }
      if (receipt.publication?.status !== "VERIFIED_CURRENT_VALUES" || initial?.status !== "VERIFIED_CURRENT_VALUES" ||
          published.reconciliation?.status !== "MATCHED_CLAIMED_ATTEMPT" ||
          published.reconciliation.attemptId !== published.attempt?.attemptId ||
          published.currentContext?.status !== "SOURCE_SCHEMA_REFERENCES_RECHECKED") fail("semantic_batch_publication_unconfirmed");
      result.status = "VERIFIED"; progress([...results]);
    } catch (error) {
      result.error = error.message; progress([...results]);
      return { stopped: true, results, remaining: chosen.length - results.length };
    }
  }
  return { stopped: false, results, remaining: 0 };
}

export async function semanticBatchReviewPanel({ container, reference, send, signal }) {
  const dialog = document.createElement("dialog"); dialog.setAttribute("aria-label", "代管批次真人審核");
  dialog.style.cssText = "box-sizing:border-box;position:fixed;inset:0 0 0 auto;margin:0;width:min(760px,100vw);max-width:100vw;height:100dvh;max-height:100dvh;padding:24px;border:0;border-left:1px solid #ddd;background:white;color:#37352f;overflow:auto";
  function text(tag, message, parent = dialog) {
    const node = document.createElement(tag); node.textContent = message; node.style.overflowWrap = "anywhere"; parent.append(node); return node;
  }
  text("h2", "代管批次真人審核");
  text("p", "選取整筆原生提案，核對差異與證據後一次確認、循序發布。不是原子交易：遇衝突、撤權或不明效果立即停止，已成功項目保留；不回滾、不自動重送。新定義與資產關聯各有獨立 Decision，仍分別核准。縮減單筆候選請回到個別審核。");
  const status = text("p", "讀取原生待審提案…"); status.setAttribute("role", "status");
  status.style.cssText = "position:sticky;top:-24px;background:white;padding:12px 0;z-index:1;overflow-wrap:anywhere";
  const content = document.createElement("section"), receipt = document.createElement("section"), footer = document.createElement("footer");
  footer.style.cssText = "position:sticky;bottom:-24px;background:white;padding:12px 0;border-top:1px solid #ddd;display:flex;flex-wrap:wrap;gap:8px";
  dialog.append(content, receipt, footer);
  let batch, busy = false, submitted = false, stopRequested = false, selected = new Set(), acknowledged = false, resolve;
  const done = new Promise((finish) => { resolve = finish; });
  function close() {
    if (busy && !signal.aborted) return;
    signal.removeEventListener("abort", close);
    if (dialog.open) dialog.close(); dialog.remove(); resolve({ format: "datahub-semantic.batch-review/1", publicationAuthorized: false, cycleRunUrn: reference.cycleRunUrn });
  }
  function button(label, handler) {
    const node = text("button", label, footer); node.type = "button"; node.style.cssText = "min-height:44px;padding:8px 12px;font:inherit"; node.onclick = handler; return node;
  }
  const closeButton = button("關閉", close), refresh = button("重新讀取待審清單", () => void load());
  const approve = button("確認選取提案並循序發布", () => void execute());
  const stop = button("停止後續（不回滾目前操作）", () => {
    if (!busy || !submitted) return;
    stopRequested = true; status.textContent = "已要求停止後續；目前送出的操作仍須等候原生結果，不推定已取消或回滾。"; controls();
  });
  function controls() {
    closeButton.disabled = busy; refresh.disabled = busy || submitted;
    stop.disabled = !busy || !submitted || stopRequested;
    approve.disabled = busy || submitted || !batch || batch.cycle.closed || !acknowledged || !selected.size;
    content.querySelectorAll("input").forEach((node) => { node.disabled = busy || submitted || node.dataset.ineligible === "true"; });
  }
  async function load() {
    if (busy || submitted || signal.aborted) return;
    busy = true; batch = undefined; selected.clear(); acknowledged = false; content.replaceChildren(); controls();
    try {
      batch = await loadSemanticReviewBatch(reference, send, signal);
      text("p", `來源：${batch.cycle.sourceUrn} · Run：${batch.cycle.runUrn} · 版本：${batch.cycle.runVersion}`, content);
      text("p", `尚未確認項目：${batch.cycle.pendingCount}；本清單只提供未嘗試提案。UNKNOWN、失效觀測與未確認連結不可在此重送。`, content);
      for (const review of batch.reviews) {
        const block = document.createElement("fieldset"); block.style.cssText = "min-width:0;margin:16px 0;padding:12px;border:1px solid #ddd;border-radius:8px";
        const label = document.createElement("label"); label.style.cssText = "display:flex;align-items:center;gap:8px;min-height:44px;overflow-wrap:anywhere";
        const check = document.createElement("input"); check.type = "checkbox"; check.dataset.ineligible = String(!active(review) || batch.cycle.closed);
        check.onchange = () => { const id = key(review.reviewRef); if (check.checked) selected.add(id); else selected.delete(id);
          acknowledged = false; const ack = content.querySelector('[data-batch-acknowledgement="true"]'); if (ack) ack.checked = false; controls(); };
        label.append(check, document.createTextNode(`選取整筆提案：${review.preview.assetUrn ?? review.preview.datasetUrn} · 審核前 ${review.state}${review.stale ? " · 快照已變更" : ""}${review.expired ? " · 已過期" : ""}`)); block.append(label);
        text("p", `Task：${review.taskUrn}\nRun：${review.reviewRef.runUrn}\nDecision：${review.reviewRef.decisionId}\nPlan：${review.planDigest}`, block).style.whiteSpace = "pre-wrap";
        const items = review.preview.changes ?? [{ ...review.preview.definition, before: review.preview.definition.before ?? null, after: review.preview.definition.after ?? review.preview.definition.value }];
        for (const item of items) { text("h3", `${item.kind} · ${item.fieldPath ?? item.proposedUrn ?? "資產"}`, block); appendSemanticChange(block, item, review.preview); }
        content.append(block);
      }
      const ackLabel = document.createElement("label"), ack = document.createElement("input"); ack.type = "checkbox"; ack.dataset.batchAcknowledgement = "true";
      ackLabel.style.cssText = "display:flex;gap:8px;align-items:center;min-height:44px";
      ack.onchange = () => { acknowledged = ack.checked; controls(); };
      ackLabel.append(ack, document.createTextNode("我已核對所選各提案的完整差異與證據，同意這些精確版本依序發布，並了解可能部分成功。")); content.append(ackLabel);
      status.textContent = `已載入 ${batch.reviews.length} 筆原生提案，預設未選取任何項目。`;
    } catch (error) { batch = undefined; status.textContent = `讀取未確認：${error.message}。沒有發布；可手動重新讀取。`; }
    finally { busy = false; controls(); }
  }
  async function execute() {
    if (busy || submitted || !batch || !acknowledged || !selected.size || signal.aborted) return;
    submitted = true; busy = true; controls(); status.textContent = "循序核對及發布中，請勿重送…";
    function progress(results) {
      receipt.replaceChildren(); text("h3", "本批逐筆結果（原生歷史保留）", receipt);
      for (const result of results) text("p", `${result.runUrn} · ${result.decisionId} · ${result.status}${result.error ? ` · ${result.error}` : ""}`, receipt);
      receipt.scrollIntoView({ block: "start" });
    }
    try {
      const outcome = await approveSemanticReviewBatch(batch, selected, send, signal, progress, () => stopRequested);
      status.textContent = outcome.stopped ? `已停止；未送出共 ${outcome.remaining + outcome.results.filter((item) => item.status === "NOT_ATTEMPTED").length} 筆。已成功項目保留；未確認者只讀對帳，不自動重送。`
        : `選取的 ${outcome.results.length} 筆均已初始成功並讀回；不表示整輪語義維護已完成。`;
    } catch (error) { status.textContent = `已停止：${error.message}。只讀核對原生記錄，不重送。`; }
    finally { busy = false; controls(); }
  }
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  signal.addEventListener("abort", close, { once: true }); container.append(dialog);
  if (signal.aborted || typeof dialog.showModal !== "function") { close(); return done; }
  dialog.showModal(); closeButton.focus(); await load(); return done;
}
