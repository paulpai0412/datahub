function confirmSettings(container, plan, signal) {
  return new Promise((resolve) => {
    const opener = document.activeElement, dialog = document.createElement("dialog");
    dialog.style.cssText = "width:min(720px,90vw);max-height:85dvh;overflow:auto;border:1px solid #ddd;border-radius:12px;padding:24px;background:white;color:#37352f;box-sizing:border-box";
    const title = document.createElement("h2"), note = document.createElement("p"), scope = document.createElement("p"), list = document.createElement("ul");
    title.id = "datahub-source-settings-confirm"; title.textContent = "確認Pi Agent使用來源";
    dialog.setAttribute("aria-labelledby", title.id);
    note.textContent = plan.after.enabled
      ? "你將允許以下DataHub metadata傳送至目前使用的Pi Agent模型。審核發布、共用定義新增與修改的授權如下；每項發布仍須人工核准，不啟用AUTO、SQL或ingestion執行。"
      : "將停用此來源的Agent metadata讀取與提案預覽。已存在的對話內容不會因此刪除。";
    const added = plan.after.datasetUrns.filter((urn) => !plan.before.datasetUrns.includes(urn));
    const removed = plan.before.datasetUrns.filter((urn) => !plan.after.datasetUrns.includes(urn));
    scope.textContent = `使用者：${plan.actorUrn}\n來源：${plan.source.name}\n${plan.source.urn}\nSource版本：${plan.source.version}\nRecipe SHA：${plan.source.recipeSha256}\n啟用狀態：${plan.before.enabled ? "開" : "關"} → ${plan.after.enabled ? "開" : "關"}\n原範圍：${plan.before.datasetUrns.length} → 新範圍：${plan.after.datasetUrns.length} 個Dataset\n新增${added.length}個、移除${removed.length}個。範圍依既有來源provenance核對，不代表最新完整掃描。`;
    const before = plan.before.publication, after = plan.after.publication;
    const on = (value) => value ? "開" : "關";
    scope.textContent += `\n審核提案／人工核准發布：${on(before.review)} → ${on(after.review)}\n共用定義新增：${on(before.createDefinitions)} → ${on(after.createDefinitions)}\n共用定義修改：${on(before.updateDefinitions)} → ${on(after.updateDefinitions)}\nAgent身分：${before.agentUrn ?? "未設定"} → ${after.agentUrn ?? "未設定"}\n稽核範圍：既有Task／Run ACL。授權適用上述選取的Dataset及欄位；共用定義仍核對影響範圍，跨庫或影響不明不放行。`;
    scope.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
    for (const urn of plan.after.datasetUrns) { const item = document.createElement("li"); item.textContent = urn; item.style.overflowWrap = "anywhere"; list.append(item); }
    const removals = document.createElement("details"), removalsTitle = document.createElement("summary"), removalList = document.createElement("ul");
    removals.hidden = removed.length === 0; removalsTitle.textContent = `移除的${removed.length}個Dataset`;
    for (const urn of removed) { const item = document.createElement("li"); item.textContent = urn; item.style.overflowWrap = "anywhere"; removalList.append(item); }
    removals.append(removalsTitle, removalList);
    const consent = document.createElement("input"), label = document.createElement("label");
    consent.type = "checkbox"; label.append(consent, document.createTextNode(" 我已閱讀精確資產範圍、metadata傳送及各項語義授權差異；了解每次發布仍須人工核准"));
    const cancel = document.createElement("button"), save = document.createElement("button");
    cancel.type = save.type = "button"; cancel.textContent = "取消"; save.textContent = "確認並保存"; save.disabled = true;
    for (const button of [cancel, save]) button.style.cssText = "min-height:44px;padding:8px 16px;margin:8px;font:inherit";
    consent.onchange = () => { save.disabled = !consent.checked; };
    function finish(value) {
      signal.removeEventListener("abort", aborted); dialog.close(); dialog.remove();
      if (opener?.isConnected) opener.focus(); resolve(value);
    }
    const aborted = () => finish(false);
    cancel.onclick = () => finish(false);
    save.onclick = () => { if (consent.checked && !signal.aborted) finish(true); };
    dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    dialog.append(title, note, scope, list, removals, label, cancel, save); container.append(dialog);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) finish(false); else { dialog.showModal(); cancel.focus(); }
  });
}

/** UI settings only. Save is created by this trusted parent after fresh native
 * preview and a real human confirmation; neither Pi tools nor iframe verdicts
 * can submit a Host save action. No retries after uncertain effects. */
export function installSourceSettingsBridge({ container, frame, origin, send }) {
  let pending;
  const listener = async (event) => {
    if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.type !== "datahub-source-settings") return;
    const port = event.ports?.[0]; if (!port) return;
    const reply = (value) => { port.postMessage(JSON.stringify(value)); };
    if (pending) { reply({ error: "source_settings_busy" }); port.close(); return; }
    const abort = new AbortController(); pending = abort;
    port.onmessage = (message) => { if (message.data?.type === "cancel") abort.abort(); };
    const timer = setTimeout(() => abort.abort(), 300000);
    let saving = false;
    try {
      if (typeof event.data.body !== "string" || new TextEncoder().encode(event.data.body).length > 262144) throw new Error();
      const request = JSON.parse(event.data.body);
      if (!["list", "inspect", "review"].includes(request?.action)) throw new Error();
      if (request.action === "review") {
        if (Object.keys(request).some((key) => !["action", "sourceUrn", "revision", "sourceVersion", "datasetUrns", "enabled", "publication"].includes(key))) throw new Error();
        const preview = await send({ ...request, action: "preview" }, abort.signal);
        if (preview.error) { reply(preview); return; }
        const validPublication = (p) => p && ["review", "createDefinitions", "updateDefinitions"].every((k) => typeof p[k] === "boolean") &&
          (p.agentUrn === null || typeof p.agentUrn === "string");
        if (preview.format !== "datahub-source-settings/1" || !/^[a-f0-9]{64}$/.test(preview.planDigest) ||
          !Array.isArray(preview.after?.datasetUrns) || !validPublication(preview.before?.publication) || !validPublication(preview.after.publication) ||
          preview.publicationApproved !== preview.after.publication.review || preview.ingestionExecutionApproved !== false || preview.autoPublicationEnabled !== false) throw new Error();
        if (!(await confirmSettings(container, preview, abort.signal))) { if (!abort.signal.aborted) reply({ cancelled: true }); return; }
        saving = true;
        const result = await send({ ...request, action: "save", planDigest: preview.planDigest }, abort.signal);
        if (!abort.signal.aborted) reply(result);
      } else {
        const result = await send(request, abort.signal);
        if (!abort.signal.aborted) reply(result);
      }
    } catch {
      if (!abort.signal.aborted) reply({ error: saving ? "source_settings_save_unconfirmed" : "source_settings_request_failed" });
    } finally { clearTimeout(timer); port.close(); if (pending === abort) pending = undefined; }
  };
  window.addEventListener("message", listener);
  return () => { window.removeEventListener("message", listener); pending?.abort(); };
}
