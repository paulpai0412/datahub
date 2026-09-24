import type { CatalogEdge, CatalogResult } from "./catalog-contract.ts";

export type ObservedCatalogEdge = CatalogEdge & { queriedAt: string };
export const catalogEdgeKey = (edge: CatalogEdge) =>
  JSON.stringify([edge.from, edge.to, edge.relationship]);

/** Request-local presentation of explicitly read pages; no inferred edges or cache. */
export function observedCatalogLineage(
  result: CatalogResult,
  pages: CatalogResult[],
) {
  const center = result.entity!;
  const direction = result.direction!;
  const nodes = new Map([[center.urn, center]]);
  const edges = new Map<string, ObservedCatalogEdge>();
  const observed = new Map<string, CatalogResult>();
  const latestPages = new Map<string, CatalogResult>();
  for (const page of [result, ...pages].toSorted(
    (a, b) => Date.parse(a.queriedAt) - Date.parse(b.queriedAt),
  )) {
    if (
      page.action !== "lineage" ||
      page.direction !== direction ||
      !page.entity
    )
      continue;
    latestPages.set(
      JSON.stringify([page.entity.urn, page.pagination.offset]),
      page,
    );
  }
  for (const page of latestPages.values()) {
    nodes.set(page.entity!.urn, page.entity!);
    observed.set(page.entity!.urn, page);
    for (const edge of page.edges!) {
      nodes.set(edge.related.urn, edge.related);
      edges.set(catalogEdgeKey(edge), { ...edge, queriedAt: page.queriedAt });
    }
  }
  const adjacent = new Map<string, string[]>();
  const forward = new Map<string, string[]>();
  for (const edge of edges.values()) {
    const start = direction === "UPSTREAM" ? edge.to : edge.from;
    const end = direction === "UPSTREAM" ? edge.from : edge.to;
    const neighbors = adjacent.get(start) ?? [];
    neighbors.push(end);
    adjacent.set(start, neighbors);
    const targets = forward.get(edge.from) ?? [];
    targets.push(edge.to);
    forward.set(edge.from, targets);
  }
  const distance = new Map([[center.urn, 0]]);
  const parent = new Map<string, string>();
  const queue = [center.urn];
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index];
    for (const to of adjacent.get(from) ?? []) {
      if (distance.has(to)) continue;
      distance.set(to, distance.get(from)! + 1);
      parent.set(to, from);
      queue.push(to);
    }
  }
  return {
    center,
    direction,
    nodes,
    edges,
    observed,
    distance,
    parent,
    forward,
  };
}

export function observedCatalogPath(
  graph: ReturnType<typeof observedCatalogLineage>,
  urn: string,
) {
  if (!graph.distance.has(urn)) return [];
  const path: string[] = [];
  let node: string | undefined = urn;
  while (node !== undefined) {
    path.unshift(node);
    node = graph.parent.get(node);
  }
  return graph.direction === "UPSTREAM" ? path.reverse() : path;
}

export function observedCatalogCycle(
  graph: ReturnType<typeof observedCatalogLineage>,
  edge: CatalogEdge,
) {
  const visited = new Set<string>();
  const pending = [edge.to];
  for (let i = 0; i < pending.length; i++) {
    const current = pending[i];
    if (current === edge.from) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(graph.forward.get(current) ?? []));
  }
  return false;
}
