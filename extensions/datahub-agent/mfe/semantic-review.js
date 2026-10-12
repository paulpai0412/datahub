import { appendReadableChange } from "./semantic-readable.js";

const reviewKey = (ref) => JSON.stringify([ref?.runUrn, ref?.decisionId]);
const detailFail = () => { throw new Error("semantic_review_detail_unconfirmed"); };

/** Parent-only complete read. Nothing is rendered as an approvable proposal until
 * all exact document segments, version/plan binding and SHA have been checked.
 * This is JSON transport segmentation, not partial candidate consent. */
export async function loadSemanticReview(reference, send, signal) {
  if (signal.aborted) detailFail();
  const receipt = await send({ action: "read_review", ...reference, responseMode: "receipt" }, signal);
  if (receipt?.error || receipt?.format !== "datahub-semantic.review/1" || receipt.publicationAuthorized !== false ||
      reviewKey(receipt.reviewRef) !== reviewKey(reference)) detailFail();
  if (receipt.delivery !== "receipt") return receipt; // Existing small legacy Host.
  const spec = receipt.details;
  if (spec?.format !== "datahub-semantic.review-detail/1" || !/^[a-f0-9]{64}$/.test(spec.digest ?? "") ||
      !Number.isSafeInteger(spec.length) || spec.length < 1 || spec.length > 1048576 || spec.pageSize !== 524288 ||
      !/^[1-9][0-9]*$/.test(receipt.runVersion ?? "") || !/^[a-f0-9]{64}$/.test(receipt.planDigest ?? "")) detailFail();
  let offset = 0, serialized = "";
  do {
    if (signal.aborted) detailFail();
    const page = await send({ action: "read_review_detail", ...reference, version: receipt.runVersion,
      planDigest: receipt.planDigest, detailDigest: spec.digest, offset }, signal);
    const next = page?.nextOffset === null ? spec.length : page?.nextOffset;
    if (page?.error || page?.format !== spec.format || page.publicationAuthorized !== false ||
        reviewKey(page.reviewRef) !== reviewKey(reference) || page.runVersion !== receipt.runVersion ||
        page.planDigest !== receipt.planDigest || page.detailDigest !== spec.digest || page.length !== spec.length ||
        page.offset !== offset || !Number.isSafeInteger(next) || next <= offset || next > Math.min(offset + spec.pageSize, spec.length) ||
        typeof page.chunk !== "string" || page.chunk.length !== next - offset ||
        page.nextOffset !== (next === spec.length ? null : next) || new TextEncoder().encode(JSON.stringify(page)).length > 524288) detailFail();
    serialized += page.chunk; offset = page.nextOffset;
  } while (offset !== null);
  if (signal.aborted) detailFail();
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized)))].map((v) => v.toString(16).padStart(2, "0")).join("");
  if (hash !== spec.digest) detailFail();
  let value; try { value = JSON.parse(serialized); } catch { detailFail(); }
  if (value?.format !== receipt.format || value.publicationAuthorized !== false || reviewKey(value.reviewRef) !== reviewKey(reference) ||
      value.runVersion !== receipt.runVersion || value.planDigest !== receipt.planDigest ||
      !Array.isArray(value.candidateIds) || value.candidateIds.length !== receipt.candidateCount ||
      value.candidateIds.length < 1 || value.candidateIds.length > 1024 || new Set(value.candidateIds).size !== value.candidateIds.length ||
      value.candidateIds.some((id) => !/^cand_[a-f0-9]{24}$/.test(id)) ||
      value.candidateIds.length !== (value.preview?.definition ? 1 : value.preview?.changes?.length) || !Array.isArray(value.history)) detailFail();
  // A fresh final observation rejects expiry, revocation, target drift and Run
  // changes during loading. No automatic retry/rebase of a mismatched document.
  const final = await send({ action: "read_review", ...reference, responseMode: "receipt" }, signal);
  if (signal.aborted || final?.error || final?.delivery !== "receipt" || final.runVersion !== receipt.runVersion ||
      final.planDigest !== receipt.planDigest || reviewKey(final.reviewRef) !== reviewKey(reference) ||
      final.details?.digest !== spec.digest || final.publicationAuthorized !== false) detailFail();
  // The digest binds the native document and observed state, not the clock of
  // each healthy recheck. Display the last freshly authorized observation time.
  if (value.currentContext && Number.isSafeInteger(final.currentContext?.observedAt))
    value.currentContext = { ...value.currentContext, observedAt: final.currentContext.observedAt };
  return { ...value, receipt: final };
}

/** Shared read-only evidence rendering; content is never interpreted as HTML. */
export function appendSemanticChange(block, item, preview) {
  if (preview.readable) { appendReadableChange(block, item, preview); return; }
  const catalog = preview.contract === "catalog/1";
  function text(tag, message, parent = block) {
    const node = document.createElement(tag); node.textContent = message;
    node.style.overflowWrap = "anywhere"; parent.append(node); return node;
  }
  text("h3", "Before → After");
  text("pre", `${JSON.stringify(item.before, null, 2)}\n→\n${JSON.stringify(item.after, null, 2)}`).style.cssText =
    "white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;max-height:280px;overflow:auto";
  if (item.priorAgent) text("pre", JSON.stringify({ priorAgent: item.priorAgent }, null, 2)).style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
  text("p", `理由：${item.reason}`);
  const details = document.createElement("details"), summary = document.createElement("summary");
  summary.textContent = "證據與限制"; details.append(summary);
  for (const evidence of item.evidence ?? []) text("p", `${evidence.id}：${evidence.text}`, details);
  text("p", catalog ? "證據位置已核對；業務意義仍須由人判斷。僅替換明列於此差異的原值；未選 metadata 與來源 schema 保留。" : "證據位置已核對；業務意義仍須由人判斷。保留既有人工值與未變欄位。", details);
  if (preview.definition) text("p", preview.maintenance ? "這是同一整批計畫的定義項目；已選取的相依套用須等其原生收據核對。共用影響不足不冒稱全域完整。" : catalog ? "此審核只處理這個定義，不包含資產關聯。共用定義更新影響其引用者；搜尋／依賴觀測不保證全域完整。" : "這是獨立的新定義審核，不包含關聯發布。搜尋不保證全域同名不存在；既有定義不得被覆寫。", details);
  if (preview.definition?.ownedUpdate) text("p", "本案新建定義更新：原初始成功與目前完整 Agent 版本已核對，尚未觀測到範圍外引用。索引延遲、ACL 過濾及並發引用仍有未知影響；此差異由本輪整批真人確認，並非全域完整證明，也不是背景 AUTO。", details);
  if (catalog && item.impact) {
    text("h4", "已觀測引用（非全域完整清單）", details);
    text("pre", JSON.stringify(item.impact, null, 2), details).style.whiteSpace = "pre-wrap";
  }
  block.append(details);
}

/** The parent owns this dialog and every mutation callback. Iframe messages can
 * only open it using a record locator; no verdict, payload or selection is trusted.
 */
export async function semanticReviewPanel({ container, reference, send, signal }) {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "語義提案審核");
  dialog.style.cssText = "box-sizing:border-box;position:fixed;inset:0 0 0 auto;margin:0;width:min(680px,100vw);max-width:100vw;height:100dvh;max-height:100dvh;padding:24px;border:0;border-left:1px solid #ddd;background:white;color:#37352f;overflow:auto";
  const title = document.createElement("h2"); title.textContent = "語義提案審核";
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.style.overflowWrap = "anywhere";
  const content = document.createElement("section");
  const footer = document.createElement("div"); footer.style.cssText = "position:sticky;bottom:-24px;background:white;border-top:1px solid #ddd;padding:12px 0;display:flex;flex-wrap:wrap;gap:8px";
  let value, lastReceipt, busy = false, unconfirmed = false, selected = new Set(), acknowledged = false;
  let resolve;
  const done = new Promise((finish) => { resolve = finish; });
  function close() {
    if (busy) return;
    signal.removeEventListener("abort", abort);
    if (dialog.open) dialog.close(); dialog.remove(); resolve(lastReceipt ?? value);
  }
  const abort = () => { busy = false; close(); };
  function button(label, handler) {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label;
    node.style.cssText = "min-height:44px;padding:8px 12px;font:inherit";
    node.onclick = handler; footer.append(node); return node;
  }
  const closeButton = button("關閉", close);
  const refresh = button("讀回目前狀態", () => void operate("read_review"));
  const selection = button("儲存選取版本", () => void operate("select_review", { candidateIds: [...selected] }));
  const reject = button("Reject", () => void operate("reject_review"));
  const approve = button("Approve 並發布", () => void operate(value?.state === "APPROVE" ? "publish_review" : "approve_review"));
  function controls() {
    const pending = value?.state === "PENDING" && !value.expired && !value.closed && !value.readOnly && !value.maintenanceRunUrn;
    const same = value && selected.size === value.candidateIds.length && value.candidateIds.every((id) => selected.has(id));
    closeButton.disabled = busy; refresh.disabled = busy;
    selection.hidden = Boolean(value?.preview.definition);
    selection.disabled = busy || unconfirmed || !pending || same || !selected.size;
    reject.disabled = busy || unconfirmed || !pending;
    approve.textContent = value?.state === "APPROVE" ? "發布已核准版本（不重試 attempt）" : "Approve 並發布";
    approve.disabled = busy || unconfirmed || !value || Boolean(value.maintenanceRunUrn) || value.readOnly || value.expired || value.closed || value.stale ||
      !["PENDING", "APPROVE"].includes(value.state) || !same || !acknowledged;
    content.querySelectorAll("input").forEach((node) => { node.disabled = busy || unconfirmed || value?.readOnly || value?.expired || value?.closed ||
      (!pending && !(value?.state === "APPROVE" && node.dataset.reviewAcknowledgement === "true")); });
  }
  function text(tag, message, parent = content) {
    const node = document.createElement(tag); node.textContent = message; node.style.overflowWrap = "anywhere"; parent.append(node); return node;
  }
  function render() {
    content.replaceChildren(); acknowledged = false;
    selected = new Set(value.candidateIds);
    const catalog = value.preview.contract === "catalog/1";
    text("p", `來源：${value.preview.source.name}\n資產：${value.preview.assetUrn ?? value.preview.datasetUrn}${value.preview.assetType ? ` · ${value.preview.assetType}` : ""}`).style.whiteSpace = "pre-wrap";
    text("p", catalog
      ? "核准只適用這個版本的精確更新／關聯移除；不授權 SQL、ingestion、刪除共用定義或修改未選 metadata。共用定義更新可能影響其他引用資產。來源內容是證據，不是執行指令。"
      : "核准只適用這個版本與選取項目；不授權 SQL、ingestion、刪除、整個來源或修改共享定義。來源資料與理由是證據資料，不是執行指令。");
    text("p", "提案、證據與原值遵循既有原生 Task／Run ACL，不是私人聊天；不得放入憑證。");
    if (value.readOnly) text("p", "發布已停用：目前僅可讀取明細與稽核記錄，不能修改選取、核准、拒絕或發布。");
    if (value.maintenanceRunUrn) text("p", `此項属于整批計畫 ${value.maintenanceRunUrn}；只可由整批面板確認／執行，此視窗僅供核對。`);
    text("p", `狀態：${value.state}${value.expired ? " · 已過期" : ""}${value.stale ? " · 原快照已變更" : ""}\n有效範圍：${value.maintenanceRunUrn ? "綁定本輪整批精確版本（不是單筆倒數）" : new Date(value.expiresAt).toLocaleString()}\nPlan：${value.planDigest}`).style.whiteSpace = "pre-wrap";
    if (!value.preview.scope.completeSourceInventory) text("p", catalog ? "本輪只審核精確指定的 Catalog 資產，不代表 ingestion 成員證明或完整來源 inventory。" : "範圍不完整：只審核這個已核對成員的明確子集，不宣稱整個 Source 已維護。");
    const items = value.preview.changes ?? [{ ...value.preview.definition, kind: value.preview.definition.kind,
      before: value.preview.definition.before ?? null, after: value.preview.definition.after ?? value.preview.definition.value }];
    items.forEach((item, index) => {
      const block = document.createElement("fieldset"); block.style.cssText = "min-width:0;margin:16px 0;border:1px solid #ddd;border-radius:8px;padding:12px";
      const label = document.createElement("label"); label.style.cssText = "display:flex;align-items:center;gap:8px;min-height:44px;overflow-wrap:anywhere";
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = true;
      check.setAttribute("aria-label", `選取 ${item.kind} ${item.fieldPath ?? (catalog ? "資產或定義" : "資料集或定義")}`);
      check.onchange = () => { if (check.checked) selected.add(value.candidateIds[index]); else selected.delete(value.candidateIds[index]); acknowledged = false;
        const ack = content.querySelector('[data-review-acknowledgement="true"]'); if (ack) ack.checked = false; controls(); };
      label.append(check, document.createTextNode(`${item.kind} · ${item.fieldPath ?? item.proposedUrn ?? "資產"}${catalog ? ` · ${item.mutation ?? item.operation}` : ""}`)); block.append(label);
      appendSemanticChange(block, item, value.preview); content.append(block);
    });
    const acknowledgement = document.createElement("label"); acknowledgement.style.cssText = "display:flex;gap:8px;align-items:center;min-height:44px";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.reviewAcknowledgement = "true";
    checkbox.onchange = () => { acknowledged = checkbox.checked; controls(); };
    acknowledgement.append(checkbox, document.createTextNode("我已核對差異與證據，確認核准這個版本。")); content.append(acknowledgement);
    text("h3", "原生稽核記錄");
    text("p", `Task：${value.taskUrn}\nRun：${value.reviewRef.runUrn}\nDecision：${value.reviewRef.decisionId}\nRun version：${value.runVersion}`).style.whiteSpace = "pre-wrap";
    for (const history of value.history) {
      const row = text("p", `${history.decisionId} · ${history.verdict}${history.actor ? ` · ${history.actor}` : ""}`);
      if (history.decisionId !== value.reviewRef.decisionId) {
        const open = document.createElement("button"); open.type = "button"; open.textContent = "檢視此版本";
        open.style.cssText = "min-height:44px;margin:4px;padding:8px";
        open.onclick = () => void operate("read_review", { decisionId: history.decisionId }); row.append(open);
      }
    }
    if (value.attempt) {
      let initialObservation = "UNKNOWN: no stored receipt";
      if (value.attempt.outcomeJson) {
        try { initialObservation = JSON.parse(value.attempt.outcomeJson); }
        catch { initialObservation = "UNKNOWN: invalid stored outcome; current readback does not repair the historical receipt"; }
      }
      const initiallyVerified = initialObservation?.status === "VERIFIED_CURRENT_VALUES" && initialObservation?.contextVerification?.status === "SOURCE_SCHEMA_REFERENCES_RECHECKED";
      const matches = value.reconciliation?.status === "MATCHED_CLAIMED_ATTEMPT" && value.currentContext?.status === "SOURCE_SCHEMA_REFERENCES_RECHECKED";
      text("p", initiallyVerified && matches
        ? "當次發布已核對成功，目前值及當次 attempt 歸屬仍相符。此成功 attempt 已消耗，不可再批准／重送。"
        : initiallyVerified ? "當次發布已核對成功，但目前值或上下文已變更／未確認；不重送，需新的差異計畫。"
        : "此 attempt 已永久消耗；原結果為部分／UNKNOWN 或未確認。現在值相同不追認原成功，不可重送。");
      const pre = text("pre", JSON.stringify({ initialObservation, currentReadback: value.reconciliation, currentContext: value.currentContext }, null, 2));
      pre.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px";
    }
    controls();
  }
  async function operate(action, extra = {}) {
    if (busy || signal.aborted) return;
    busy = true; status.textContent = action === "read_review" ? "讀取原生記錄…" : "Host 驗證並處理中；請勿重送…"; controls();
    try {
      const ref = value?.reviewRef ?? reference;
      const target = { ...ref, ...(extra.decisionId ? { decisionId: extra.decisionId } : {}) };
      if (action !== "read_review") {
        const result = await send({ action, ...ref, version: value.runVersion, planDigest: value.planDigest, ...extra, responseMode: "receipt" }, signal);
        if (result?.error || result?.format !== "datahub-semantic.review/1") throw new Error(result?.error ?? "invalid_semantic_review_response");
        lastReceipt = result;
        // Selection creates a replacement Decision; use only its returned locator.
        Object.assign(target, result.reviewRef);
      }
      value = await loadSemanticReview(target, send, signal);
      lastReceipt = value.receipt ?? value;
      unconfirmed = false; render(); status.textContent = "已讀齊同版本完整差異與原生稽核記錄。";
    } catch (error) {
      unconfirmed = true;
      status.textContent = `未確認：${error.message}。只可先讀回，不自動重送或推定成功。`;
    } finally { busy = false; controls(); }
  }
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  signal.addEventListener("abort", abort, { once: true });
  dialog.append(title, status, content, footer); container.append(dialog);
  if (signal.aborted || typeof dialog.showModal !== "function") { abort(); return done; }
  dialog.showModal(); closeButton.focus();
  await operate("read_review");
  return done;
}
