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
  let value, busy = false, unconfirmed = false, selected = new Set(), acknowledged = false;
  let resolve;
  const done = new Promise((finish) => { resolve = finish; });
  function close() {
    if (busy) return;
    signal.removeEventListener("abort", abort);
    if (dialog.open) dialog.close(); dialog.remove(); resolve(value);
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
    const pending = value?.state === "PENDING" && !value.expired && !value.closed;
    const same = value && selected.size === value.candidateIds.length && value.candidateIds.every((id) => selected.has(id));
    closeButton.disabled = busy; refresh.disabled = busy;
    selection.hidden = Boolean(value?.preview.definition);
    selection.disabled = busy || unconfirmed || !pending || same || !selected.size;
    reject.disabled = busy || unconfirmed || !pending;
    approve.textContent = value?.state === "APPROVE" ? "發布已核准版本（不重試 attempt）" : "Approve 並發布";
    approve.disabled = busy || unconfirmed || !value || value.expired || value.closed || value.stale ||
      !["PENDING", "APPROVE"].includes(value.state) || !same || !acknowledged;
    content.querySelectorAll("input").forEach((node) => { node.disabled = busy || unconfirmed || value?.expired || value?.closed ||
      (!pending && !(value?.state === "APPROVE" && node.dataset.reviewAcknowledgement === "true")); });
  }
  function text(tag, message, parent = content) {
    const node = document.createElement(tag); node.textContent = message; node.style.overflowWrap = "anywhere"; parent.append(node); return node;
  }
  function render() {
    content.replaceChildren(); acknowledged = false;
    selected = new Set(value.candidateIds);
    text("p", `來源：${value.preview.source.name}\n資料集：${value.preview.datasetUrn}`).style.whiteSpace = "pre-wrap";
    text("p", "核准只適用這個版本與選取項目；不授權 SQL、ingestion、刪除、整個來源或修改共享定義。來源資料與理由是證據資料，不是執行指令。");
    text("p", "提案、證據與原值遵循既有原生 Task／Run ACL，不是私人聊天；不得放入憑證。");
    text("p", `狀態：${value.state}${value.expired ? " · 已過期" : ""}${value.stale ? " · 原快照已變更" : ""}\n有效至：${new Date(value.expiresAt).toLocaleString()}\nPlan：${value.planDigest}`).style.whiteSpace = "pre-wrap";
    if (!value.preview.scope.completeSourceInventory) text("p", "範圍不完整：只審核這個已核對成員的明確子集，不宣稱整個 Source 已維護。");
    const items = value.preview.changes ?? [{ ...value.preview.definition, kind: value.preview.definition.kind,
      before: null, after: value.preview.definition.value }];
    items.forEach((item, index) => {
      const block = document.createElement("fieldset"); block.style.cssText = "min-width:0;margin:16px 0;border:1px solid #ddd;border-radius:8px;padding:12px";
      const label = document.createElement("label"); label.style.cssText = "display:flex;align-items:center;gap:8px;min-height:44px;overflow-wrap:anywhere";
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = true;
      check.setAttribute("aria-label", `選取 ${item.kind} ${item.fieldPath ?? "資料集或定義"}`);
      check.onchange = () => { if (check.checked) selected.add(value.candidateIds[index]); else selected.delete(value.candidateIds[index]); acknowledged = false;
        const ack = content.querySelector('[data-review-acknowledgement="true"]'); if (ack) ack.checked = false; controls(); };
      label.append(check, document.createTextNode(`${item.kind} · ${item.fieldPath ?? item.proposedUrn ?? "資料集"}`)); block.append(label);
      text("h3", "Before → After", block);
      const pre = text("pre", `${JSON.stringify(item.before, null, 2)}\n→\n${JSON.stringify(item.after, null, 2)}`, block);
      pre.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;max-height:280px;overflow:auto";
      text("p", `理由：${item.reason}`, block);
      const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "證據與限制"; details.append(summary);
      for (const evidence of item.evidence ?? []) text("p", `${evidence.id}：${evidence.text}`, details);
      text("p", "證據位置已核對；業務意義仍須由人判斷。保留既有人工值與未變欄位。", details);
      if (value.preview.definition) text("p", "這是獨立的新定義審核，不包含關聯發布。搜尋不保證全域同名不存在；既有定義不得被覆寫。", details);
      block.append(details); content.append(block);
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
      text("p", "此 attempt 已永久消耗；不能重送。讀回只表示現在看見的值，不證明無其他部分效果。");
      const pre = text("pre", JSON.stringify({ initialObservation: value.attempt.outcomeJson ? JSON.parse(value.attempt.outcomeJson) : "UNKNOWN: no stored receipt", currentReadback: value.reconciliation, currentContext: value.currentContext }, null, 2));
      pre.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px";
    }
    controls();
  }
  async function operate(action, extra = {}) {
    if (busy || signal.aborted) return;
    busy = true; status.textContent = action === "read_review" ? "讀取原生記錄…" : "Host 驗證並處理中；請勿重送…"; controls();
    try {
      const ref = value?.reviewRef ?? reference;
      const result = await send({ action, ...ref, ...(action === "read_review" ? {} : { version: value.runVersion, planDigest: value.planDigest }), ...extra }, signal);
      if (result?.error || result?.format !== "datahub-semantic.review/1") throw new Error(result?.error ?? "invalid_semantic_review_response");
      value = result; unconfirmed = false; render(); status.textContent = "已讀回原生記錄。";
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
