"""Lossless legacy candidate adapter; coarse IR is not field-lineage recovery."""
from __future__ import annotations

from typing import Any

from ..analyzer import analyze_snapshot
from ..plugin_api import file_evidence, node_id
from ..snapshot import Snapshot

MANIFEST = {
    "id": "legacy-static", "version": "1.0.3", "contractVersion": "1", "kind": "semantic",
    "capabilities": ["legacy-candidates", "static-structure"],
    "suffixes": [".py", ".sql", ".json", ".yaml", ".yml", ".md"],
    "limitations": ["Legacy field mappings still require the existing Catalog/Python binders",
                    "Coarse IR is not a replacement for the workspace publisher"],
    "configSchema": {"type": "object", "properties": {}, "additionalProperties": False},
}


def analyze(snapshot: Snapshot, config: dict[str, Any]) -> dict[str, Any]:
    analysis = analyze_snapshot(snapshot)
    graph: dict[str, Any] = {"nodes": [], "edges": [], "findings": [],
        "coverage": [{"path": file.path, "state": "analyzed", "reason": "legacy_static_scan"} for file in snapshot.files],
        "legacyAnalysis": analysis.to_dict()}
    nodes: dict[str, dict[str, Any]] = {}
    for candidate in analysis.candidates:
        evidence = [{"path": item.path, "fileSha256": item.file_sha256,
                     "startLine": item.start_line, "endLine": item.end_line} for item in candidate.evidence]
        if candidate.kind in {"asset", "process"}:
            kind = "asset" if candidate.kind == "asset" else "operation"
            node = nodes.get(candidate.subject)
            if node is None:
                node = {"id": node_id(snapshot.source_id, kind, candidate.subject), "kind": kind,
                        "localId": candidate.subject, "name": candidate.subject, "evidence": []}
                if kind == "asset":
                    node["assetType"] = str(dict(candidate.attributes).get("asset_type", "unbound_dataset"))
                else:
                    node["operationType"] = "static_declaration"
                nodes[candidate.subject] = node
            for item in evidence:
                if item not in node["evidence"]:
                    node["evidence"].append(item)
        elif candidate.kind in {"field_mapping", "type", "governance_proposal", "unresolved"}:
            graph["findings"].append({"code": "legacy_" + candidate.kind + "_requires_specialized_binding", "evidence": evidence})
        if candidate.status in {"inferred", "unresolved"} and candidate.kind != "unresolved":
            graph["findings"].append({"code": "legacy_unverified_candidate", "evidence": evidence})
    for candidate in analysis.candidates:
        if candidate.kind != "relationship":
            continue
        evidence = [{"path": item.path, "fileSha256": item.file_sha256,
                     "startLine": item.start_line, "endLine": item.end_line} for item in candidate.evidence]
        relation = dict(candidate.attributes).get("relation_type")
        if relation not in {"reads", "writes", "calls", "contains", "depends_on"} or candidate.subject not in nodes or candidate.object not in nodes:
            graph["findings"].append({"code": "legacy_relation_not_projected", "evidence": evidence})
            continue
        graph["edges"].append({"kind": relation, "sources": [{"node": nodes[candidate.subject]["id"]}],
                               "target": {"node": nodes[candidate.object]["id"]}, "evidence": evidence})
    graph["nodes"] = sorted(nodes.values(), key=lambda node: node["id"])
    if not analysis.candidates:
        graph["findings"] = [{"code": "legacy_empty_analysis", "evidence": [file_evidence(file)]} for file in snapshot.files]
    return graph
