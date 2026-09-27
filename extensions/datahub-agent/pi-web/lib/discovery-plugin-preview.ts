/** Display contract for Host-produced plugin previews, not activation authority.
 * Python owns full Contract v1/source validation. This guard checks the data and
 * references consumed by the browser; persisted tool details are still data.
 */
export type PluginEvidence = { path: string; fileSha256: string; startLine: number; endLine: number; pointer?: string };
type BaseNode = { id: string; localId: string; name: string; evidence: PluginEvidence[] };
export type PluginNode = BaseNode & (
  | { kind: "asset"; assetType: string }
  | { kind: "operation"; operationType: string; expressionSha256?: string }
  | { kind: "port"; owner: string; direction: "input" | "output" | "inout"; fields: { path: string; nativeType: string; nullable?: boolean }[] }
);
export type PluginEndpoint = { node: string; field?: string };
export type PluginEdge = { kind: "reads" | "writes" | "calls" | "contains" | "depends_on" | "value_dependency" | "condition_dependency";
  sources: PluginEndpoint[]; target: PluginEndpoint; evidence: PluginEvidence[] };
export type PluginPreview = {
  format: "dataflow-discovery.plugin-preview/1";
  sourceId: string; snapshotSha256: string; complete: false; publicationAuthorized: false; observedAt?: string;
  manifest: { selection: string; snapshot: { source_id: string; sha256: string; files: { path: string; sha256: string; size_bytes: number }[] };
    excluded: { path: string; reason: string }[] };
  result: {
    format: "dataflow-discovery.plugin-result/1"; sourceId: string; snapshotSha256: string;
    plugin: { id: string; version: string; contractVersion: "1"; kind: "asset" | "language" | "semantic"; limitations: string[] };
    contractDigest: string; configDigest: string; resultDigest: string;
    publicationAuthorized: false; runtimeVerified: false; coverageComplete: boolean;
    graph: { nodes: PluginNode[]; edges: PluginEdge[]; coverage: { path: string; state: "analyzed" | "unsupported"; reason: string }[];
      findings: { code: string; evidence: PluginEvidence[] }[] };
  };
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nodeId = (value: unknown): value is string => typeof value === "string" && /^node_[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function isPluginPreview(value: unknown): value is PluginPreview {
  if (!record(value) || value.format !== "dataflow-discovery.plugin-preview/1" || value.complete !== false ||
      value.publicationAuthorized !== false || !text(value.sourceId) || !sha(value.snapshotSha256) ||
      (value.observedAt !== undefined && !text(value.observedAt)) ||
      !record(value.manifest) || !text(value.manifest.selection) || !record(value.manifest.snapshot) ||
      value.manifest.snapshot.source_id !== value.sourceId || value.manifest.snapshot.sha256 !== value.snapshotSha256 ||
      !Array.isArray(value.manifest.snapshot.files) || value.manifest.snapshot.files.length > 128 ||
      !Array.isArray(value.manifest.excluded) || !value.manifest.excluded.every(item => record(item) && text(item.path) && text(item.reason))) return false;
  // Same complete wire limit as the existing Host channel; no hidden truncation.
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 60000) return false; } catch { return false; }
  const files = new Map<string, string>();
  for (const file of value.manifest.snapshot.files) {
    if (!record(file) || !text(file.path) || !sha(file.sha256) || !integer(file.size_bytes) || files.has(file.path)) return false;
    files.set(file.path, file.sha256);
  }
  const evidence = (items: unknown): items is PluginEvidence[] => Array.isArray(items) && items.length > 0 && items.length <= 256 && items.every(item =>
    record(item) && text(item.path) && sha(item.fileSha256) && files.get(item.path) === item.fileSha256 &&
    integer(item.startLine) && item.startLine > 0 && integer(item.endLine) && item.endLine >= item.startLine &&
    (item.pointer === undefined || typeof item.pointer === "string" && /^(|\/.*)$/.test(item.pointer)));
  const result = value.result;
  if (!record(result) || result.format !== "dataflow-discovery.plugin-result/1" || result.sourceId !== value.sourceId ||
      result.snapshotSha256 !== value.snapshotSha256 || result.publicationAuthorized !== false || result.runtimeVerified !== false ||
      typeof result.coverageComplete !== "boolean" || !sha(result.contractDigest) || !sha(result.configDigest) || !sha(result.resultDigest) ||
      !record(result.plugin) || !text(result.plugin.id) || result.plugin.id === "legacy-static" ||
      !text(result.plugin.version) || result.plugin.contractVersion !== "1" || !["asset", "language", "semantic"].includes(String(result.plugin.kind)) ||
      !Array.isArray(result.plugin.limitations) || !result.plugin.limitations.every(text) || !record(result.graph)) return false;
  const graph = result.graph;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.coverage) || !Array.isArray(graph.findings)) return false;
  const nodes = new Map<string, PluginNode>();
  for (const node of graph.nodes) {
    if (!record(node) || !nodeId(node.id) || nodes.has(node.id) || !text(node.localId) || !text(node.name) || !evidence(node.evidence)) return false;
    if (node.kind === "port") {
      if (!nodeId(node.owner) || !["input", "output", "inout"].includes(String(node.direction)) || !Array.isArray(node.fields) ||
          !node.fields.every(field => record(field) && text(field.path) && text(field.nativeType) &&
            (field.nullable === undefined || typeof field.nullable === "boolean")) ||
          new Set(node.fields.map(field => field.path)).size !== node.fields.length) return false;
    } else if (node.kind === "asset") { if (!text(node.assetType)) return false; }
    else if (node.kind === "operation") { if (!text(node.operationType) || (node.expressionSha256 !== undefined && !sha(node.expressionSha256))) return false; }
    else return false;
    nodes.set(node.id, node as PluginNode);
  }
  for (const node of nodes.values()) if (node.kind === "port" &&
    (!nodes.has(node.owner) || nodes.get(node.owner)?.kind === "port")) return false;
  const endpoint = (item: unknown): item is PluginEndpoint => {
    if (!record(item) || !nodeId(item.node)) return false;
    const node = nodes.get(item.node);
    return !!node && (item.field === undefined || text(item.field) && node.kind === "port" && node.fields.some(field => field.path === item.field));
  };
  for (const edge of graph.edges) {
    if (!record(edge) || !["reads", "writes", "calls", "contains", "depends_on", "value_dependency", "condition_dependency"].includes(String(edge.kind)) ||
        !Array.isArray(edge.sources) || !edge.sources.length || !edge.sources.every(endpoint) || !endpoint(edge.target) || !evidence(edge.evidence)) return false;
    const endpoints = [...edge.sources, edge.target];
    if (["value_dependency", "condition_dependency"].includes(String(edge.kind))) {
      if (endpoints.some(item => nodes.get(item.node)?.kind !== "port")) return false;
    } else if (edge.sources.length !== 1 || endpoints.some(item => item.field !== undefined)) return false;
  }
  if (graph.coverage.length !== files.size || !graph.coverage.every(item => record(item) && text(item.path) && files.has(item.path) &&
      ["analyzed", "unsupported"].includes(String(item.state)) && text(item.reason)) ||
      new Set(graph.coverage.map(item => item.path)).size !== files.size ||
      !graph.findings.every(item => record(item) && text(item.code) && evidence(item.evidence))) return false;
  if (result.coverageComplete && (!nodes.size || graph.findings.length || graph.coverage.some(item => item.state !== "analyzed"))) return false;
  return true;
}
