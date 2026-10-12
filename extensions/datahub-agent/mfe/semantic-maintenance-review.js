import { appendSemanticChange, loadSemanticReview } from "./semantic-review.js";
import { placeWorkspacePortal } from "./workspace-portal.js";
import { appendReadableValue, assetLabel, kindLabel, stateLabel } from "./semantic-readable.js";

const locator = (urn) => typeof urn === "string" && urn.length <= 1024 && urn.startsWith("urn:li:dataProcessInstance:");
const fail = (code = "semantic_maintenance_read_unconfirmed") => { throw new Error(code); };
const sameGovernance = (a, b) => a === undefined && b === undefined || Boolean(a && b &&
  ["sourceUrn", "focus", "assetScopeBasis"].every(key => a[key] === b[key]));

/** Read every manifest page and every selected review's digest-bound document.
 * Nothing from the iframe, a chat snapshot or a partial receipt is consent. */
export async function loadMaintenancePlan(reference, send, signal, onProgress) {
  if (!locator(reference.maintenanceRunUrn) || signal.aborted) fail();
  let first, offset = 0;
  const items = [];
  do {
    const page = await send({ action: "read_maintenance", ...reference, offset }, signal);
    if (signal.aborted || page?.error || page?.delivery !== undefined || page?.format !== "datahub-semantic.maintenance/1" ||
      page.publicationAuthorized !== false || page.maintenanceRunUrn !== reference.maintenanceRunUrn ||
      !/^[1-9][0-9]*$/.test(page.runVersion ?? "") || !["DRAFT", "READY", "CONFIRMED"].includes(page.state) ||
      !Number.isInteger(page.totalItems) || page.totalItems < 0 || page.totalItems > 1024 || page.offset !== offset ||
      !Array.isArray(page.items) || page.items.length !== Math.min(20, page.totalItems - offset) ||
      page.nextOffset !== (offset + page.items.length < page.totalItems ? offset + page.items.length : null)) fail();
    if (page.state !== "DRAFT" && !/^[a-f0-9]{64}$/.test(page.planDigest ?? "")) fail();
    if (page.governance && (page.governance.sourceUrn !== page.sourceUrn ||
      !["all", "glossary", "tag", "table", "field"].includes(page.governance.focus) ||
      page.governance.assetScopeBasis !== "NATIVE_TASK_SELECTED_ASSETS")) fail();
    if (!first) first = page;
    else if (["runVersion", "planDigest", "totalItems", "state", "sourceUrn", "taskUrn", "selection", "readOnly"]
      .some((key) => first[key] !== page[key]) || !sameGovernance(first.governance, page.governance)) fail("semantic_maintenance_plan_changed");
    onProgress?.({ phase: "manifest", totalItems: first.totalItems, completedItems: items.length });
    for (const item of page.items) {
      if (!/^[a-f0-9-]{36}$/.test(item.id ?? "") || items.some((entry) => entry.id === item.id)) fail();
      onProgress?.({ phase: "review", totalItems: first.totalItems, completedItems: items.length, currentItem: item });
      if (item.reviewRef) {
        const review = await loadSemanticReview(item.reviewRef, send, signal);
        if (review.planDigest !== item.planDigest || review.maintenanceRunUrn !== reference.maintenanceRunUrn ||
          review.preview?.source?.urn !== first.sourceUrn || review.preview?.contract !== "catalog/1" ||
          !sameGovernance(review.preview?.governance, first.governance) ||
          !Array.isArray(item.dependencies) || item.dependencies.length > 1024) fail();
        items.push({ ...item, review });
      } else {
        if (!["KEEP", "GAP", "DEFERRED", "OBSERVATION_CHANGED"].includes(item.status)) fail();
        items.push(item);
      }
      onProgress?.({ phase: "item", totalItems: first.totalItems, completedItems: items.length, item: items.at(-1) });
    }
    offset = page.nextOffset;
  } while (offset !== null);
  onProgress?.({ phase: "final", totalItems: first.totalItems, completedItems: items.length });
  const final = await send({ action: "read_maintenance", ...reference, offset: 0 }, signal);
  if (signal.aborted || final?.error || final?.delivery !== undefined || ["runVersion", "planDigest", "totalItems", "state", "sourceUrn", "selection", "readOnly"]
    .some((key) => first[key] !== final[key]) || !sameGovernance(first.governance, final.governance)) fail("semantic_maintenance_plan_changed");
  return { ...final, items, receipt: final }; // Keep the bounded public receipt for the closing handshake.
}

function selectionFor(items, selected) {
  const bytes = new Uint8Array(Math.ceil(items.length / 8));
  items.forEach((item, index) => { if (selected.has(item.id)) bytes[index >> 3] |= 1 << (index % 8); });
  return btoa(String.fromCharCode(...bytes));
}
function idsFor(items, selection) {
  let text;
  try { text = atob(selection); } catch { fail("semantic_maintenance_selection_invalid"); }
  if (text.length !== Math.ceil(items.length / 8)) fail("semantic_maintenance_selection_invalid");
  return new Set(items.filter((_, index) => text.charCodeAt(index >> 3) & (1 << (index % 8))).map((item) => item.id));
}
export function orderMaintenanceItems(items, selected) {
  const ordered = [], done = new Set(), byId = new Map(items.map((item) => [item.id, item]));
  function visit(item, visiting) {
    if (done.has(item.id)) return;
    if (visiting.has(item.id)) fail("semantic_maintenance_dependency_cycle");
    visiting.add(item.id);
    for (const id of item.dependencies ?? []) {
      if (!selected.has(id) || !byId.has(id)) fail("semantic_maintenance_selection_dependency_missing");
      visit(byId.get(id), visiting);
    }
    visiting.delete(item.id); done.add(item.id); ordered.push(item);
  }
  for (const item of items) if (selected.has(item.id)) visit(item, new Set());
  return ordered;
}

/** This parent-owned panel, not the model, records whole-plan consent and runs
 * sequential first dispatches. Closing/unmounting stops future dispatches;
 * consumed or unconfirmed attempts are never replayed. Independent branches
 * can proceed while an unresolved parent blocks only its dependants. */
export async function semanticMaintenancePanel({ container, reference, send, signal, slot, onMounted }) {
  const dialog = document.createElement(slot ? "section" : "dialog");
  dialog.setAttribute("aria-label", "整批語義維護計畫");
  if (slot) dialog.setAttribute("role", "region");
  dialog.dataset.semanticMaintenancePanel = "true";
  dialog.style.cssText = "box-sizing:border-box;position:fixed;margin:0;padding:0;border:0;background:#fff;color:#374066;display:flex;flex-direction:column;overflow:hidden;font:14px/1.5 Mulish,system-ui,sans-serif;z-index:10";
  if (!slot) Object.assign(dialog.style, { inset: "0 0 0 auto", width: "min(760px,100vw)", maxWidth: "100vw", height: "100dvh", maxHeight: "100dvh" });
  const header = document.createElement("header"); header.style.cssText = "flex:none;padding:12px 16px;border-bottom:1px solid #ececec";
  const title = document.createElement("h2"); title.textContent = "核對這次維護建議"; title.style.cssText = "margin:0;font-size:18px";
  const summaryLine = document.createElement("p"); summaryLine.style.cssText = "margin:6px 0";
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.style.cssText = "overflow-wrap:anywhere;margin:6px 0;font-size:12px";
  const tools = document.createElement("div"); tools.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
  const search = document.createElement("input"); search.type = "search"; search.placeholder = "搜尋資產、定義或欄位"; search.setAttribute("aria-label", search.placeholder);
  search.style.cssText = "box-sizing:border-box;min-width:0;flex:1;min-height:44px;font:inherit;padding:6px 8px;border:1px solid #b9bed0;border-radius:4px";
  const filter = document.createElement("select"); filter.setAttribute("aria-label", "顯示項目類型"); filter.style.cssText = "min-height:44px;font:inherit;max-width:100%;border:1px solid #b9bed0;border-radius:4px";
  for (const [value, caption] of [["all", "全部項目"], ["definition", "共用定義"], ["application", "資產與欄位"], ["gap", "缺口與暫緩"]]) { const option = document.createElement("option"); option.value = value; option.textContent = caption; filter.append(option); }
  const content = document.createElement("section"); content.setAttribute("aria-label", "維護建議清單"); content.tabIndex = 0;
  content.style.cssText = "flex:1;min-height:0;overflow:auto;padding:0 16px;scrollbar-gutter:stable";
  const footer = document.createElement("footer"); footer.style.cssText = "flex:none;background:white;padding:10px 16px;border-top:1px solid #ececec";
  const acknowledgementBox = document.createElement("div");
  const selectionLine = document.createElement("p"); selectionLine.style.cssText = "font-size:12px;margin:4px 0";
  const disabledReason = document.createElement("p"); disabledReason.setAttribute("role", "status"); disabledReason.style.cssText = "font-size:12px;margin:4px 0";
  const actions = document.createElement("div"); actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
  footer.append(selectionLine, acknowledgementBox, disabledReason, actions);
  function filterVisible() {
    const query = search.value.trim().toLocaleLowerCase(); let count = 0;
    for (const el of content.querySelectorAll("[data-item-group]")) {
      el.hidden = Boolean((filter.value !== "all" && filter.value !== el.dataset.itemGroup) || !el.dataset.search.includes(query));
      if (!el.hidden) count++;
    }
    selectionLine.textContent = loadingProgress
      ? loadingProgress.totalItems === null ? "正在讀取計畫清單；尚未取得項目總數。"
        : `已讀取差異 ${loadingProgress.completedItems}／${loadingProgress.totalItems} 項；完整計畫核對完成前僅供預覽。`
      : `顯示 ${count}／${plan?.items.length ?? 0} 項；已選 ${chosen.size} 項。搜尋與篩選不會改變選取。`;
  }
  search.oninput = filterVisible; filter.onchange = filterVisible;
  let resolve, plan, chosen = new Set(), busy = false, confirmed = false, stop = false, acknowledgement = false, uncertain = false, result;
  let loadingProgress = null, readAbort = null;
  const loadingNames = new Map();
  const done = new Promise((finish) => { resolve = finish; });
  function close() {
    stop = true;
    if (busy) { readAbort?.abort(); status.textContent = "已停止後續派送；等候已派送結果或原生對帳，不會自動重送。"; return; }
    signal.removeEventListener("abort", abort);
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, true);
    document.removeEventListener("visibilitychange", place);
    if (slot) { slot.place = null; slot.frame.removeEventListener("load", abort); }
    if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
    dialog.remove(); resolve(result?.receipt ?? result ?? plan?.receipt ?? plan);
  }
  const abort = () => { stop = true; readAbort?.abort(); busy = false; close(); };
  function button(label, handler) {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label;
    node.style.cssText = "min-height:44px;padding:8px 12px;font:inherit;border:1px solid #b9bed0;border-radius:4px;background:#f6f7fa;color:#374066;cursor:pointer"; node.onclick = handler; actions.append(node); return node;
  }
  const closeButton = button("關閉／停止後續執行", close);
  const refresh = button("只讀核對原生結果", () => void read());
  const approve = button("確認整批並依序建立／套用", () => void execute());
  function text(tag, message, parent = content) {
    const node = document.createElement(tag); node.textContent = message; node.style.overflowWrap = "anywhere"; parent.append(node); return node;
  }
  function controls() {
    refresh.disabled = busy;
    approve.disabled = busy || uncertain || !plan || plan.readOnly || !chosen.size ||
      (!confirmed && (plan.state !== "READY" || !acknowledgement)) ||
      (confirmed && !plan.items.some((item) => chosen.has(item.id) && ["PENDING", "APPROVE"].includes(item.status)));
    approve.textContent = confirmed ? "繼續尚未派送項目（不再確認／不重送）" : "確認整批並依序建立／套用";
    closeButton.disabled = false;
    for (const area of [content, acknowledgementBox]) area.querySelectorAll("input").forEach((node) => { node.disabled = busy || confirmed || plan?.readOnly || uncertain || plan?.state !== "READY"; });
    approve.style.opacity = approve.disabled ? "0.55" : "1";
    approve.style.background = approve.disabled ? "#f6f7fa" : "#533fd1";
    approve.style.color = approve.disabled ? "#374066" : "white";
    disabledReason.textContent = busy ? "正在處理，請勿重送。" : uncertain ? "結果或目前內容未確認；只能只讀核對。" : !plan ? "正在讀取完整方案。" : plan.readOnly ? "目前僅有讀取權限，不能執行。" : plan.state === "DRAFT" ? "Agent 尚未完成準備，不能確認。" : !chosen.size ? "請先選取要維護的項目。" : !confirmed && !acknowledgement ? "請核對建議內容，再勾選確認框。" : confirmed && approve.disabled ? "沒有尚未派送的可執行項目；已消耗操作不重送。" : "只會執行此版本與所選項目；缺口不會被視為成功。";
    filterVisible();
  }
  function appendReviewDetails(parent, item, names) {
    const details = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "精確前後差異、階層／關聯／值與證據"; details.append(summary);
    const preview = item.review.preview;
    const changes = preview.changes ?? [{ ...preview.definition, before: preview.definition.before ?? null, after: preview.definition.after }];
    details.addEventListener("toggle", () => {
      if (!details.open || details.dataset.loaded) return;
      details.dataset.loaded = "true";
      for (const change of changes) appendSemanticChange(details, change, { ...preview, maintenance: true, readable: true, displayNames: names });
      if (item.review.attempt) {
        text("h4", "原始派送結果與目前核對", details);
        let initialOutcome = "沒有可確認的原始收據；不能追認成功或重送。";
        try { if (item.review.attempt.outcomeJson) initialOutcome = JSON.parse(item.review.attempt.outcomeJson); } catch { /* Preserve UNKNOWN. */ }
        appendReadableValue(details, { initialOutcome, currentReadback: item.review.reconciliation, currentContext: item.review.currentContext }, names);
      }
    });
    parent.append(details);
  }
  function renderProgress(progress) {
    if (stop || signal.aborted) return;
    loadingProgress = progress;
    summaryLine.textContent = `共 ${progress.totalItems} 項維護建議 · 正在讀取同版本原生差異`;
    const current = progress.currentItem;
    const title = current?.definition ? `${kindLabel(current.definition.kind)} · ${current.definition.name}` : current ? assetLabel(current.assetUrn) : "";
    status.textContent = progress.phase === "final" ? "差異已讀齊，正在核對計畫最終版本；尚不能確認。"
      : `已讀取差異 ${progress.completedItems}／${progress.totalItems} 項${title ? `；正在讀取 ${title}` : ""}。`;
    if (progress.item) {
      const item = progress.item;
      if (item.definition) loadingNames.set(item.definition.urn, item.definition.name);
      const row = document.createElement("article"); row.dataset.semanticLoadingItem = item.id;
      row.dataset.itemGroup = ["GAP", "DEFERRED", "OBSERVATION_CHANGED"].includes(item.status) ? "gap" : item.definition ? "definition" : "application";
      const itemTitle = item.definition ? `${kindLabel(item.definition.kind)} · ${item.definition.name}` : assetLabel(item.assetUrn);
      row.dataset.search = [itemTitle, ...(item.review?.preview?.changes ?? []).map(change => change.fieldPath ?? "")].join(" ").toLocaleLowerCase();
      row.style.cssText = "margin:16px 0;padding:12px 0;border-bottom:1px solid #ececec";
      text("h3", `${itemTitle} · ${stateLabel(item.status)} · 只讀預覽`, row);
      if (item.review) appendReviewDetails(row, item, loadingNames);
      else text("p", item.gap?.reason ?? "已讀取保留／觀測紀錄；尚未完成整批版本核對。", row);
      content.append(row);
    }
    filterVisible();
  }
  function render() {
    loadingProgress = null; content.removeAttribute("aria-busy");
    content.replaceChildren(); acknowledgementBox.replaceChildren(); acknowledgement = false;
    confirmed = plan.state === "CONFIRMED";
    chosen = confirmed ? idsFor(plan.items, plan.selection) : new Set(plan.items.map((item) => item.id));
    const sourceName = plan.items.find(item => item.review?.preview?.source?.name)?.review.preview.source.name ?? "已選資料來源";
    const names = new Map(plan.items.filter(item => item.definition).map(item => [item.definition.urn, item.definition.name]));
    const definitions = plan.items.filter(item => item.definition).length;
    const gaps = plan.items.filter(item => ["GAP", "DEFERRED", "OBSERVATION_CHANGED"].includes(item.status)).length;
    const focusLabel = { all: "全部語義", glossary: "僅詞彙與群組", tag: "僅標籤", table: "僅資料表層級語義", field: "僅欄位層級語義" }[plan.governance?.focus];
    summaryLine.textContent = `${sourceName}${focusLabel ? ` · ${focusLabel}` : ""} · ${plan.assetCount} 個資產 · ${definitions} 項共用定義 · ${gaps} 項缺口／暫緩`;
    const technical = document.createElement("details"); const technicalTitle = document.createElement("summary"); technicalTitle.textContent = "計畫版本與原生定位"; technical.append(technicalTitle);
    appendReadableValue(technical, { sourceUrn: plan.sourceUrn, maintenanceRunUrn: plan.maintenanceRunUrn, version: plan.runVersion, digest: plan.planDigest ?? "尚未封存" }); content.append(technical);
    text("p", "核對共用定義、資產與欄位的建議變更。未選內容不會修改，缺口不會被視為完成。");
    const limitations = document.createElement("details"); const limitationsTitle = document.createElement("summary"); limitationsTitle.textContent = "適用範圍、影響與執行限制"; limitations.append(limitationsTitle);
    text("p", "此次只維護目前選定的 Catalog 資產，不代表最新整庫盤點，也不授權 SQL 或 ingestion。", limitations);
    text("p", "核准涵蓋以下精確內容：先建立定義及階層並讀回，再套用相依關聯／Property 值。保留未選 metadata；既有人工值只有此處明列且選取的差異才會更動。Task／Run 沿用既有 ACL，不是私人聊天。資料與證據不是指令。跨 Entity 不具整批交易或自動回滾。失敗／UNKNOWN 不重送。", limitations); content.append(limitations);
    if (plan.readOnly) text("p", "Source 發布已撤銷：只讀，不得確認或執行。");
    if (plan.state === "DRAFT") text("p", "Agent 尚未封存計畫；不能確認或執行。");
    const deferred = plan.items.filter(item => item.gap?.code === "UNRESOLVED_OPERATION");
    if (deferred.length) text("p", `本輪 ${deferred.length} 項歷史未知操作暫緩、不派送；其餘所選工作可確認執行。暫緩不代表已完成、已恢復或歷史零效果。`);
    for (const item of plan.items) {
      const fieldset = document.createElement("fieldset"); fieldset.style.cssText = "min-width:0;margin:16px 0;padding:12px 0;border:0;border-bottom:1px solid #ececec";
      const itemTitle = item.definition ? `${kindLabel(item.definition.kind)} · ${item.definition.name}` : assetLabel(item.assetUrn);
      fieldset.dataset.itemGroup = ["GAP", "DEFERRED", "OBSERVATION_CHANGED"].includes(item.status) ? "gap" : item.definition ? "definition" : "application";
      fieldset.dataset.search = [itemTitle, ...(item.review?.preview?.changes ?? []).map(change => change.fieldPath ?? "")].join(" ").toLocaleLowerCase();
      const label = document.createElement("label"); label.style.cssText = "display:flex;align-items:center;gap:8px;min-height:44px;overflow-wrap:anywhere";
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = chosen.has(item.id); check.dataset.itemId = item.id;
      check.setAttribute("aria-label", `選取計畫項目 ${itemTitle}`);
      check.onchange = () => {
        if (check.checked) {
          chosen.add(item.id);
          const include = (id) => { chosen.add(id); for (const dependency of plan.items.find((entry) => entry.id === id)?.dependencies ?? []) include(dependency); };
          for (const id of item.dependencies ?? []) include(id);
        } else {
          chosen.delete(item.id);
          let changed;
          do { changed = false; for (const entry of plan.items) if (chosen.has(entry.id) && (entry.dependencies ?? []).some((id) => !chosen.has(id))) { chosen.delete(entry.id); changed = true; } } while (changed);
        }
        for (const node of content.querySelectorAll("[data-item-id]")) node.checked = chosen.has(node.dataset.itemId);
        acknowledgement = false; const ack = acknowledgementBox.querySelector("[data-plan-acknowledgement]"); if (ack) ack.checked = false; controls();
      };
      label.append(check, document.createTextNode(`${itemTitle} · ${stateLabel(item.status)}`));
      fieldset.append(label);
      if (item.supersedes) { const history = document.createElement("details"); const caption = document.createElement("summary"); caption.textContent = "本項已修訂，原版本與歷史保留"; history.append(caption); appendReadableValue(history, item.supersedes); fieldset.append(history); }
      if (item.requiresRevision) text("p", `依賴已修訂，Agent 必須重看並修訂此完整套用後才能封存：${item.staleDependencies.join("、")}`, fieldset);
      if (item.dependencies?.length) text("p", `先完成：${item.dependencies.map(id => { const dependency = plan.items.find(entry => entry.id === id); return dependency?.definition?.name ?? assetLabel(dependency?.assetUrn) ?? id; }).join("、")}`, fieldset);
      if (item.review) {
        appendReviewDetails(fieldset, item, names);
        if (item.status === "PENDING" && (item.review.stale || item.review.readOnly)) text("p", "目前快照或授權已變更；Host 不會默默重算內容或覆寫，需新計畫。", fieldset);
      } else if (item.gap?.code === "UNRESOLVED_OPERATION") {
        text("p", `暫緩未知操作：${item.gap.reason}；不重播、不當成功。`, fieldset);
        const original = document.createElement("details"); const caption = document.createElement("summary"); caption.textContent = "原未知操作的定位（不重播）"; original.append(caption); appendReadableValue(original, item.gap.operation); fieldset.append(original);
      } else text("p", item.status === "GAP" ? `未決缺口 ${item.gap?.code}：${item.gap?.reason}；不派送、不當成功。` : item.status === "KEEP" ? "保留目前值：只讀觀測，不寫入目標、不聲稱發布。" : "保留觀測已變更：需重新準備，不冒稱 KEEP。", fieldset);
      content.append(fieldset);
    }
    if (!confirmed) {
      const label = document.createElement("label"); label.style.cssText = "display:flex;align-items:center;gap:8px;min-height:44px";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.planAcknowledgement = "true";
      checkbox.onchange = () => { acknowledgement = checkbox.checked; controls(); };
      label.append(checkbox, document.createTextNode("我已核對整批差異與證據，確認此版本及所選項目，授權依相依順序建立與套用。")); acknowledgementBox.append(label);
    }
    controls();
  }
  async function read() {
    if (busy || signal.aborted) return;
    busy = true; plan = undefined; chosen.clear(); acknowledgement = false;
    loadingProgress = { totalItems: null, completedItems: 0 }; loadingNames.clear();
    content.replaceChildren(); acknowledgementBox.replaceChildren(); content.setAttribute("aria-busy", "true");
    text("p", "已核對的差異會逐項顯示為只讀預覽；整批版本核對完成前不能確認。" );
    summaryLine.textContent = "正在讀取原生計畫清單…"; status.textContent = "正在讀齊計畫與原生差異；無需重新整理頁面。";
    readAbort = new AbortController(); const readSignal = AbortSignal.any([signal, readAbort.signal]); controls();
    try {
      plan = await loadMaintenancePlan(reference, send, readSignal, renderProgress); result = plan;
      uncertain = false; render(); status.textContent = "已讀齊原生計畫；未確認不會建立／套用。";
    } catch (error) { uncertain = true; status.textContent = `只讀核對未確認：${error.message}；不得重送效果。`; }
    finally { readAbort = null; content.removeAttribute("aria-busy"); busy = false; controls(); if (stop) close(); }
  }
  async function execute() {
    if (approve.disabled || signal.aborted) return;
    let ordered;
    try { ordered = orderMaintenanceItems(plan.items, chosen); } catch (error) { status.textContent = error.message; return; }
    busy = true; stop = false; controls();
    const blocked = new Set(); let successes = 0, gaps = 0;
    try {
      if (!confirmed) {
        status.textContent = "記錄一次整批精確確認；尚未派送目標寫入…";
        const response = await send({ action: "approve_maintenance", ...reference, version: plan.runVersion,
          planDigest: plan.planDigest, selection: selectionFor(plan.items, chosen) }, signal);
        if (response?.error || response?.format !== "datahub-semantic.maintenance/1" || response.state !== "CONFIRMED" ||
          response.planDigest !== plan.planDigest || response.maintenanceRunUrn !== reference.maintenanceRunUrn ||
          response.selection !== selectionFor(plan.items, chosen)) fail(response?.error ?? "semantic_maintenance_consent_unconfirmed");
        confirmed = true; result = response;
      }
      for (const item of ordered) {
        if (stop || signal.aborted) break;
        if (item.status === "VERIFIED" || item.status === "KEEP") { successes++; continue; }
        if (!["PENDING", "APPROVE"].includes(item.status) || (item.dependencies ?? []).some((id) => blocked.has(id))) {
          blocked.add(item.id); gaps++; continue;
        }
        status.textContent = `依序建立／套用 ${successes + gaps + 1}/${ordered.length}；不重送已消耗項目…`;
        try {
          const receipt = await send({ action: "publish_maintenance_item", ...reference, planDigest: plan.planDigest, itemId: item.id }, signal);
          if (receipt?.error) {
            const error = new Error(receipt.error); error.nativeResponse = true; throw error;
          }
          if (receipt?.format !== "datahub-semantic.maintenance-item/1" ||
            receipt.planDigest !== plan.planDigest || receipt.itemId !== item.id ||
            receipt.maintenanceRunUrn !== reference.maintenanceRunUrn || receipt.status !== "VERIFIED_CURRENT_VALUES")
            fail(receipt?.error ?? "semantic_maintenance_item_unconfirmed");
          result = receipt; successes++;
        } catch (error) {
          blocked.add(item.id); gaps++;
          status.textContent = `項目 ${item.id} 未確認：${error.message}；不重送，相依項目暫停。`;
          // Network/no-receipt errors may leave Host work in flight. Stop all
          // further dispatch; read native records before any continuation.
          if (!error.nativeResponse || /unconfirmed|capacity|not_authorized|denied|unavailable/.test(error.message)) { stop = true; uncertain = true; }
        }
      }
      if (!signal.aborted) {
        plan = await loadMaintenancePlan(reference, send, signal); result = plan;
        render(); status.textContent = `本次已核對 ${successes}；缺口／阻擋 ${gaps}${stop ? "；已停止後續派送" : ""}。以下原生狀態為準；未完成不宣稱整批成功。`;
      }
    } catch (error) { uncertain = true; stop = true; status.textContent = `結果未確認：${error.message}。只讀對帳；不重送确认或寫入。`; }
    finally { busy = false; controls(); if (stop) close(); }
  }
  const place = () => { if (slot) placeWorkspacePortal({ element: dialog, ...slot, display: "flex" }); };
  if (slot) slot.place = place;
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); close(); } });
  tools.append(search, filter); header.append(title, summaryLine, status, tools);
  dialog.append(header, content, footer); container.append(dialog);
  if (slot) {
    slot.frame.addEventListener("load", abort, { once: true });
    place(); window.addEventListener("resize", place); window.addEventListener("scroll", place, true); document.addEventListener("visibilitychange", place);
  } else if (dialog instanceof HTMLDialogElement) dialog.showModal();
  onMounted?.();
  signal.addEventListener("abort", abort, { once: true }); await read();
  if (signal.aborted) abort();
  return done;
}
