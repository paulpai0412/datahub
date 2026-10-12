import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canCorrectMaintenanceInput } from "./semantic-input-correction.mjs";
import { recordedOperations, operationHistoryDigest, recordedUnconfirmedStarts } from "./semantic-operation-history";

/** Intent only: identity, source scope, Catalog and all authority remain in Host. */
export default function datahubSemantic(pi: ExtensionAPI) {
  const maintenanceWrites = ["start_maintenance", "prepare_maintenance", "revise_maintenance", "recover_maintenance", "seal_maintenance"];
  const maintenanceOperations = [...maintenanceWrites, "read_maintenance", "continue_maintenance"];
  // This lives only inside the accepted foreground prompt. It is not restored
  // from transcript history, a scheduler, an AUTO policy or publication consent.
  let foreground: { runUrn: string; sessionId: string; lastCount: number } | undefined;
  let foregroundStopped = false;
  let boundRoot: { runUrn: string; sessionId: string; sourceUrn?: string; ownMutationVersion?: string } | undefined;
  const correctableReads = new Set<string>();
  // Transport binding only, never authority or a restored business store.
  // Keep only authenticated inspect_asset replies, not vocabulary-search
  // snapshots. The Host still recompiles and rejects current-context drift.
  const inspections = new Map<string, { digest: string; nextOffset: number | null }>();
  const inspectionKey = (sessionId: string, params: { sourceUrn?: string; assetUrn?: string; fieldPath?: string; evidenceMode?: string }) =>
    JSON.stringify([sessionId, params.sourceUrn, params.assetUrn, params.fieldPath ?? null, params.evidenceMode ?? null]);
  // Existing Pi journal only: lifecycle diagnosis, NEVER business authority,
  // permission restoration, a controller or source/proposal content logging.
  const traceForeground = (phase: string, facts: Record<string, string | number | boolean | undefined> = {}) => {
    if (!foreground && !boundRoot && correctableReads.size === 0) return;
    pi.appendEntry("datahub-semantic.foreground-lifecycle/1", {
      diagnosticOnly: true, retryAllowed: false, phase,
      maintenanceRunUrn: foreground?.runUrn ?? boundRoot?.runUrn,
      sessionId: foreground?.sessionId ?? boundRoot?.sessionId,
      active: Boolean(foreground), stopped: foregroundStopped,
      lastRecordedCount: foreground?.lastCount,
      bound: Boolean(boundRoot), inspectionCount: inspections.size,
      correctableCallCount: correctableReads.size, ...facts,
    });
  };
  pi.on("input", (event) => { if (event.source !== "extension") { traceForeground("input-reset", { inputSource: event.source }); foreground = undefined; boundRoot = undefined; foregroundStopped = false; inspections.clear(); correctableReads.clear(); } });
  pi.on("session_start", () => { traceForeground("session-start-reset"); foreground = undefined; boundRoot = undefined; foregroundStopped = false; inspections.clear(); correctableReads.clear(); });
  pi.on("session_shutdown", () => { traceForeground("session-shutdown-reset"); foreground = undefined; boundRoot = undefined; inspections.clear(); correctableReads.clear(); });
  pi.on("session_tree", () => { traceForeground("session-tree-reset"); foreground = undefined; boundRoot = undefined; inspections.clear(); correctableReads.clear(); });
  pi.on("agent_settled", () => { traceForeground("agent-settled-reset"); foreground = undefined; boundRoot = undefined; inspections.clear(); correctableReads.clear(); });
  pi.on("session_compact_failed", () => { traceForeground("compaction-failed-stop"); foreground = undefined; foregroundStopped = true; });
  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "datahub_semantic" || foregroundStopped) return;
    // Public pinned SDK emits start BEFORE schema validation/execute. Validate
    // the same schema on a clone: a failed schema can never reach our transport.
    // This also covers union failures that never enter execute(). Not an error-
    // name heuristic, argument repair or exemption for a dispatched call.
    try { validateToolArguments(semanticTool, { type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.args }); }
    catch { correctableReads.add(event.toolCallId); }
  });
  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "datahub_semantic" && correctableReads.has(event.toolCallId)) {
      traceForeground("known-input-correction", { toolCallId: event.toolCallId });
      correctableReads.delete(event.toolCallId); return;
    }
    if (event.isError) { traceForeground("tool-error-stop", { toolName: event.toolName, toolCallId: event.toolCallId }); foreground = undefined; foregroundStopped = true; }
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (ctx.mode !== "rpc" || !pi.getActiveTools().includes("datahub_semantic")) return;
    const original = recordedUnconfirmedStarts(ctx).at(-1);
    if (!original) return;
    // Facts only, BEFORE the first model response of this accepted new prompt.
    // Never reconstruct a write, resume a plan, clear uncertainty or grant consent.
    let observation: Record<string, unknown>;
    try {
      const sources = (await semanticTool.execute("start-policy-read", { action: "list_sources" }, ctx.signal, undefined, ctx)).details as Record<string, unknown>;
      if (sources.error || !Array.isArray(sources.sources)) throw new Error("current_source_read_unavailable");
      const source = sources.sources.find((value: { urn?: string }) => value.urn === original.sourceUrn);
      if (!source) throw new Error("original_source_not_currently_visible");
      const reconciliation = (await semanticTool.execute("original-start-read", {
        action: "reconcile_maintenance_start", sourceUrn: original.sourceUrn, originalRequestId: original.requestId,
      }, ctx.signal, undefined, ctx)).details as Record<string, unknown>;
      if (reconciliation.error || reconciliation.format !== "datahub-semantic.start-reconciliation/1" ||
          reconciliation.sourceUrn !== original.sourceUrn || reconciliation.originalRequestId !== original.requestId)
        throw new Error("original_start_read_unavailable");
      observation = { ...original, status: "CURRENT_READ", currentPolicy: source.reviewPolicy, reconciliation };
    } catch (error) {
      observation = { ...original, status: "READ_UNAVAILABLE", effect: "NOT_PROVEN",
        error: error instanceof Error ? error.message : "current_start_read_unavailable" };
    }
    return { message: { customType: "datahub-semantic.start-status/1", display: false,
      content: JSON.stringify({ observations: [observation], retryAllowed: false, continuationAuthorized: false,
        instruction: "Current authenticated reads, not consent or write authorization. Do not present the historical refusal as a new Host result. Never repeat the original request or infer historical zero effects from absent current records. For SAVED_PLAN inspect the ORIGINAL Root; partial/unavailable observations stay unresolved. Any new preparation requires the current explicit user intent and Host checks; this read never arms continuation." }) } };
  });
  pi.on("agent_end", async (event, ctx) => {
    const active = foreground;
    const last = event.messages.findLast((message) => message.role === "assistant");
    if (!active) { traceForeground("agent-end-inactive"); return; }
    traceForeground("agent-end", { rpc: ctx.mode === "rpc", signalAborted: Boolean(ctx.signal?.aborted),
      pendingMessages: ctx.hasPendingMessages(), sameSession: active.sessionId === ctx.sessionManager.getSessionId(), lastStopReason: last?.stopReason });
    if (ctx.mode !== "rpc" || ctx.signal?.aborted || ctx.hasPendingMessages() ||
      active.sessionId !== ctx.sessionManager.getSessionId() || last?.stopReason !== "stop") {
      traceForeground("agent-end-condition-stop");
      foreground = undefined;
      foregroundStopped = true;
      return;
    }
    try {
      // Recheck native session binding, Source grants/scope and root state while
      // the SAME prompt is still busy. This action has zero native write effects.
      const result = await semanticTool.execute("foreground-check", {
        action: "continue_maintenance", maintenanceRunUrn: active.runUrn,
      }, ctx.signal, undefined, ctx);
      const value = result.details as Record<string, unknown>;
      if (foreground !== active || ctx.signal?.aborted || ctx.hasPendingMessages()) {
        traceForeground("post-check-interrupted-stop", { sameActive: foreground === active,
          signalAborted: Boolean(ctx.signal?.aborted), pendingMessages: ctx.hasPendingMessages() });
        foreground = undefined;
        return;
      }
      if (value.state !== "DRAFT" || value.foregroundPreparation !== true) {
        traceForeground("native-eligibility-stop", { draft: value.state === "DRAFT", preparationEligible: value.foregroundPreparation === true });
        foreground = undefined;
        return;
      }
      const recorded = value.totalRecordedItems ?? value.totalItems;
      if (!Number.isSafeInteger(recorded) || (recorded as number) <= active.lastCount ||
        (recorded as number) >= 1024) {
        traceForeground("progress-limit-stop", { recorded: typeof recorded === "number" ? recorded : undefined });
        foreground = undefined;
        foregroundStopped = true;
        ctx.ui.notify("語義草稿仍未封存；本段沒有原生準備進展或已達項目上限，前景續作已停止。請查看原 Task/Run。", "warning");
        return;
      }
      traceForeground("queue-followup", { recorded: recorded as number });
      active.lastCount = recorded as number;
      // Public 0.85.1 agent_end followUp queue is drained by the original
      // prompt before agent_settled/prompt_done. Never launch from settled.
      pi.sendMessage({ customType: "datahub-semantic.foreground/1", display: true,
        content: `同一前景準備尚未完成：原生草稿 ${active.runUrn} 已有 ${value.totalItems} 項，` +
          `已有套用／KEEP／GAP／暫緩紀錄 ${value.accountedAssetCount}/${value.assetCount} 個資產，這不是語義完成。` +
          "用read_maintenance view=unprepared讀齊原生剩餘資產，view=scope核對選定範圍及sealing.checks；由你自行判斷完整方案，不把舊managed／AUTO的inventory條件套到這份計畫。" +
          "沿原草稿繼續有證據的準備、讀完欄位分頁並誠實列明缺口；" +
          "盤點數不代表方案完成：先形成一致的Domain／Glossary階層及可重用概念，再合併保存每個資產完整適用套用。" +
          "缺核准詞彙不是GAP理由；可提出供真人確認的組織方案，不猜業務事實。歷史UNKNOWN原操作先跳過：以UNRESOLVED_OPERATION及原操作定位明列暫緩，不重播、不追認零效果；其餘有據且不相依工作繼續。完成本輪可做方案並明列暫緩後可seal_maintenance交一次整批確認，但不宣稱全範圍維護完成。不要另start、不核准或發布。",
        details: { maintenanceRunUrn: active.runUrn, totalItems: value.totalItems } },
      { deliverAs: "followUp", triggerTurn: true });
    } catch {
      traceForeground("foreground-check-failed-stop");
      foreground = undefined;
      foregroundStopped = true;
      ctx.ui.notify("前景準備檢查失敗或回應不明，已停止續作；保留原 Task/Run，勿重播準備或發布。", "warning");
    }
  });
  pi.on("resources_discover", () => ({
    skillPaths: [
      fileURLToPath(
        new URL("../skills/datahub-semantic/SKILL.md", import.meta.url),
      ),
    ],
  }));
  const ordinaryGapCodes = ["INSUFFICIENT_EVIDENCE", "HUMAN_VALUE", "SHARED_IMPACT", "AMBIGUOUS_MEANING", "UNSUPPORTED_CHANGE"] as const;
  const originalOperation = Type.Object({
    action: StringEnum(["prepare_maintenance", "revise_maintenance", "publish_maintenance_item"] as const),
    maintenanceRunUrn: Type.String({ minLength: 1, maxLength: 1024 }),
    requestId: Type.Optional(Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" })),
    itemId: Type.Optional(Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" })),
  }, { additionalProperties: false });
  const definitionItemReference = Type.Object({
    definitionItemId: Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" }),
  }, { additionalProperties: false });
  const semanticTool = defineTool({
    name: "datahub_semantic",
    label: "DataHub 語義維護",
    promptSnippet:
      "Inspect source-scoped semantics and prepare whole-plan maintenance proposals through the trusted DataHub Host; publication requires human confirmation",
    promptGuidelines: [
      "Use datahub_semantic for semantic inventory and maintenance proposals; Catalog search alone cannot start or seal a maintenance plan.",
      "Current active tool schemas define availability; an older assistant statement is not proof that a tool is unavailable. Report the actual tool result if access or execution fails.",
      "Only prepare proposals. A human must confirm the exact whole plan in the trusted Host before publication; never replay an unconfirmed operation or restore consent from conversation history.",
      "A past Source refusal is not current policy. Use fresh Source and original-start reconciliation facts; an unconfirmed original operation remains non-replayable, not a permanent ban on every future intent.",
    ],
    description:
      "Workflow-first whole-plan maintenance: list_sources and Catalog list_assets/inspect_asset cover the current authorized Catalog scope with per-asset provenance, not a claim of latest complete ingestion. " +
      "start_maintenance begins bounded foreground preparation; to explicitly resume an existing DRAFT in the SAME session use continue_maintenance(maintenanceRunUrn) ONLY. It rechecks native eligibility without writes. Normal model finish continues within the current foreground prompt only while native items advance; READY/cancel/revocation/error/uncertain ACK/no progress stop it. read_maintenance is read-only and NEVER arms continuation; reload never auto-resumes. " +
      "start_maintenance accepts ONLY sourceUrn, optional assetUrns and focus=all|glossary|tag|table|field (NO contract/offset/snapshotDigest); default all covers the current authorized Source Catalog scope. A prompt may narrow assets or category, NEVER add assets outside that Source; asset names and keyword hits do not prove membership. Saved focus is immutable for that Root. glossary means node/term definitions and term associations; tag means tag definitions/associations; table means Dataset-level candidates, field means field-level candidates (both may include necessary supporting definitions). Source/ingestion coverage limitations remain explicit; do not claim a latest complete scan from a Catalog subset. For Glossary grouping inspect the FULL hierarchy (names, descriptions and exact URNs), justify the parent against this Source's governance goal, and propose a Source-specific group when appropriate. Same name or upstream lineage never transfers another Source's specific grouping; truly neutral common definitions may be reused only with matching meaning and scope evidence. Host checks technical legality, not business scope.  seal_maintenance accepts ONLY maintenanceRunUrn; read_maintenance accepts maintenanceRunUrn and optional offset; for an asset-scoped view also supply assetUrn and version=current root runVersion (NO contract/sourceUrn). start_maintenance creates one native draft and returns maintenanceRunUrn. prepare_maintenance(maintenanceRunUrn, contract='catalog/1', sourceUrn, assetUrn, snapshotDigest, candidates OR definition/reason/evidenceIds) appends one exact item. " +
      "For DRAFT self-review, revise_maintenance takes the same complete proposal as prepare_maintenance PLUS itemId, version=current root runVersion, childVersion and planDigest from that exact read_maintenance item. It creates a replacement child, preserves original history, and never approves/publishes. Only the SAME asset/root field and definition identity may be revised, before seal and any approval/attempt. Supply the WHOLE intended item, merging all its Aspect changes; omitted proposed changes are withdrawn. Root-mutating calls are dependent: generate ONE mutation, wait for its exact ACK, then explicitly use that ACK's runVersion for the next NEW input; sequential execution does not update already-generated sibling arguments. Successful prepare/revise delivery='incremental' contains ONLY items[0], its exact definition.reference/reviewRef/childVersion/planDigest, latest Root runVersion and scope accounting. delta.completePlan=false: it is not a full plan page or consent. Retain earlier exact references in this prompt and use the ACK without immediately rereading the whole Root. On delta.resyncRequired=true, an unexpected delta.baseVersion versus your last confirmed version, resume/reload or incomplete knowledge, read the full current plan before further mutations. A definition revision requires this resync because other consumers may now be stale. Final self-review and trusted-parent approval still read ALL active items and full digest-bound details. A version known obsolete only by this prompt's OWN confirmed mutation is rejected locally for exact-call model correction; the SDK never fills versions, refreshes, retries or exempts an actual Host CAS/drift failure. Reads/history/reload cannot establish that own-mutation proof. Read returned supersedes/staleDependencies: revise affected consumers before sealing. Old superseded proposals cannot execute. Review source descriptions before asserting a GAP; lack of existing vocabulary is not lack of subject evidence. Source-evidenced meanings do not prove units/timezone/uniqueness/business rules. " +
      "After exact native reconciliation ONLY, recover_maintenance(maintenanceRunUrn,itemId,version=root runVersion,childVersion=child runVersion,planDigest=original child digest) links an intact, unapproved saved review to its ORIGINAL DRAFT. It never repeats preparation, changes the child, grants consent or arms foreground continuation. Do not use it for missing/unknown GAPs or absent children. No automatic recovery after lost ACK. " +
      "Autonomously design a coherent semantic scheme WITHIN the saved Source/asset/focus boundary before saving per-asset applications: applicable reusable Domain/node/term/tag/property definitions, hierarchy, relations, values and descriptions. A narrowed focus does not require unrelated kinds; table/field allow only necessary supporting definitions. Search/reuse first. Missing pre-approved vocabulary or sensitivity policy does NOT prevent evidenced subject semantics or a clearly labeled organizational proposal for human whole-plan confirmation. Isolate real unresolved facts; never guess business facts from names. Definitions prepared earlier return their exact Host URNs and can be referenced by later items before creation. " +
      "For prepare_maintenance/revise_maintenance ONLY, explicitly select an ACTIVE definition from THIS Root via its returned definition.reference={definitionItemId}. Use that object as a domain/tag/term/property candidate value, a member of domain/tag/term set values (can mix preserved URI strings), or definition.parentUrn for domain/node hierarchy. Always supply version=current root runVersion with item references; the SDK never supplies it. Host resolves the exact kind/active native child and rechecks its Source/ACL/digest/version; no name matching, typo repair or following superseded references. Property values stay business literals, not definition references; updates of existing definition.urn retain URI mode. Native stored proposals/review/publication use exact canonical URIs and existing dependencies, not another store or authority. " +
      "For Catalog inspect_asset later pages and prepare_maintenance, omit snapshotDigest: this tool binds the last authenticated inspection of the SAME session/source/asset/root field/evidenceMode. Prepare proposals supported by already observed evidence; complete relevant inventory before sealing, not before every definition or item. Vocabulary searches never replace that inspection. Shared definitions with a field evidence anchor bind the asset schema inspection. Explicit old callers retain Host validation. Do not manually copy a digest from search_vocabulary. " +
      "Before current-prompt start/continue binding, every EXISTING-PLAN maintenance read/continue/write (not start_maintenance) MUST include the exact maintenanceRunUrn; history or a read response does not create that binding. After successful start_maintenance or explicit continue_maintenance in this accepted prompt, OMIT sourceUrn on subsequent catalog/1 intents and OMIT maintenanceRunUrn on subsequent prepare/seal/read intents: the SDK binds the exact authenticated current root. Do not manually recopy or reconstruct Source/root locators. Explicit mismatched current-plan Sources or write roots are rejected before transport, not silently repaired. A new prompt/reload requires explicit start/continue again; reading history never arms continuation. " +
      "Read original operation locators with read_operation_history(contract=catalog/1,sourceUrn,assetUrn,optional fieldPath). It rechecks CURRENT Host visibility, then projects ONLY this session's active-branch recorded intents (20/page). Later offset requires the SAME historyDigest. Returned operation is the original action/Root/known IDs, NOT the current plan Root; effect=NOT_PROVEN and missing IDs stay missing. No recorded locator is a stated coverage gap, never absence/zero effects/replay authority. Journal references never restore continuation or consent. Correct a saved DEFERRED locator with revise_maintenance using its current exact whole-item proof, preserving the old observation; do not repeat the original operation. " +
      "Ordinary GAP has ONLY code/reason; operation is FORBIDDEN. UNRESOLVED_OPERATION REQUIRES operation. A local schema/field rejection or exact authenticated Host inputRejection (INPUT_VALIDATION, request-bound digest, nativeWriteStarted=false) permits a NEW model-corrected intent in this SAME prompt. correctionAllowed is NOT retryAllowed; never replay automatically or infer effects of older UNKNOWNs. Bare HTTP/error names, missing/mismatched receipts, native ACL/CAS failures or lost ACK still stop. " +
      "A Catalog item may contain distinct additive/removal association members and multiple properties per field or across fields. A set candidate means the complete intended collection, including preserved members. Host compiles all candidates by exact native target/Aspect and reads their field context; the model need not split schemaField items. Only conflicting selections for the same semantic target are input errors, with exact pre-write correction evidence for a new intent. NO_CHANGE-only items record KEEP. For explicit evidence/impact gaps, prepare_maintenance with gap={code,reason}, the current asset snapshot and NO candidates/definition; this records a gap, never a target write or success. For a historical UNKNOWN, skip its original operation without replay: gap={code:'UNRESOLVED_OPERATION',reason,operation:{action,maintenanceRunUrn,requestId?,itemId?}} records a DEFERRED observation in the current DRAFT, preserving known original locators and omitting unavailable IDs. This is not recovery, zero-effect proof, consent, permanent asset quarantine or authority to reissue an attempt. Continue independent evidenced work; a plan with explicit deferrals can be READY for partial review, not complete stewardship. Current in-flight/unconfirmed transport still stops until read-only reconciliation.  Prepare/account all selected assets, not one Term; seal_maintenance(maintenanceRunUrn) freezes the whole plan. " +
      "For an existing/resumed plan or revising saved work, read_maintenance(maintenanceRunUrn,assetUrn,version=current root runVersion,offset=0 then nextOffset) aligns ALL active applications and GAP/KEEP observations for that asset, one WHOLE stored input per page. A freshly started empty Root plus this prompt's consecutive confirmed ACKs already identifies its saved items: no mandatory empty asset-view or full Root reread after each successful preparation. Still read the exact stored WHOLE input before revising it and inspect current source evidence. Definition evidence anchors are excluded; still read the full plan for definitions/dependencies. preparedRequest is historical proposal content, not fresh inspection, new authorization or an executable retry. Read all subject pages with the SAME version; any revision changes the root version. A GAP does not mean the asset has no other PENDING proposal. Keep an adequate existing item; for changed evidence or incomplete candidates, revise its exact whole item while deliberately retaining/reassessing every old candidate, not prepare another overlapping item. The tool never chooses an action, merges proposals, refreshes proof or executes a revision for you. " +
      "read_maintenance with view='scope' returns the native Task's exact selected assets; view='unprepared' returns only selected assets with no active application/KEEP/GAP record. Both return format datahub-semantic.maintenance-scope/1, assets (20/page), totalAssets, unpreparedAssetCount, scopeDigest and sealing.checks with condition/met/error. First offset=0 may omit version; every later page MUST supply version=that receipt.runVersion and returned nextOffset, preserving the SAME view. A changed Root requires a new read, never mixed pages. Definition evidence anchors and superseded items do not account for an asset. Absence of an active record is NOT proof of zero prior effects or authority to replay an UNKNOWN write. " +
      "sealing.structurallyReady is NOT semantic completeness or authorization: GAP/KEEP/PENDING records are accounting, not successful maintenance. completeSourceInventoryRequired=false describes this selected-scope whole-plan seal, not an AUTO/full-inventory claim. Original session/Source/native permissions are rechecked on write; human consent remains required for publication. Read the complete item/detail/asset evidence and independently assess a coherent useful scheme before choosing to seal. The Host does not choose your next asset, action or proposal. " +
      "Unfiltered read_maintenance(maintenanceRunUrn, optional offset) returns 20 items/page. The human opens the plan card in the trusted parent and confirms the exact whole plan once; Host creates definitions, verifies native receipts and applies dependent relations. No AUTO policy or per-target approvals are required for this flow. " +
      "The model cannot confirm/publish/cancel or edit a sealed plan. A later maintenance round starts a NEW plan with current/prior-Agent/new comparison, intact human protections and new whole-plan consent. Never retry an unconfirmed write or a consumed attempt. " +
      "For manual Catalog maintenance, first list_sources with ONLY action, without contract. Select sourceUrn from that response; it is REQUIRED in every subsequent Catalog asset/vocabulary/preview intent. " +
      "With contract='catalog/1': list_assets accepts sourceUrn and optional offset ONLY (NO query, NO assetUrn); locate Product from returned assets across nextOffset pages. " +
      "inspect_asset requires sourceUrn AND assetUrn; first page omits offset or uses 0, later pages use nextOffset plus the SAME snapshotDigest. " +
      "search_vocabulary requires sourceUrn, assetUrn, kind and query, optional start. preview_definition requires sourceUrn, assetUrn, snapshotDigest, definition, reason and returned evidenceIds. " +
      "For explicitly requested native field lineage evidence, inspect_asset with evidenceMode='native_field_lineage/1'; preserve that mode on every page, preview_definition/preview and prepare_maintenance/prepare_review using its exact snapshotDigest. Only returned field:N:native-lineage:M evidenceIds are usable. Scoped readable upstream field descriptions and native-reported COPY/derived lineage are evidence, not verified equivalence, joins or business truth. Never propagate meaning automatically from derived fields or field names; raw SQL/query bodies are not provided. Old requests without evidenceMode keep their original snapshots. " +
      "Do not fall back to legacy inspect_source/inspect_dataset when a Catalog request is malformed; correct the exact fields instead. " +
      "publicationAuthorized=false on previews/pending receipts means NO human consent to execute, NOT that Source review permission is denied. " +
      "Read sources[].reviewPolicy or preview.reviewPolicy: canPrepareReview and canPrepareDefinitionCreation show CURRENT Host Source grants; native ACL, versions, evidence and conflicts still apply. " +
      "When those grants allow the requested change, preview and prepare_review for human approval. completeSourceInventory=false blocks full-inventory/AUTO claims, NOT explicit-scope Catalog manual review. Never claim the user lacks publication permission merely from a preview's false flag. " +
      "Catalog semantic governance: use contract='catalog/1' with list_assets and inspect_asset. " +
      "Choose an exact returned assetUrn: Dataset/field, Container, DataFlow, DataJob, Chart or Dashboard. Do not claim ingestion membership for Catalog selection. " +
      "inspect_managed_scope verifies one exact, successful MSSQL ingestion Run and all enumerated Dataset/field provenance. It is read-only, not an automatic publication grant or a whole-database inventory. " +
      "inspect_managed_maintenance with sourceUrn/assetUrn returns an evidence-backed description plan (20 fields/page plus Dataset on page 0), prior-Agent/current/new differences, KEEP and explicit evidence gaps. Later pages use nextOffset and the same snapshotDigest. Names are not meaning evidence. KEEP does not write target metadata or count as publication. Under an active policy, prepare_managed with the exact KEEP candidate records a native no-change Decision and rechecks its selected current values. " +
      "For an active operator policy, inspect_managed_scope supplies managedCycle.runUrn/taskUrn and, for a successor, previousCycleRunUrn. Start exactly that cycle with start_managed_cycle, passing cycleTaskUrn=managedCycle.taskUrn and previousCycleRunUrn when returned. A closed, initially verified previous cycle can advance the SAME Task by version CAS into a new Run under the same unchanged policy; UNKNOWN/pending or an uncertain allocated Run blocks succession. Keep cycleTaskUrn in managed write intents; never derive a successor Task URN from its Run URN. Never invent a new policy or cycle key. " +
      "Then use read_managed_cycle (20 items/page), inspect_asset, prepare_managed for scoped candidates (REVIEW waits for human Host approval; AUTO permits directly evidenced additions or explicitly enabled updates to intact native Agent descriptions; protected existing values become PENDING human review), and record_managed_exception only for genuine evidence/policy gaps; pending or unverified attempts require read-only reconciliation and must never be covered by exceptions. finish_managed_cycle only accounts for a fully receipted scope, not proven business truth. Each write intent is one-shot; never retry a lost response. " +
      "Dataset and field preview includes native priorAgent for the selected description/domain/tag/term/property. Its prior value is comparison context, not ownership of preserved human members; changedValues lists only actual prior additions/removals. Human edits, same-value rewrites and UNKNOWN never gain intact-Agent status. Evidence-backed association replacements/removals route to exact human review, not automatic updates. All candidates must pass evidence checks before a batch can route to review. " +
      "Catalog candidates require operation add/remove/set. add/remove use value=existing domain/tag/term URN; set uses values=the exact desired URN set. " +
      "Description set uses value=text; remove clears only the editable description. Property set uses value=property URN plus typed values; remove omits values. " +
      "Catalog proposals may combine Dataset changes and properties on multiple exact fieldPaths. Host reads each field through the authorized public API, binds its native before-values/versions and groups changes by target Aspect; no per-field inspection or SDK splitting is required. Root fieldPath, when supplied, is the evidence anchor, not a restriction on candidate targets. " +
      "inspect_definition reads kind/referenceUrn and version in the selected asset context. Definition operation=create requires name/description; update requires existing urn/version and only changed name/description/parentUrn (null clears parent). " +
      "Property creation also requires valueType/cardinality/entityTypes (dataset, schemaField, container, dataFlow, dataJob, chart, dashboard); property schema migrations are not supported. " +
      "For a managed cycle, prepare_review creates a separate human-only definition review; then link_managed_definition with cycleRunUrn/cycleTaskUrn and its runUrn/decisionId records the dependency. This link is not consent and does not count as Dataset/field coverage. Read the cycle until initial and current definition publication are verified before preparing its asset association. Unknown or pending linked definitions cannot be bypassed. Shared updates whose global impact is unverified are blocked, including incomplete indexed impact. " +
      "Read existing vocabulary before proposing creation. Shared definitions affect other assets; disclose bounded impact. Outside whole-plan maintenance, the legacy individual-review flow reviews definitions and asset associations separately. "  +
      "Catalog updates may replace human values only through the exact parent review; unselected metadata and source schema are preserved. " +
      "Legacy mode without contract retains evidence-backed maintenance for an approved ingestion source. " +
      "First list_sources, then inspect_source, inspect_dataset (20 fields/page), and preview. " +
      "Use only returned dataset URNs, exact fieldPaths, evidenceIds and snapshotDigest. " +
      "Subsequent field pages require offset=nextOffset plus the same snapshotDigest. " +
      "Preview up to 8 candidates: description text, or an existing domain/tag/term/property URN as value; " +
      "Property assignments need values (string/number). For a column property, inspect_dataset with root fieldPath first, then preview with that same root fieldPath and snapshotDigest, and candidate.fieldPath. " +
      "owner candidates need value=approved owner URN, ownerType and policy:owner evidence; documentation needs value=approved HTTPS URL and description. " +
      "inspect_impact takes datasetUrn, kind, referenceUrn; use start=nextStart with definitionVersion for later dependency pages. Observed dependencies are not global change authorization. " +
      "An operator allowlist is not proof of ingestion membership or full-source coverage. " +
      "search_vocabulary finds visible domain/node/term/tag/property definitions with query and start=nextStart. " +
      "preview_definition proposes a new definition, separate from an association, with definition, reason, evidenceIds and dataset snapshotDigest. Catalog definitions may retain a fieldPath evidence anchor from the inspected asset schema without a separate property inspection; legacy definition mode uses dataset-level evidence. " +
      "Definitions require kind/name/description; domain.parentUrn accepts a Domain, node.parentUrn and term.parentUrn accept a Glossary Group (kind=node), NEVER a Domain. Definition-item references must match that expected kind; use the saved item's definition.kind, not its display name. Keep every selected returned evidenceId; Catalog does not impose an eight-fact count cap, and the overall 24KB request bound remains. " +
      "Property definitions require valueType string/number and cardinality SINGLE/MULTIPLE, optional allowedValues, Dataset only. " +
      "After preview, prepare_review persists eligible candidates (or one definition) as an exact Task/Run/Decision; never include conflicts or NO_CHANGE items. " +
      "The human opens the custom review card and chooses/approves in the trusted Host sidepanel. read_review reloads reviewRef.runUrn/decisionId. " +
      "A persisted review is not consent; the model cannot approve or publish. A consumed attempt must never be retried. " +
      "Native run matches are per asset, never full source coverage. No SQL, arbitrary Aspects, approval or publication action. " +
      "Request <=24KB; each response <=512KiB. Writes return bounded receipts. read_review returns a receipt, not the full proposal. read_review_detail REQUIRES runUrn/decisionId from reviewRef, version=receipt.runVersion, planDigest=receipt.planDigest, detailDigest=receipt.details.digest and integer offset=0 first, then returned nextOffset. Read all pages with the SAME exact proof tuple. Missing fields reject locally for model correction, never inferred; actual Host consistency/drift rejection still stops. Never retry a write.",
    parameters: Type.Object(
      {
        action: StringEnum([
          "list_sources",
          "inspect_source",
          "inspect_dataset",
          "list_assets",
          "inspect_managed_scope",
          "inspect_managed_maintenance",
          "inspect_asset",
          "read_operation_history",
          "inspect_definition",
          "preview",
          "search_vocabulary",
          "preview_definition",
          "inspect_impact",
          "start_managed_cycle",
          "read_managed_cycle",
          "link_managed_definition",
          "record_managed_exception",
          "finish_managed_cycle",
          "prepare_review",
          "prepare_managed",
          "read_review",
          "read_review_detail",
          "start_maintenance",
          "reconcile_maintenance_start",
          "prepare_maintenance",
          "revise_maintenance",
          "recover_maintenance",
          "seal_maintenance",
          "read_maintenance",
          "continue_maintenance",
        ] as const),
        contract: Type.Optional(Type.Literal("catalog/1")),
        view: Type.Optional(StringEnum(["scope", "unprepared"] as const)),
        evidenceMode: Type.Optional(Type.Literal("native_field_lineage/1")),
        assetUrn: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        runUrn: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        maintenanceRunUrn: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        itemId: Type.Optional(Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" })),
        childVersion: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*$" })),
        assetUrns: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 1024 })),
        focus: Type.Optional(Type.Union(["all", "glossary", "tag", "table", "field"].map(value => Type.Literal(value)), {
          description: "Only start_maintenance: narrow the Source-bound governance category; default all. Immutable for this Root. table/field select Dataset assets only; their supporting definitions remain available.",
        })),
        gap: Type.Optional(Type.Union([
          Type.Object({ code: StringEnum(ordinaryGapCodes), reason: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }),
          Type.Object({ code: Type.Literal("UNRESOLVED_OPERATION"), reason: Type.String({ minLength: 1, maxLength: 1024 }),
            operation: originalOperation }, { additionalProperties: false }),
        ])),
        historyDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
        originalRequestId: Type.Optional(Type.String({ pattern: "^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$" })),
        cycleRunUrn: Type.Optional(
          Type.String({ minLength: 1, maxLength: 1024 }),
        ),
        cycleTaskUrn: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        previousCycleRunUrn: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        code: Type.Optional(
          StringEnum([
            "INSUFFICIENT_EVIDENCE",
            "HUMAN_VALUE",
            "SHARED_IMPACT",
            "AMBIGUOUS_MEANING",
            "UNSUPPORTED_CHANGE",
            "POLICY_DENIED",
          ] as const),
        ),
        decisionId: Type.Optional(
          Type.String({ minLength: 1, maxLength: 128 }),
        ),
        sourceUrn: Type.Optional(
          Type.String({ minLength: 1, maxLength: 1024, description: "REQUIRED for Catalog list_assets/inspect_asset/search_vocabulary/preview/preview_definition/prepare_review. Obtain it from list_sources; do not assume the active UI supplies it." }),
        ),
        datasetUrn: Type.Optional(
          Type.String({ minLength: 1, maxLength: 1024 }),
        ),
        fieldPath: Type.Optional(
          Type.String({ minLength: 1, maxLength: 2048 }),
        ),
        referenceUrn: Type.Optional(
          Type.String({ minLength: 1, maxLength: 1024 }),
        ),
        version: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*$" })),
        planDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
        detailDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
        definitionVersion: Type.Optional(
          Type.String({ pattern: "^[1-9][0-9]*$" }),
        ),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        snapshotDigest: Type.Optional(
          Type.String({ pattern: "^[a-f0-9]{64}$" }),
        ),
        scopeFingerprint: Type.Optional(
          Type.String({ pattern: "^[a-f0-9]{64}$" }),
        ),
        kind: Type.Optional(
          StringEnum(["domain", "node", "term", "tag", "property"] as const),
        ),
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Only search_vocabulary; NEVER list_assets or inspect_asset." })),
        start: Type.Optional(Type.Integer({ minimum: 0, maximum: 980 })),
        definition: Type.Optional(
          Type.Object(
            {
              kind: StringEnum([
                "domain",
                "node",
                "term",
                "tag",
                "property",
              ] as const),
              operation: Type.Optional(
                StringEnum(["create", "update"] as const),
              ),
              urn: Type.Optional(
                Type.String({ minLength: 1, maxLength: 1024 }),
              ),
              version: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*$" })),
              name: Type.Optional(
                Type.String({ minLength: 1, maxLength: 160 }),
              ),
              description: Type.Optional(
                Type.String({ minLength: 1, maxLength: 8000 }),
              ),
              parentUrn: Type.Optional(
                Type.Union([
                  Type.String({ minLength: 1, maxLength: 1024 }),
                  definitionItemReference,
                  Type.Null(),
                ]),
              ),
              entityTypes: Type.Optional(
                Type.Array(
                  StringEnum([
                    "dataset",
                    "schemaField",
                    "container",
                    "dataFlow",
                    "dataJob",
                    "chart",
                    "dashboard",
                  ] as const),
                  { minItems: 1, maxItems: 7 },
                ),
              ),
              valueType: Type.Optional(
                StringEnum(["string", "number"] as const),
              ),
              cardinality: Type.Optional(
                StringEnum(["SINGLE", "MULTIPLE"] as const),
              ),
              allowedValues: Type.Optional(
                Type.Array(
                  Type.Union([Type.String({ maxLength: 500 }), Type.Number()]),
                  { minItems: 1, maxItems: 64 },
                ),
              ),
            },
            { additionalProperties: false },
          ),
        ),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
        evidenceIds: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
            minItems: 1,
          }),
        ),
        candidates: Type.Optional(
          Type.Array(
            Type.Object(
              {
                kind: StringEnum([
                  "description",
                  "domain",
                  "tag",
                  "term",
                  "property",
                  "owner",
                  "documentation",
                ] as const),
                operation: Type.Optional(
                  StringEnum(["add", "remove", "set"] as const),
                ),
                ownerType: Type.Optional(
                  StringEnum([
                    "TECHNICAL_OWNER",
                    "BUSINESS_OWNER",
                    "DATA_STEWARD",
                  ] as const),
                ),
                description: Type.Optional(
                  Type.String({ minLength: 1, maxLength: 2048 }),
                ),
                fieldPath: Type.Optional(
                  Type.String({ minLength: 1, maxLength: 2048 }),
                ),
                value: Type.Optional(Type.Union([
                  Type.String({ minLength: 1, maxLength: 8000 }), definitionItemReference,
                ])),
                values: Type.Optional(
                  Type.Array(
                    Type.Union([
                      Type.String({ maxLength: 2048 }),
                      Type.Number(),
                      definitionItemReference,
                    ]),
                    { minItems: 0, maxItems: 16 },
                  ),
                ),
                reason: Type.String({ minLength: 1, maxLength: 2048 }),
                evidenceIds: Type.Array(
                  Type.String({ minLength: 1, maxLength: 128 }),
                  { minItems: 1 },
                ),
              },
              { additionalProperties: false },
            ),
            // Count only; request 24KB and response 512KiB are independent.
            { minItems: 1, maxItems: 1024 },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      let requestId: string | undefined;
      let dispatched = false;
      let replyConfirmed = false;
      let correctableRead = false;
      let historyQuery: { offset: number; digest?: string } | undefined;
      let reconciliation: Record<string, string> = {};
      try {
      if (ctx.mode !== "rpc") throw new Error("datahub_host_required");
      signal?.throwIfAborted();
      requestId = randomUUID();
      const intent = { ...params };
      // Missing page proof is a known local input failure, not native drift.
      // Never infer a version/digest/offset or refresh/retry the request here.
      if (intent.action === "read_review_detail" &&
        [intent.runUrn, intent.decisionId, intent.version, intent.planDigest, intent.detailDigest, intent.offset].some(value => value === undefined)) {
        correctableRead = true; correctableReads.add(_id);
        throw new Error("semantic_review_detail_input_required: supply exact runUrn/decisionId, version=read_review.runVersion, planDigest=read_review.planDigest, detailDigest=read_review.details.digest and integer offset (0 first, then nextOffset); no request dispatched");
      }
      if (maintenanceOperations.includes(intent.action) && intent.action !== "start_maintenance") {
        const binding = boundRoot?.sessionId === ctx.sessionManager.getSessionId() ? boundRoot : undefined;
        if (intent.maintenanceRunUrn === undefined) {
          if (!binding) {
            correctableRead = true; correctableReads.add(_id);
            throw new Error("semantic_maintenance_root_required: before authenticated current-prompt start/continue binding, supply the exact maintenanceRunUrn; no request dispatched");
          }
          intent.maintenanceRunUrn = binding.runUrn;
        } else if (binding && [...maintenanceWrites, "continue_maintenance"].includes(intent.action) && intent.maintenanceRunUrn !== binding.runUrn) {
          correctableRead = true; correctableReads.add(_id);
          throw new Error("semantic_maintenance_root_binding_mismatch: omit maintenanceRunUrn to use the authenticated current plan; no request dispatched");
        }
        // Sequential execution cannot refresh arguments already produced in a
        // sibling tool call. Only a confirmed OWN mutation in this prompt can
        // prove an older input obsolete locally; reads/history never do so.
        const ownVersion = binding?.ownMutationVersion, inputVersion = intent.version;
        if (foreground && !foregroundStopped && binding?.runUrn === intent.maintenanceRunUrn &&
          ["prepare_maintenance", "revise_maintenance", "recover_maintenance", "read_maintenance"].includes(intent.action) &&
          ownVersion && typeof inputVersion === "string" && /^[1-9][0-9]*$/.test(inputVersion) &&
          (inputVersion.length < ownVersion.length || inputVersion.length === ownVersion.length && inputVersion < ownVersion)) {
          correctableRead = true; correctableReads.add(_id);
          throw new Error("semantic_maintenance_self_stale_input: a confirmed mutation in this SAME prompt advanced this Root beyond the supplied version; use the latest confirmed ACK's runVersion for a NEW exact whole-item input; if that ACK is unavailable or resync is required, read the current original Root first; no request dispatched. The SDK never fills a version, refreshes or retries.");
        }
      }
      if (intent.contract === "catalog/1" && boundRoot?.sessionId === ctx.sessionManager.getSessionId() && boundRoot.sourceUrn) {
        if (intent.sourceUrn === undefined) intent.sourceUrn = boundRoot.sourceUrn;
        else if (intent.sourceUrn !== boundRoot.sourceUrn) {
          correctableRead = true; correctableReads.add(_id);
          throw new Error("semantic_maintenance_source_binding_mismatch: omit sourceUrn to use the authenticated current plan source; no request dispatched");
        }
      }
      if (intent.action === "reconcile_maintenance_start" &&
          !recordedUnconfirmedStarts(ctx).some(original => original.requestId === intent.originalRequestId && original.sourceUrn === intent.sourceUrn)) {
        correctableRead = true; correctableReads.add(_id);
        throw new Error("semantic_start_history_required: select an exact unconfirmed start from THIS session's active branch and its original Source; no request dispatched");
      }
      if (intent.action === "read_operation_history") {
        if (intent.contract !== "catalog/1" || !intent.sourceUrn || !intent.assetUrn ||
            Object.keys(intent).some(key => !["action", "contract", "sourceUrn", "assetUrn", "fieldPath", "offset", "historyDigest"].includes(key)) ||
            !Number.isSafeInteger(intent.offset ?? 0) || (intent.offset ?? 0) < 0 ||
            (intent.offset ?? 0) > 0 && !intent.historyDigest) {
          correctableRead = true; correctableReads.add(_id);
          throw new Error("semantic_operation_history_input: supply contract=catalog/1, sourceUrn, assetUrn, optional fieldPath; later offset requires the SAME historyDigest; no request dispatched");
        }
        historyQuery = { offset: intent.offset ?? 0, digest: intent.historyDigest };
        // Recheck CURRENT Source/asset/field visibility at the actual Host,
        // without forwarding a journal selector, restoring or arming authority.
        intent.action = "inspect_asset"; delete intent.offset; delete intent.historyDigest;
      }
      if (["prepare_maintenance", "revise_maintenance"].includes(intent.action) && intent.gap !== undefined) {
        const gap = intent.gap;
        const badGap = (field: string, message: string): never => {
          correctableRead = true; correctableReads.add(_id);
          throw new Error(`semantic_maintenance_gap_input: ${field}: ${message}; no request dispatched; only the model supplies a new corrected input`);
        };
        if (!gap || typeof gap !== "object" || Array.isArray(gap)) badGap("gap", "expected an object");
        if (Object.keys(gap).some(key => !["code", "reason", "operation"].includes(key))) badGap("gap", "unexpected fields");
        if (typeof gap.reason !== "string" || gap.reason.length < 1 || gap.reason.length > 1024) badGap("gap.reason", "expected 1..1024 characters");
        if ([intent.candidates, intent.definition, intent.reason, intent.evidenceIds].some(value => value !== undefined))
          badGap("gap", "cannot coexist with candidates/definition/reason/evidenceIds");
        if (gap.code !== "UNRESOLVED_OPERATION") {
          if (Object.hasOwn(gap, "operation")) badGap("gap.operation", "ordinary evidence/impact GAP forbids an operation");
          if (!ordinaryGapCodes.some(code => code === gap.code)) badGap("gap.code", "unknown ordinary GAP code");
        } else {
          const operation = gap.operation;
          if (!operation || typeof operation !== "object" || Array.isArray(operation) ||
              Object.keys(operation).some(key => !["action", "maintenanceRunUrn", "requestId", "itemId"].includes(key)) ||
              !["prepare_maintenance", "revise_maintenance", "publish_maintenance_item"].includes(operation.action) ||
              typeof operation.maintenanceRunUrn !== "string" || !operation.maintenanceRunUrn.startsWith("urn:li:dataProcessInstance:semantic-") ||
              operation.maintenanceRunUrn.length > 1024 ||
              [operation.requestId, operation.itemId].some(value => value !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)))
            badGap("gap.operation", "UNRESOLVED_OPERATION requires original action/Root and only known optional UUIDs");
          const recorded = recordedOperations(ctx, intent).filter(ref => ref.operation.action === operation.action);
          const identified = recorded.filter(ref => operation.requestId ? ref.operation.requestId === operation.requestId :
            operation.itemId ? ref.operation.itemId === operation.itemId : true);
          if (recorded.length && (!identified.length || !identified.some(ref =>
              ref.operation.maintenanceRunUrn === operation.maintenanceRunUrn &&
              (!operation.requestId || ref.operation.requestId === operation.requestId) &&
              (!operation.itemId || ref.operation.itemId === operation.itemId))))
            badGap("gap.operation", "claimed original locator differs from this subject's recorded operation history; read_operation_history and choose the original, not current plan Root");
        }
      }
      const isItemReference = (value: unknown) => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "definitionItemId"));
      if (["prepare_maintenance", "revise_maintenance"].includes(intent.action) && intent.version === undefined &&
        (isItemReference(intent.definition?.parentUrn) || intent.candidates?.some(candidate =>
          isItemReference(candidate.value) || candidate.kind !== "property" && candidate.values?.some(isItemReference)))) {
        correctableRead = true; correctableReads.add(_id);
        throw new Error("semantic_maintenance_reference_version_required: explicitly supply the current Root runVersion when selecting native definition items; use the latest confirmed ACK, or read the original Root if unavailable/resync required, and correct this exact input; no request dispatched, no version inference.");
      }
      params = intent;
      reconciliation = { requestId, ...Object.fromEntries(
        ["maintenanceRunUrn", "cycleRunUrn", "runUrn", "decisionId", "itemId"].filter(
          key => typeof params[key as keyof typeof params] === "string",
        ).map(key => [key, params[key as keyof typeof params]]),
      ) };
      // A shared definition cites the Dataset schema, not a field Property
      // assignment. Retain its field locator; bind the inspected asset evidence.
      const definitionAnchor = intent.contract === "catalog/1" && intent.definition !== undefined;
      const cacheKey = inspectionKey(ctx.sessionManager.getSessionId(), definitionAnchor ? { ...intent, fieldPath: undefined } : intent);
      const inspected = inspections.get(cacheKey);
      if (intent.contract === "catalog/1" && (["prepare_maintenance", "revise_maintenance"].includes(intent.action) ||
        intent.action === "inspect_asset" && (intent.offset ?? 0) > 0)) {
        if (intent.snapshotDigest === undefined) {
          if (!inspected) {
            correctableRead = true; correctableReads.add(_id);
            throw new Error("semantic_inspection_required: inspect this exact asset/field/evidenceMode first; no request dispatched");
          }
          intent.snapshotDigest = inspected.digest;
        } else if (inspected && intent.snapshotDigest !== inspected.digest) {
          correctableRead = true; correctableReads.add(_id);
          throw new Error("semantic_inspection_binding_mismatch: use the matching inspect_asset context, not a vocabulary snapshot; no request dispatched");
        }
      }
      const writing = ["prepare_review", "prepare_managed", "start_managed_cycle", "link_managed_definition",
        "record_managed_exception", "finish_managed_cycle", ...maintenanceWrites].includes(params.action);
      const body = JSON.stringify({
        ...intent,
        requestId,
        ...(["prepare_review", "prepare_managed", "read_review"].includes(params.action) ? { responseMode: "receipt" } : {}),
        ...(["prepare_maintenance", "revise_maintenance"].includes(params.action) ? { responseMode: "incremental" } : {}),
        ...([
          "prepare_review",
          "prepare_managed",
          "start_managed_cycle",
          "link_managed_definition",
          "record_managed_exception",
          "finish_managed_cycle",
          ...maintenanceWrites, "continue_maintenance",
        ].includes(params.action)
          ? { sessionId: ctx.sessionManager.getSessionId() }
          : {}),
      });
      if (Buffer.byteLength(body) > 24000)
        throw new Error("semantic_request_too_large");
      // Existing Pi session journal, correlation only: not another business
      // store or authority. Keep the exact locator even if UI/ACK disappears.
      if (writing) pi.appendEntry("datahub-semantic.intent/1", {
        action: params.action, requestId, sessionId: ctx.sessionManager.getSessionId(),
        sourceUrn: params.sourceUrn, assetUrn: params.assetUrn, fieldPath: params.fieldPath ?? null, reconciliation,
        ...(params.gap?.code === "UNRESOLVED_OPERATION" ? { deferredObservation: true } : {}),
        dispatchIntentOnly: true, retryAllowed: false,
      });
      dispatched = true;
      // An input/tree reset during an awaited reply must not let that older
      // ACK certify a newly bound prompt, even on the same Root/session.
      const dispatchedRootBinding = boundRoot;
      const response = await ctx.ui.input("DataHub semantic request", body, {
        signal,
        timeout: [
          "link_managed_definition",
          "prepare_managed",
          "start_managed_cycle",
          "read_managed_cycle",
          "record_managed_exception",
          "finish_managed_cycle",
          ...maintenanceOperations,
        ].includes(params.action)
          ? 155000
          : 60000,
      });
      if (response === undefined)
        throw new Error("semantic_request_cancelled_or_unavailable");
      signal?.throwIfAborted();
      let value: Record<string, unknown>;
      try {
        if (Buffer.byteLength(response) > 524288) throw new Error();
        value = JSON.parse(response);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
      } catch {
        throw new Error("invalid_semantic_host_response");
      }
      if (value.error) {
        replyConfirmed = true;
        const error =
          typeof value.error === "string" && /^[a-z_]{1,80}$/.test(value.error)
            ? value.error
            : "semantic_request_rejected";
        if (writing && canCorrectMaintenanceInput(JSON.parse(body), value)) {
          correctableRead = true; correctableReads.add(_id);
          const details = { format: "datahub-semantic.error/1", action: params.action, requestId, error,
            inputRejection: value.inputRejection, correctionAllowed: true, retryAllowed: false,
            note: "Authenticated Host rejected THIS exact input before native writes. Correct the fields and generate a NEW intent in this SAME prompt. No SDK replay/repair, and no claim about older UNKNOWN effects." +
              ((value.inputRejection as Record<string, unknown>).issue === "semantic_maintenance_definition_reference_kind_mismatch"
                ? " Reference kind mismatch: each association must match candidate.kind; domain.parentUrn requires domain, node/term.parentUrn requires node (Glossary Group), not domain. Read the saved item's definition.kind and choose a NEW valid proposal; Host will not discard the parent or change business hierarchy for you."
                : "") };
          pi.appendEntry("datahub-semantic.input-rejection/1", details);
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        }
        // A write refusal without this exact proof remains effect-uncertain,
        // even if its name sounds like a parse error and it has no locator.
        if (writing && value.reconciliation === undefined)
          value.reconciliation = reconciliation;
        // Authenticated READ-only parse rejection is not an uncertain write or
        // runtime fault. The model may correct its own input in this SAME
        // prompt; the SDK never repairs, retries or refreshes a locator for it.
        correctableRead = !writing && (
          params.action === "inspect_asset" && error === "semantic_asset_type_unsupported" ||
          params.action === "inspect_definition" && error === "semantic_reference_not_found" ||
          ["list_assets", "inspect_asset", "search_vocabulary", "inspect_definition", "list_sources"].includes(params.action) &&
          ["invalid_semantic_catalog_request", "invalid_semantic_request"].includes(error));
        if (correctableRead) correctableReads.add(_id);
        else { traceForeground("host-error-stop", { action: params.action, error }); foreground = undefined; foregroundStopped = true; }
        if (
          [
            "prepare_review",
            "prepare_managed",
            "start_managed_cycle",
            "link_managed_definition",
            "record_managed_exception",
            "finish_managed_cycle",
            ...maintenanceWrites,
          ].includes(params.action) &&
          value.reconciliation &&
          typeof value.reconciliation === "object" &&
          !Array.isArray(value.reconciliation)
        ) {
          const ref = value.reconciliation as Record<string, unknown>;
          const reconciliation = Object.fromEntries(
            ["taskUrn", "runUrn", "decisionId", "maintenanceRunUrn", "requestId", "itemId"]
              .filter(
                (key) =>
                  typeof ref[key] === "string" &&
                  (ref[key] as string).length <= 1024,
              )
              .map((key) => [key, ref[key]]),
          );
          const details = {
            format: "datahub-semantic.error/1",
            action: params.action,
            requestId,
            error,
            reconciliation,
            retryAllowed: false,
            note: "Preparation is unconfirmed. Read these native records; do not repeat preparation or infer approval/publication.",
          };
          try { pi.appendEntry("datahub-semantic.unconfirmed/1", details); }
          finally { ctx.abort(); }
          ctx.ui.notify("原生準備結果未確認，已停止續作；請按保存的定位唯讀對帳，勿重播準備或發布。", "warning");
          return {
            content: [{ type: "text", text: JSON.stringify(details) }],
            details,
          };
        }
        // Bare error names do not prove a native-write boundary.
        // Format failures on READS have no mutation effect. Give bounded action
        // guidance without repairing parameters, retrying or echoing payloads.
        if (["invalid_semantic_catalog_request", "invalid_semantic_request"].includes(error) &&
          ["list_assets", "inspect_asset", "search_vocabulary", "inspect_source", "inspect_dataset", "list_sources"].includes(params.action)) {
          throw new Error(`${error}: Manual Catalog flow: list_sources takes only action (no contract). ` +
            "Then contract=catalog/1: list_assets(sourceUrn, optional offset; NO query/assetUrn), " +
            "inspect_asset(sourceUrn, assetUrn; later offset requires snapshotDigest), " +
            "search_vocabulary(sourceUrn, assetUrn, kind, query, optional start). " +
            "Use returned URNs; do not switch to legacy mode to bypass a malformed Catalog request. Legacy first inspect_dataset omits offset.");
        }
        // A missing native ancestor is not a supplied direct-URN typo. Stop
        // the same prompt/tool batch; do not let a new Root hide corrupt context.
        if (error === "semantic_definition_ancestor_not_found") ctx.abort();
        throw new Error(error);
      }
      const maintenanceFormat = params.action === "read_maintenance" && params.view !== undefined
        ? "datahub-semantic.maintenance-scope/1" : "datahub-semantic.maintenance/1";
      if (
        value.requestId !== requestId ||
        value.action !== params.action ||
        value.publicationAuthorized !== false ||
        (maintenanceOperations.includes(params.action) && params.action !== "start_maintenance" &&
          value.maintenanceRunUrn !== params.maintenanceRunUrn) ||
        (maintenanceOperations.includes(params.action) && value.delivery !== undefined && value.delivery !== "incremental") ||
        (value.delivery === "incremental" && (
          !["prepare_maintenance", "revise_maintenance"].includes(params.action) || value.state !== "DRAFT" ||
          value.preparedItemId !== requestId || !Array.isArray(value.items) || value.items.length !== 1 ||
          (value.items[0] as Record<string, unknown>)?.id !== requestId || value.offset !== 0 || value.nextOffset !== null ||
          !value.delta || typeof value.delta !== "object" || Array.isArray(value.delta) ||
          (value.delta as Record<string, unknown>).completePlan !== false ||
          typeof (value.delta as Record<string, unknown>).resyncRequired !== "boolean" ||
          typeof (value.delta as Record<string, unknown>).baseVersion !== "string" ||
          !/^[1-9][0-9]*$/.test(String((value.delta as Record<string, unknown>).baseVersion ?? "")) ||
          typeof value.runVersion !== "string" || !/^[1-9][0-9]*$/.test(value.runVersion) ||
          (params.version !== undefined && (value.delta as Record<string, unknown>).baseVersion !== params.version) ||
          BigInt(String(value.runVersion)) <= BigInt(String((value.delta as Record<string, unknown>).baseVersion)) ||
          (params.action === "revise_maintenance" && value.revisedItemId !== params.itemId))) ||
        (params.action === "reconcile_maintenance_start" &&
          (value.originalRequestId !== params.originalRequestId || value.sourceUrn !== params.sourceUrn ||
            value.effect !== "NOT_PROVEN" || value.retryAllowed !== false || value.readOnly !== true)) ||
        (params.action === "read_maintenance" && params.view !== undefined &&
          (value.view !== params.view || value.offset !== (params.offset ?? 0) ||
            params.version !== undefined && value.runVersion !== params.version)) ||
        !(params.action === "prepare_managed" && value.format === "datahub-semantic.managed-cycle/1") && value.format !==
          (params.action === "reconcile_maintenance_start" ? "datahub-semantic.start-reconciliation/1"
            : maintenanceOperations.includes(params.action)
            ? maintenanceFormat
            : [
            "start_managed_cycle",
            "read_managed_cycle",
            "link_managed_definition",
            "record_managed_exception",
            "finish_managed_cycle",
          ].includes(params.action)
            ? "datahub-semantic.managed-cycle/1"
            : params.action === "read_review_detail" ? "datahub-semantic.review-detail/1"
            : ["prepare_review", "prepare_managed", "read_review"].includes(
                  params.action,
                )
              ? "datahub-semantic.review/1"
              : "datahub-semantic.preview/1")
      ) {
        throw new Error("invalid_semantic_host_response");
      }
      replyConfirmed = true;
      if (intent.action === "inspect_asset" && intent.contract === "catalog/1") {
        if (value.assetUrn !== intent.assetUrn || typeof value.snapshotDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.snapshotDigest) || value.offset !== (intent.offset ?? 0) ||
          !(value.nextOffset === null || Number.isSafeInteger(value.nextOffset) && (value.nextOffset as number) > (intent.offset ?? 0)) ||
          (value.evidenceMode ?? undefined) !== intent.evidenceMode)
          throw new Error("invalid_semantic_inspection_response");
        const offset = intent.offset ?? 0;
        if (historyQuery) { /* ACL check only, never establish preparation evidence. */ }
        else if (offset === 0) inspections.set(cacheKey, { digest: value.snapshotDigest, nextOffset: value.nextOffset as number | null });
        else if (inspected && inspected.digest === value.snapshotDigest && inspected.nextOffset === offset) {
          inspected.nextOffset = value.nextOffset as number | null;
        } else inspections.delete(cacheKey);
      }
      if (maintenanceOperations.includes(params.action)) {
        if (["start_maintenance", "continue_maintenance"].includes(params.action) && value.state === "DRAFT" &&
          value.readOnly === false && typeof value.maintenanceRunUrn === "string")
          boundRoot = { runUrn: value.maintenanceRunUrn, sessionId: ctx.sessionManager.getSessionId(),
            ...(boundRoot?.runUrn === value.maintenanceRunUrn && boundRoot.sessionId === ctx.sessionManager.getSessionId() && boundRoot.ownMutationVersion
              ? { ownMutationVersion: boundRoot.ownMutationVersion } : {}),
            ...(typeof value.sourceUrn === "string" ? { sourceUrn: value.sourceUrn } : {}) };
        if (maintenanceWrites.includes(params.action) && boundRoot && boundRoot === dispatchedRootBinding && boundRoot.runUrn === value.maintenanceRunUrn &&
          boundRoot.sessionId === ctx.sessionManager.getSessionId() && value.state === "DRAFT" && value.readOnly === false &&
          typeof value.runVersion === "string" && /^[1-9][0-9]*$/.test(value.runVersion))
          boundRoot.ownMutationVersion = value.runVersion;
        if (value.state !== "DRAFT" || value.readOnly !== false) { traceForeground("native-state-stop", { action: params.action, draft: value.state === "DRAFT", writable: value.readOnly === false }); foreground = undefined; }
        else if (["start_maintenance", "continue_maintenance"].includes(params.action) && !foreground && !foregroundStopped &&
          (params.action !== "continue_maintenance" || value.foregroundPreparation === true) &&
          typeof value.maintenanceRunUrn === "string" && Number.isSafeInteger(value.totalItems)) {
          foreground = { runUrn: value.maintenanceRunUrn, sessionId: ctx.sessionManager.getSessionId(), lastCount: (value.totalRecordedItems ?? value.totalItems) as number };
          traceForeground("foreground-armed", { action: params.action });
        } else if (foreground && value.maintenanceRunUrn !== foreground.runUrn) { traceForeground("other-root-stop", { action: params.action }); foreground = undefined; }
      }
      if (historyQuery) {
        const operations = recordedOperations(ctx, intent), digest = operationHistoryDigest(operations);
        if (historyQuery.digest !== undefined && historyQuery.digest !== digest) {
          correctableRead = true; correctableReads.add(_id);
          throw new Error("semantic_operation_history_changed: restart at offset=0; never mix journal pages or infer effects");
        }
        if (historyQuery.offset > operations.length) {
          correctableRead = true; correctableReads.add(_id);
          throw new Error("semantic_operation_history_offset_invalid: restart at offset=0");
        }
        value = { format: "datahub-semantic.operation-history/1", action: "read_operation_history",
          requestId, sourceUrn: intent.sourceUrn, assetUrn: intent.assetUrn, ...(intent.fieldPath ? { fieldPath: intent.fieldPath } : {}),
          sessionId: ctx.sessionManager.getSessionId(), readOnly: true, diagnosticOnly: true, publicationAuthorized: false,
          historyDigest: digest, offset: historyQuery.offset, totalOperations: operations.length,
          nextOffset: historyQuery.offset + 20 < operations.length ? historyQuery.offset + 20 : null,
          operations: operations.slice(historyQuery.offset, historyQuery.offset + 20),
          locatorCoverage: operations.length ? "RECORDED_INTENTS_ONLY" : "NO_RECORDED_LOCATOR",
          note: "Original recorded request locators only, not an effects ledger. No records is NOT absence, zero effects, recovery, quarantine or replay authority. Missing IDs remain omitted." };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        details: value,
      };
      } catch (error) {
        if (!correctableRead) {
          traceForeground("execute-error-stop", { action: params.action, dispatched, replyConfirmed });
          foreground = undefined;
          foregroundStopped = true;
        }
        if (dispatched && !replyConfirmed) {
          const details = {
            format: "datahub-semantic.error/1", action: params.action, requestId,
            error: error instanceof Error && error.message === "invalid_semantic_host_response"
              ? error.message : "semantic_request_cancelled_or_unavailable",
            reconciliation, retryAllowed: false,
            note: "Host reply is unconfirmed. The current prompt is stopped. Read exact native records; a lost ACK is not proof of zero effects. Never repeat preparation.",
          };
          // Disarming foreground alone cannot stop the model's current tool
          // batch or its next turn. Public SDK abort stops that SAME prompt.
          try { pi.appendEntry("datahub-semantic.unconfirmed/1", details); }
          finally { ctx.abort(); }
          ctx.ui.notify("Host 回應未確認，已停止續作；請按保存的定位唯讀對帳，勿重播準備或發布。", "warning");
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        }
        throw error;
      }
    },
  });
  pi.registerTool(semanticTool);
}
