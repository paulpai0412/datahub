"use client";

import { useId, useMemo, useState } from "react";

type Evidence = { path: string; line: number; snapshotSha256?: string };
type FieldSource = { dataset: number; field: string };
type QueryCondition = {
  kind: string;
  expressionSha256: string;
  sources: FieldSource[];
  parameters: string[];
  predicateSemanticsVerified: false;
};
type FieldOrigin = {
  classification:
    | "SOURCE_FIELDS"
    | "DECLARED_GENERATED"
    | "CONSTANT"
    | "PRESERVED_EXISTING_VALUE"
    | "UNRESOLVED";
  sources: FieldSource[];
  conditionSources?: FieldSource[];
  conditionSet?: number;
  generationRefs: string[];
  operations: string[];
  runtimeVerified?: false;
  reason?: string;
};
type GenerationFact = Record<string, unknown> & {
  method:
    | "declared_calendar_range"
    | "sql_identity_declaration"
    | "sql_rowset_count_declaration";
};
type GraphNode = {
  id: string;
  label: string;
  status: string;
  evidence?: Evidence;
  schemaVersion?: string;
  conditions?: QueryCondition[];
  rowEffects?: string[];
} & (
  | {
      kind: "dataset";
      fields: { name: string; type: string; origin?: FieldOrigin }[];
    }
  | { kind: "sql"; fields?: [] }
);
type GraphEdge = {
  from: string | number;
  to: string | number;
  kind: "reads" | "writes";
  evidence: Evidence;
};
export type EtlPreview = {
  format:
    | "datahub-etl.preview/1"
    | "datahub-etl.preview/2"
    | "datahub-etl.preview/3";
  sourceId: string;
  snapshotSha256: string;
  stage: "ENTRYPOINT_SELECTION" | "CONNECTION_SELECTION" | "FIELD_ANALYSIS";
  complete: false;
  publicationAuthorized: false;
  observedAt?: string;
  manifest: {
    selection: string;
    snapshot: { files: { path: string; sha256: string; size_bytes: number }[] };
    excluded: { path: string; reason: string }[];
  };
  entrypoints: { path: string; name: string; line: number }[];
  connections: {
    connection_id: string;
    label: string;
    function: string;
    line: number;
    context_ids: string[];
  }[];
  scopeChoices: { id: string; database: string; env: string }[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    generations?: Record<string, GenerationFact>;
    conditionSets?: FieldSource[][];
  };
  workflow?: {
    flow: { name: string; urn: string | null; evidence: Evidence };
    jobs: {
      name: string;
      urn: string | null;
      evidence: Evidence;
      contexts: number[];
      reads: number[];
      writes: number[];
    }[];
    dependencies: {
      from: number;
      to: number;
      method: string;
      contextPairs: number[][];
    }[];
    controlContexts: number[];
    coverage: {
      contexts: number;
      ownedContexts: number;
      controlContexts: number;
      sqlOwnershipComplete: boolean;
    };
    blockers: { reason: string }[];
  };
  sourceCoverage?: {
    scope: "selected_python_entrypoint_sql_io";
    counts: Partial<
      Record<
        | "BOUND_SELECTED_WRITE"
        | "OUTSIDE_SELECTED_PYTHON_ENTRYPOINT"
        | "UNRESOLVED_SELECTED_SOURCE",
        number
      >
    >;
    complete: boolean;
    otherEntryPointsAndProvisioningExecuted: false;
  };
  relatedCoverage?: {
    views: number;
    viewFields: number;
    biQueries: number;
    biFields: number;
    nativePanels: number;
    complete: boolean;
    liveGrafanaVerified: false;
    ddlAppliedVerified: false;
  };
  nativePlan?: {
    compiled: boolean;
    aspectCount: number;
    nativeMergeRequired: boolean;
    publicationAuthorized: false;
    targets?: string[];
    changes?: { target: number; aspect: string; expectedVersion: string }[];
    unchanged?: { target: number; aspect: string }[];
    diffDigest?: string;
    trustedConsentRequired?: true;
  };
  coverage: {
    outputDenominatorEstablished: boolean;
    expectedOutputFields?: number;
    classifiedOutputFields?: number;
    unresolvedOutputFields?: number;
    fieldPartitionComplete?: boolean;
    runtimeValuesVerified?: false;
    sqlContexts?: number;
    writeSlots?: number;
    observedTargetSchemaFields?: number;
  };
  blockers: { reason: string; count?: number }[];
  sourceCandidateCount: number;
  sourceUnresolvedCount: number;
  sourceGaps?: {
    method: string;
    attributes: Record<string, unknown>;
    files: { path: string }[];
    candidates: {
      id: string;
      locations: { file: number; line: number; endLine: number | null }[];
    }[];
  }[];
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const evidence = (value: unknown): value is Evidence =>
  record(value) &&
  typeof value.path === "string" &&
  typeof value.line === "number" &&
  Number.isSafeInteger(value.line) &&
  value.line > 0 &&
  (value.snapshotSha256 === undefined ||
    typeof value.snapshotSha256 === "string");

/** Persisted tool details are data, not executable JSX or an approval envelope. */
export function isEtlPreview(value: unknown): value is EtlPreview {
  if (
    !record(value) ||
    ![
      "datahub-etl.preview/1",
      "datahub-etl.preview/2",
      "datahub-etl.preview/3",
    ].includes(String(value.format)) ||
    value.complete !== false ||
    value.publicationAuthorized !== false ||
    typeof value.sourceId !== "string" ||
    typeof value.snapshotSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.snapshotSha256) ||
    ![
      "ENTRYPOINT_SELECTION",
      "CONNECTION_SELECTION",
      "FIELD_ANALYSIS",
    ].includes(String(value.stage)) ||
    !record(value.manifest) ||
    typeof value.manifest.selection !== "string" ||
    !record(value.manifest.snapshot) ||
    !Array.isArray(value.manifest.snapshot.files) ||
    !Array.isArray(value.manifest.excluded) ||
    !Array.isArray(value.entrypoints) ||
    !Array.isArray(value.connections) ||
    !Array.isArray(value.scopeChoices) ||
    !Array.isArray(value.blockers) ||
    !record(value.graph) ||
    !Array.isArray(value.graph.nodes) ||
    !Array.isArray(value.graph.edges) ||
    !record(value.coverage) ||
    typeof value.coverage.outputDenominatorEstablished !== "boolean" ||
    typeof value.sourceCandidateCount !== "number" ||
    typeof value.sourceUnresolvedCount !== "number"
  )
    return false;
  if (
    !value.manifest.snapshot.files.every(
      (file: unknown) =>
        record(file) &&
        typeof file.path === "string" &&
        typeof file.sha256 === "string" &&
        typeof file.size_bytes === "number",
    ) ||
    !value.manifest.excluded.every(
      (item: unknown) =>
        record(item) &&
        typeof item.path === "string" &&
        typeof item.reason === "string",
    ) ||
    !value.entrypoints.every(
      (item: unknown) =>
        record(item) &&
        typeof item.path === "string" &&
        typeof item.name === "string" &&
        typeof item.line === "number",
    ) ||
    !value.connections.every(
      (item: unknown) =>
        record(item) &&
        typeof item.connection_id === "string" &&
        typeof item.label === "string" &&
        typeof item.function === "string" &&
        typeof item.line === "number" &&
        Array.isArray(item.context_ids) &&
        item.context_ids.every((id: unknown) => typeof id === "string"),
    ) ||
    !value.scopeChoices.every(
      (item: unknown) =>
        record(item) &&
        typeof item.id === "string" &&
        typeof item.database === "string" &&
        typeof item.env === "string",
    ) ||
    !value.blockers.every(
      (item: unknown) =>
        record(item) &&
        typeof item.reason === "string" &&
        (item.count === undefined || typeof item.count === "number"),
    )
  )
    return false;
  const sourcePaths = new Set(
    value.manifest.snapshot.files.map((file: { path: string }) => file.path),
  );
  const boundEvidence = (point: unknown) =>
    evidence(point) &&
    sourcePaths.has(point.path) &&
    (point.snapshotSha256 === undefined ||
      point.snapshotSha256 === value.snapshotSha256);
  if (value.sourceGaps !== undefined) {
    if (!Array.isArray(value.sourceGaps)) return false;
    const candidates = new Set<string>();
    for (const group of value.sourceGaps) {
      if (
        !record(group) ||
        typeof group.method !== "string" ||
        !record(group.attributes) ||
        !Array.isArray(group.files) ||
        !group.files.every(
          (file: unknown) =>
            record(file) &&
            typeof file.path === "string" &&
            sourcePaths.has(file.path),
        ) ||
        !Array.isArray(group.candidates)
      )
        return false;
      for (const candidate of group.candidates) {
        if (
          !record(candidate) ||
          typeof candidate.id !== "string" ||
          candidates.has(candidate.id) ||
          !Array.isArray(candidate.locations)
        )
          return false;
        candidates.add(candidate.id);
        const fileCount = group.files.length;
        if (
          !candidate.locations.every(
            (point: unknown) =>
              record(point) &&
              typeof point.file === "number" &&
              Number.isSafeInteger(point.file) &&
              point.file >= 0 &&
              point.file < fileCount &&
              typeof point.line === "number" &&
              Number.isSafeInteger(point.line) &&
              point.line > 0 &&
              (point.endLine === null ||
                (typeof point.endLine === "number" &&
                  Number.isSafeInteger(point.endLine) &&
                  point.endLine >= point.line)),
          )
        )
          return false;
      }
    }
    if (candidates.size !== value.sourceUnresolvedCount) return false;
  }
  if (
    !value.graph.nodes.every(
      (node: unknown) =>
        record(node) &&
        typeof node.id === "string" &&
        ["dataset", "sql"].includes(String(node.kind)) &&
        typeof node.label === "string" &&
        typeof node.status === "string" &&
        (node.kind === "sql"
          ? node.fields === undefined ||
            (Array.isArray(node.fields) && node.fields.length === 0)
          : Array.isArray(node.fields) &&
            node.fields.every(
              (field: unknown) =>
                record(field) &&
                typeof field.name === "string" &&
                typeof field.type === "string",
            )) &&
        (node.evidence === undefined || boundEvidence(node.evidence)) &&
        (node.schemaVersion === undefined ||
          typeof node.schemaVersion === "string"),
    )
  )
    return false;
  const graphNodes = value.graph.nodes as GraphNode[];
  const ids = new Set(graphNodes.map((node) => node.id));
  const fields = new Map(
    graphNodes
      .filter((node) => node.kind === "dataset")
      .map((node) => [
        node.id,
        new Set(node.fields.map((field) => field.name)),
      ]),
  );
  const generations = value.graph.generations ?? {};
  if (
    !record(generations) ||
    !Object.values(generations).every(
      (fact) =>
        record(fact) &&
        [
          "declared_calendar_range",
          "sql_identity_declaration",
          "sql_rowset_count_declaration",
        ].includes(String(fact.method)),
    )
  )
    return false;
  const source = (item: unknown) =>
    record(item) &&
    typeof item.dataset === "number" &&
    Number.isSafeInteger(item.dataset) &&
    item.dataset >= 0 &&
    item.dataset < graphNodes.length &&
    typeof item.field === "string" &&
    fields.get(graphNodes[item.dataset].id)?.has(item.field) === true;
  const conditionSets = value.graph.conditionSets;
  if (
    value.format === "datahub-etl.preview/3" &&
    value.stage === "FIELD_ANALYSIS" &&
    (!Array.isArray(conditionSets) ||
      !conditionSets.every(
        (set: unknown) => Array.isArray(set) && set.every(source),
      ))
  )
    return false;
  const index = (item: unknown, kind?: GraphNode["kind"]): item is number =>
    typeof item === "number" &&
    Number.isSafeInteger(item) &&
    item >= 0 &&
    item < graphNodes.length &&
    (kind === undefined || graphNodes[item].kind === kind);
  if (value.sourceCoverage !== undefined) {
    const coverage = value.sourceCoverage;
    if (
      !record(coverage) ||
      coverage.scope !== "selected_python_entrypoint_sql_io" ||
      typeof coverage.complete !== "boolean" ||
      coverage.otherEntryPointsAndProvisioningExecuted !== false ||
      !record(coverage.counts)
    )
      return false;
    const entries = Object.entries(coverage.counts);
    if (
      entries.some(
        ([key, count]) =>
          ![
            "BOUND_SELECTED_WRITE",
            "OUTSIDE_SELECTED_PYTHON_ENTRYPOINT",
            "UNRESOLVED_SELECTED_SOURCE",
          ].includes(key) ||
          !Number.isSafeInteger(count) ||
          (count as number) < 0,
      ) ||
      entries.reduce((sum, [, count]) => sum + (count as number), 0) !==
        value.sourceUnresolvedCount
    )
      return false;
  }
  if (value.relatedCoverage !== undefined) {
    const coverage = value.relatedCoverage;
    if (
      !record(coverage) ||
      typeof coverage.complete !== "boolean" ||
      coverage.liveGrafanaVerified !== false ||
      coverage.ddlAppliedVerified !== false ||
      ["views", "viewFields", "biQueries", "biFields", "nativePanels"].some(
        (key) =>
          !Number.isSafeInteger(coverage[key]) || (coverage[key] as number) < 0,
      ) ||
      (coverage.nativePanels as number) > (coverage.biQueries as number)
    )
      return false;
  }
  if (value.workflow !== undefined) {
    const w = value.workflow;
    if (
      !record(w) ||
      !record(w.flow) ||
      typeof w.flow.name !== "string" ||
      !boundEvidence(w.flow.evidence) ||
      !(
        w.flow.urn === null ||
        (typeof w.flow.urn === "string" &&
          w.flow.urn.startsWith("urn:li:dataFlow:"))
      ) ||
      !Array.isArray(w.jobs) ||
      !w.jobs.every(
        (job: unknown) =>
          record(job) &&
          typeof job.name === "string" &&
          boundEvidence(job.evidence) &&
          (job.urn === null ||
            (typeof job.urn === "string" &&
              job.urn.startsWith("urn:li:dataJob:"))) &&
          Array.isArray(job.contexts) &&
          job.contexts.every((i) => index(i, "sql")) &&
          Array.isArray(job.reads) &&
          job.reads.every((i) => index(i, "dataset")) &&
          Array.isArray(job.writes) &&
          job.writes.every((i) => index(i, "dataset")),
      ) ||
      !Array.isArray(w.controlContexts) ||
      !w.controlContexts.every((i) => index(i, "sql")) ||
      !record(w.coverage) ||
      typeof w.coverage.sqlOwnershipComplete !== "boolean" ||
      !Array.isArray(w.blockers) ||
      !w.blockers.every((b) => record(b) && typeof b.reason === "string") ||
      !Array.isArray(w.dependencies)
    )
      return false;
    const jobs = w.jobs;
    if (
      !w.dependencies.every(
        (d) =>
          record(d) &&
          Number.isSafeInteger(d.from) &&
          Number.isSafeInteger(d.to) &&
          typeof d.from === "number" &&
          d.from >= 0 &&
          d.from < jobs.length &&
          typeof d.to === "number" &&
          d.to >= 0 &&
          d.to < jobs.length &&
          typeof d.method === "string" &&
          Array.isArray(d.contextPairs) &&
          d.contextPairs.every(
            (pair) =>
              Array.isArray(pair) &&
              pair.length === 2 &&
              pair.every((i) => index(i, "sql")),
          ),
      )
    )
      return false;
  }
  if (value.nativePlan !== undefined) {
    const plan = value.nativePlan;
    if (
      !record(plan) ||
      typeof plan.compiled !== "boolean" ||
      typeof plan.aspectCount !== "number" ||
      !Number.isSafeInteger(plan.aspectCount) ||
      plan.aspectCount < 0 ||
      typeof plan.nativeMergeRequired !== "boolean" ||
      plan.publicationAuthorized !== false
    )
      return false;
    if (plan.nativeMergeRequired === false) {
      if (
        !Array.isArray(plan.targets) ||
        !plan.targets.every(
          (urn) =>
            typeof urn === "string" &&
            /^urn:li:(dataFlow|dataJob|dataset):/.test(urn),
        ) ||
        typeof plan.diffDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(plan.diffDigest) ||
        plan.trustedConsentRequired !== true ||
        !Array.isArray(plan.changes) ||
        !Array.isArray(plan.unchanged)
      )
        return false;
      const targets = plan.targets;
      const target = (item: unknown) =>
        record(item) &&
        typeof item.target === "number" &&
        Number.isSafeInteger(item.target) &&
        item.target >= 0 &&
        item.target < targets.length &&
        typeof item.aspect === "string";
      if (
        !plan.unchanged.every(target) ||
        !plan.changes.every(
          (item) =>
            target(item) &&
            typeof item.expectedVersion === "string" &&
            /^(?:-1|[1-9][0-9]*)$/.test(item.expectedVersion),
        )
      )
        return false;
    }
  }
  for (const node of graphNodes) {
    if (
      node.rowEffects !== undefined &&
      (!Array.isArray(node.rowEffects) ||
        !node.rowEffects.every((effect) => effect === "DELETE_ALL_ROWS"))
    )
      return false;
    if (
      node.conditions !== undefined &&
      (!Array.isArray(node.conditions) ||
        !node.conditions.every(
          (clause: unknown) =>
            record(clause) &&
            typeof clause.kind === "string" &&
            typeof clause.expressionSha256 === "string" &&
            /^[a-f0-9]{64}$/.test(clause.expressionSha256) &&
            clause.predicateSemanticsVerified === false &&
            Array.isArray(clause.sources) &&
            clause.sources.every(source) &&
            Array.isArray(clause.parameters) &&
            clause.parameters.every(
              (name: unknown) => typeof name === "string",
            ),
        ))
    )
      return false;
    for (const field of node.fields ?? []) {
      const origin: unknown = field.origin;
      if (origin === undefined) continue;
      if (
        !record(origin) ||
        !(
          origin.runtimeVerified === false ||
          (origin.runtimeVerified === undefined &&
            value.coverage.runtimeValuesVerified === false)
        ) ||
        ![
          "SOURCE_FIELDS",
          "DECLARED_GENERATED",
          "CONSTANT",
          "PRESERVED_EXISTING_VALUE",
          "UNRESOLVED",
        ].includes(String(origin.classification)) ||
        !Array.isArray(origin.sources) ||
        !origin.sources.every(source) ||
        !(value.format === "datahub-etl.preview/3"
          ? origin.conditionSources === undefined &&
            Array.isArray(conditionSets) &&
            typeof origin.conditionSet === "number" &&
            Number.isSafeInteger(origin.conditionSet) &&
            origin.conditionSet >= 0 &&
            origin.conditionSet < conditionSets.length
          : Array.isArray(origin.conditionSources) &&
            origin.conditionSources.every(source)) ||
        !Array.isArray(origin.generationRefs) ||
        !origin.generationRefs.every(
          (id: unknown) =>
            typeof id === "string" && Object.hasOwn(generations, id),
        ) ||
        !Array.isArray(origin.operations) ||
        !origin.operations.every((name: unknown) => typeof name === "string") ||
        (origin.reason !== undefined && typeof origin.reason !== "string")
      )
        return false;
    }
  }
  if (value.coverage.outputDenominatorEstablished) {
    const expected = value.coverage.expectedOutputFields;
    const classified = value.coverage.classifiedOutputFields;
    const unresolved = value.coverage.unresolvedOutputFields;
    if (
      typeof expected !== "number" ||
      typeof classified !== "number" ||
      typeof unresolved !== "number" ||
      ![expected, classified, unresolved].every(
        (count) => Number.isSafeInteger(count) && count >= 0,
      ) ||
      expected !== classified + unresolved ||
      typeof value.coverage.fieldPartitionComplete !== "boolean"
    )
      return false;
    const outputs = graphNodes.flatMap((node) =>
      (node.fields ?? []).filter((field) => field.origin),
    );
    if (
      outputs.length !== expected ||
      outputs.filter((field) => field.origin?.classification === "UNRESOLVED")
        .length !== unresolved ||
      (value.coverage.fieldPartitionComplete && unresolved !== 0)
    )
      return false;
  }
  const endpoint = (point: unknown) =>
    value.format === "datahub-etl.preview/1"
      ? typeof point === "string" && ids.has(point)
      : typeof point === "number" &&
        Number.isSafeInteger(point) &&
        point >= 0 &&
        point < graphNodes.length;
  return (
    ids.size === value.graph.nodes.length &&
    value.graph.edges.every(
      (edge: unknown) =>
        record(edge) &&
        endpoint(edge.from) &&
        endpoint(edge.to) &&
        ["reads", "writes"].includes(String(edge.kind)) &&
        boundEvidence(edge.evidence),
    )
  );
}

/** A bounded neighbourhood view: every line comes from a Host-bound SQL I/O edge. */
export function DataHubEtlPreview({ preview }: { preview: EtlPreview }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const arrow = useId();
  const nodes = preview.graph.nodes;
  const edges = useMemo(
    () =>
      preview.graph.edges.map((edge) => ({
        ...edge,
        from: typeof edge.from === "number" ? nodes[edge.from].id : edge.from,
        to: typeof edge.to === "number" ? nodes[edge.to].id : edge.to,
      })),
    [preview.graph.edges, nodes],
  );
  const byId = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const selected = selectedId
    ? byId.get(selectedId)
    : (nodes.find(
        (node) =>
          node.kind === "dataset" && node.fields.some((field) => field.origin),
      ) ?? nodes[0]);
  const incoming = selected
    ? edges.filter((edge) => edge.to === selected.id)
    : [];
  const outgoing = selected
    ? edges.filter((edge) => edge.from === selected.id)
    : [];
  const left = [...new Set(incoming.map((edge) => edge.from))];
  const right = [...new Set(outgoing.map((edge) => edge.to))];
  const height = Math.max(220, Math.max(left.length, right.length) * 80 + 50);
  const box = {
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: 12,
  };
  const button = {
    border: "1px solid var(--border)",
    borderRadius: 5,
    background: "var(--bg-panel)",
    color: "var(--text)",
    padding: "5px 10px",
    cursor: "pointer",
  };
  const drawNode = (id: string, x: number, y: number) => {
    const node = byId.get(id);
    if (!node) return null; // Edges are validated above; no inferred replacement node.
    const title = node.kind === "dataset" ? "Dataset" : "SQL 使用";
    return (
      <g
        key={`${x}:${id}`}
        role="button"
        tabIndex={0}
        aria-label={`${title}: ${node.label}`}
        onClick={() => setSelectedId(id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setSelectedId(id);
          }
        }}
        style={{ cursor: "pointer" }}
      >
        <title>{node.label}</title>
        <rect
          x={x}
          y={y - 29}
          width={230}
          height={58}
          rx={7}
          fill="var(--bg-panel)"
          stroke={id === selected?.id ? "var(--accent)" : "var(--border)"}
          strokeWidth={2}
        />
        <text x={x + 12} y={y - 8} fill="var(--text-muted)" fontSize={11}>
          {title}
        </text>
        <text x={x + 12} y={y + 13} fill="var(--text)" fontSize={12}>
          {node.label.length > 31 ? `${node.label.slice(0, 28)}…` : node.label}
        </text>
      </g>
    );
  };
  return (
    <section
      aria-label="datahub_etl 分析預覽"
      style={{
        ...box,
        background: "var(--bg-panel)",
        margin: "8px 0",
        color: "var(--text)",
      }}
    >
      <header
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "baseline",
        }}
      >
        <strong>datahub_etl</strong>
        <span>分析預覽 · 未匯入 · INCONCLUSIVE</span>
      </header>
      <p style={{ overflowWrap: "anywhere" }}>{preview.manifest.selection}</p>
      <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
        {preview.observedAt
          ? `觀測時間：${preview.observedAt}。`
          : "此結果未提供觀測時間。"}
        儲存的分析快照，不是目前授權或原生匯入讀回；不代表執行過 ETL。
      </p>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span>來源檔案 {preview.manifest.snapshot.files.length}</span>
        <span>來源未解項 {preview.sourceUnresolvedCount}</span>
        {preview.coverage.sqlContexts !== undefined && (
          <span>SQL contexts {preview.coverage.sqlContexts}</span>
        )}
        {preview.coverage.observedTargetSchemaFields !== undefined && (
          <span>
            觀測到的目標 schema 欄位{" "}
            {preview.coverage.observedTargetSchemaFields}
          </span>
        )}
      </div>
      <p>
        {preview.coverage.outputDenominatorEstablished
          ? `指定入口目標欄位：${preview.coverage.classifiedOutputFields} / ${preview.coverage.expectedOutputFields} 已有來源或生成宣告；未解 ${preview.coverage.unresolvedOutputFields}。這不是整體匯入完成或執行期驗證。`
          : "輸出完整性分母尚未成立；不以已解析子集顯示完成率。"}
      </p>
      {preview.sourceCoverage && (
        <p className="etl-scope-coverage">
          選定入口掃描對帳：
          {preview.sourceCoverage.counts.BOUND_SELECTED_WRITE ?? 0} 項已綁定 SQL
          寫入；
          {preview.sourceCoverage.counts.OUTSIDE_SELECTED_PYTHON_ENTRYPOINT ??
            0}{" "}
          項不屬於此 Python 入口；
          {preview.sourceCoverage.counts.UNRESOLVED_SELECTED_SOURCE ?? 0}{" "}
          項仍未解。 原始掃描項目全部保留，其他入口及 provisioning 並未執行。
        </p>
      )}
      {preview.relatedCoverage && (
        <p className="etl-related-coverage">
          相關宣告：{preview.relatedCoverage.views} 個 view／
          {preview.relatedCoverage.viewFields} 個欄位；
          {preview.relatedCoverage.biQueries} 個 BI 查詢／
          {preview.relatedCoverage.biFields} 個輸出；
          {preview.relatedCoverage.nativePanels} 個 panel 的原生查詢 schema 與
          lineage 已核對。
          {preview.relatedCoverage.complete
            ? " 宣告綁定完整。"
            : " 仍有宣告缺口。"}
          這不是 DDL 或 Grafana 查詢執行驗證。
        </p>
      )}
      {preview.workflow && (
        <section
          aria-label="DataFlow 與 DataJobs 預覽"
          style={{ ...box, marginBottom: 12 }}
        >
          <h4>DataFlow · {preview.workflow.flow.name}</h4>
          <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
            來源宣告的處理步驟，並非已執行或已發布的工作。
            {preview.nativePlan?.compiled &&
              ` 已編譯 ${preview.nativePlan.aspectCount} 個原生 Aspect 候選，${preview.nativePlan.nativeMergeRequired ? "仍需合併原生差異" : "已讀取原生版本並準備保留式差異"}；尚未核准或發布。`}
          </p>
          <ol style={{ display: "grid", gap: 12, paddingLeft: 24 }}>
            {preview.workflow.jobs.map((job, jobIndex) => (
              <li key={job.urn ?? `${job.name}:${jobIndex}`} style={box}>
                <strong>{job.name}</strong>
                <p style={{ fontSize: 12 }}>
                  {job.evidence.path}:{job.evidence.line}
                </p>
                {(["reads", "writes"] as const).map((side) => (
                  <div
                    key={side}
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      marginTop: 6,
                    }}
                  >
                    <span>{side === "reads" ? "輸入 →" : "→ 輸出"}</span>
                    {job[side].length === 0 && <span>無</span>}
                    {job[side].map((index) => (
                      <button
                        key={index}
                        type="button"
                        style={button}
                        onClick={() => setSelectedId(nodes[index].id)}
                      >
                        {nodes[index].label}
                      </button>
                    ))}
                  </div>
                ))}
                <details style={{ marginTop: 8 }}>
                  <summary>
                    SQL 使用與步驟相依（{job.contexts.length} 個 SQL contexts）
                  </summary>
                  <ul>
                    {job.contexts.map((index) => (
                      <li key={index}>
                        <button
                          type="button"
                          style={button}
                          onClick={() => setSelectedId(nodes[index].id)}
                        >
                          {nodes[index].label}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <ul>
                    {preview
                      .workflow!.dependencies.filter((d) => d.to === jobIndex)
                      .map((d, i) => (
                        <li key={i}>
                          {preview.workflow!.jobs[d.from].name} → {job.name} ·{" "}
                          {d.method}
                        </li>
                      ))}
                  </ul>
                  <p style={{ overflowWrap: "anywhere", fontSize: 11 }}>
                    候選 URN：{job.urn ?? "尚未編譯"}
                  </p>
                </details>
              </li>
            ))}
          </ol>
          <p>
            控制用 SQL：{preview.workflow.controlContexts.length}；SQL 主責範圍
            {preview.workflow.coverage.sqlOwnershipComplete
              ? "已覆蓋"
              : "仍有缺口"}
            。
          </p>
        </section>
      )}
      {preview.nativePlan?.nativeMergeRequired === false && (
        <details open style={{ ...box, marginBottom: 12 }}>
          <summary>
            原生匯入差異：{preview.nativePlan.changes!.length} 項變更、
            {preview.nativePlan.unchanged!.length} 項不變（未寫入）
          </summary>
          <p>
            依 DataHub
            當次讀取版本準備。Schema、描述及既有無關關係不覆寫；版本漂移必須重新預覽。仍需完成來源範圍核對與可信確認。
          </p>
          <div style={{ overflow: "auto" }}>
            <table style={{ width: "100%", textAlign: "left" }}>
              <thead>
                <tr>
                  <th>動作</th>
                  <th>原生資產</th>
                  <th>Aspect</th>
                  <th>預期版本</th>
                </tr>
              </thead>
              <tbody>
                {preview.nativePlan.changes!.map((item) => (
                  <tr key={`${item.target}:${item.aspect}`}>
                    <td>
                      {item.expectedVersion === "-1"
                        ? "新增"
                        : "更新／保留既有內容"}
                    </td>
                    <td style={{ overflowWrap: "anywhere" }}>
                      {preview.nativePlan!.targets![item.target]}
                    </td>
                    <td>{item.aspect}</td>
                    <td>
                      {item.expectedVersion === "-1"
                        ? "尚不存在"
                        : item.expectedVersion}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 11, overflowWrap: "anywhere" }}>
            差異 digest：{preview.nativePlan.diffDigest}
          </p>
        </details>
      )}
      {nodes.length > 0 && (
        <>
          <h4>SQL I/O 關係預覽</h4>
          <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
            點選節點查看相鄰關係與 schema。SQL 使用節點不是
            DataJob；這不是完整欄位 lineage。
          </p>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <input
              aria-label="搜尋 ETL 節點"
              placeholder="搜尋資料表或 SQL 位置"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              style={{ ...button, cursor: "text" }}
            />
            <select
              aria-label="選擇關係圖中心節點"
              value={selected?.id ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
              style={{ ...button, maxWidth: "100%" }}
            >
              {nodes
                .filter(
                  (node) =>
                    node.id === selected?.id ||
                    node.label.toLowerCase().includes(query.toLowerCase()),
                )
                .map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.kind === "dataset" ? "Dataset" : "SQL"} · {node.label}
                  </option>
                ))}
            </select>
            <button
              type="button"
              style={button}
              aria-label="縮小關係圖"
              disabled={zoom <= 0.5}
              onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
            >
              −
            </button>
            <button
              type="button"
              style={button}
              aria-label="放大關係圖"
              disabled={zoom >= 2}
              onClick={() => setZoom((value) => Math.min(2, value + 0.25))}
            >
              ＋
            </button>
            <button type="button" style={button} onClick={() => setZoom(1)}>
              重設縮放
            </button>
          </div>
          <div
            style={{ overflow: "auto", maxHeight: 460, marginTop: 12, ...box }}
          >
            <svg
              width={870 * zoom}
              height={height * zoom}
              viewBox={`0 0 870 ${height}`}
              role="group"
              aria-label="所選節點的輸入與輸出關係"
            >
              <defs>
                <marker
                  id={arrow}
                  markerWidth={8}
                  markerHeight={8}
                  refX={7}
                  refY={4}
                  orient="auto"
                >
                  <path d="M0 0 L8 4 L0 8 Z" fill="var(--accent)" />
                </marker>
              </defs>
              {incoming.map((edge) => (
                <path
                  key={`${edge.from}:${edge.kind}`}
                  d={`M250 ${50 + left.indexOf(edge.from) * 80} C295 ${50 + left.indexOf(edge.from) * 80}, 295 ${height / 2}, 320 ${height / 2}`}
                  fill="none"
                  stroke="var(--accent)"
                  markerEnd={`url(#${arrow})`}
                >
                  <title>{`${edge.kind} · ${edge.evidence.path}:${edge.evidence.line}`}</title>
                </path>
              ))}
              {outgoing.map((edge) => (
                <path
                  key={`${edge.to}:${edge.kind}`}
                  d={`M550 ${height / 2} C580 ${height / 2}, 580 ${50 + right.indexOf(edge.to) * 80}, 610 ${50 + right.indexOf(edge.to) * 80}`}
                  fill="none"
                  stroke="var(--accent)"
                  markerEnd={`url(#${arrow})`}
                >
                  <title>{`${edge.kind} · ${edge.evidence.path}:${edge.evidence.line}`}</title>
                </path>
              ))}
              {left.map((id, index) => drawNode(id, 20, 50 + index * 80))}
              {selected && drawNode(selected.id, 320, height / 2)}
              {right.map((id, index) => drawNode(id, 610, 50 + index * 80))}
            </svg>
          </div>
          {selected && (
            <div style={{ ...box, marginTop: 8, overflowWrap: "anywhere" }}>
              <strong>{selected.label}</strong>
              <p>
                {selected.status}
                {selected.schemaVersion
                  ? ` · schema version ${selected.schemaVersion}`
                  : ""}
              </p>
              {selected.evidence && (
                <p>
                  程式依據：{selected.evidence.path}:{selected.evidence.line}
                </p>
              )}
              {!!selected.rowEffects?.length && (
                <p>
                  資料列操作宣告：{selected.rowEffects.join("、")}
                  （僅分析，未執行）
                </p>
              )}
              {!!selected.conditions?.length && (
                <details>
                  <summary>
                    SQL 選取／排序條件依據（{selected.conditions.length}）
                  </summary>
                  <p>
                    條件欄位不是值來源；不代表 predicate 語義或業務 Join
                    已核准。SQL 文字／literal 不輸出。
                  </p>
                  {selected.conditions.map((clause, index) => (
                    <div
                      key={`${clause.expressionSha256}:${index}`}
                      style={box}
                    >
                      <strong>{clause.kind}</strong>
                      <ul>
                        {clause.sources.map((source) => (
                          <li key={`${source.dataset}:${source.field}`}>
                            {nodes[source.dataset].label} · {source.field}
                          </li>
                        ))}
                      </ul>
                      {clause.parameters.length > 0 && (
                        <p>
                          參數名稱：{clause.parameters.join("、")}（值未驗證）
                        </p>
                      )}
                      <p>AST digest：{clause.expressionSha256}</p>
                    </div>
                  ))}
                </details>
              )}
              {selected.kind === "dataset" && selected.fields.length > 0 && (
                <details>
                  <summary>
                    Catalog schema：{selected.fields.length}{" "}
                    個欄位（不代表來源已解析）
                  </summary>
                  <table style={{ width: "100%", textAlign: "left" }}>
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>Native type</th>
                        <th>值來源／生成宣告</th>
                        <th>選取條件（非值來源）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.fields.map((field) => (
                        <tr key={field.name}>
                          <td>{field.name}</td>
                          <td>{field.type}</td>
                          <td style={{ overflowWrap: "anywhere" }}>
                            {field.origin ? (
                              <>
                                <strong>{field.origin.classification}</strong>
                                {field.origin.sources.map((source) => (
                                  <p key={`${source.dataset}:${source.field}`}>
                                    <button
                                      type="button"
                                      style={button}
                                      onClick={() =>
                                        setSelectedId(nodes[source.dataset].id)
                                      }
                                    >
                                      {nodes[source.dataset].label} ·{" "}
                                      {source.field}
                                    </button>
                                  </p>
                                ))}
                                {field.origin.operations.length > 0 && (
                                  <p>{field.origin.operations.join(" → ")}</p>
                                )}
                                {field.origin.generationRefs.map(
                                  (reference) => (
                                    <details key={reference}>
                                      <summary>
                                        生成宣告／參數邊界（未執行）
                                      </summary>
                                      <pre
                                        style={{
                                          whiteSpace: "pre-wrap",
                                          fontSize: 11,
                                        }}
                                      >
                                        {JSON.stringify(
                                          preview.graph.generations?.[
                                            reference
                                          ],
                                          null,
                                          2,
                                        )}
                                      </pre>
                                    </details>
                                  ),
                                )}
                                {field.origin.reason && (
                                  <p>{field.origin.reason}</p>
                                )}
                              </>
                            ) : (
                              "非本入口寫入欄位／僅 Catalog schema"
                            )}
                          </td>
                          <td>
                            {(field.origin
                              ? preview.format === "datahub-etl.preview/3"
                                ? preview.graph.conditionSets![
                                    field.origin.conditionSet!
                                  ]
                                : field.origin.conditionSources!
                              : []
                            ).map((source) => (
                              <p key={`${source.dataset}:${source.field}`}>
                                {nodes[source.dataset].label} · {source.field}
                              </p>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          )}
          <details style={{ marginTop: 8 }}>
            <summary>全部關係的表格檢視（{edges.length}）</summary>
            <div style={{ overflow: "auto", maxHeight: 360 }}>
              <table style={{ textAlign: "left", width: "100%" }}>
                <thead>
                  <tr>
                    <th>From</th>
                    <th>關係</th>
                    <th>To</th>
                    <th>依據</th>
                  </tr>
                </thead>
                <tbody>
                  {edges.map((edge) => (
                    <tr key={`${edge.from}:${edge.to}:${edge.kind}`}>
                      <td>{byId.get(edge.from)?.label}</td>
                      <td>{edge.kind}</td>
                      <td>{byId.get(edge.to)?.label}</td>
                      <td>
                        {edge.evidence.path}:{edge.evidence.line}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      {preview.stage === "ENTRYPOINT_SELECTION" && (
        <details open>
          <summary>可追蹤入口</summary>
          <ul>
            {preview.entrypoints.map((entry) => (
              <li key={`${entry.path}:${entry.name}`}>
                {entry.path}:{entry.line} — {entry.name}
              </li>
            ))}
          </ul>
        </details>
      )}
      {preview.stage === "CONNECTION_SELECTION" && (
        <div style={box}>
          <strong>連線來源待確認</strong>
          <ul>
            {preview.connections.map((connection) => (
              <li key={connection.connection_id}>
                {connection.label} · {connection.function}:{connection.line} ·{" "}
                {connection.context_ids.length} SQL contexts
              </li>
            ))}
          </ul>
          <p>
            可選 Catalog 範圍：
            {preview.scopeChoices
              .map((scope) => `${scope.database} (${scope.env})`)
              .join("、") || "Host 尚未設定"}
          </p>
        </div>
      )}
      <details open style={{ marginTop: 12 }}>
        <summary>阻礙匯入的缺口</summary>
        <ul>
          {preview.blockers.map((blocker, index) => (
            <li key={`${blocker.reason}:${index}`}>
              {blocker.reason}
              {blocker.count === undefined ? "" : ` × ${blocker.count}`}
            </li>
          ))}
        </ul>
      </details>
      {preview.sourceGaps && (
        <details>
          <summary>全部來源未解項（{preview.sourceUnresolvedCount}）</summary>
          <p>
            按相同來源／原因分組，未省略候選。欄位分區成功不會消除這些缺口。
          </p>
          {preview.sourceGaps.map((group, index) => (
            <details key={index}>
              <summary>
                {group.method} ·{" "}
                {String(
                  group.attributes.issue ?? group.attributes.reason ?? "未解",
                )}{" "}
                · {group.candidates.length} 項
              </summary>
              <pre style={{ whiteSpace: "pre-wrap" }}>
                {JSON.stringify(group.attributes, null, 2)}
              </pre>
              <ul>
                {group.candidates.map((candidate) => (
                  <li key={candidate.id} style={{ overflowWrap: "anywhere" }}>
                    {candidate.id} —{" "}
                    {candidate.locations
                      .map(
                        (point) =>
                          `${group.files[point.file].path}:${point.line}${point.endLine && point.endLine !== point.line ? `–${point.endLine}` : ""}`,
                      )
                      .join("、")}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </details>
      )}
      <details>
        <summary>來源快照與排除項</summary>
        <p style={{ overflowWrap: "anywhere" }}>{preview.snapshotSha256}</p>
        <ul>
          {preview.manifest.snapshot.files.map((file) => (
            <li key={file.path}>
              {file.path} · {file.size_bytes} bytes
            </li>
          ))}
        </ul>
        <ul>
          {preview.manifest.excluded.map((item) => (
            <li key={item.path}>
              {item.path} — {item.reason}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
