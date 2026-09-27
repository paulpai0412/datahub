"""Contract v1: pure source-bound discovery, without loading candidate code.

Host-only validation lives here. A plugin is a callable receiving a captured
Snapshot and plain config, returning JSON data. Registration is explicit; this
module is neither a sandbox nor a plugin installer/publisher.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Callable

from .snapshot import Snapshot, SourceFile

CONTRACT_ROOT = Path(__file__).resolve().parents[2] / "contracts" / "v1"
MAX_RESULT_BYTES = 4 * 1024 * 1024


class PluginError(ValueError):
    """Bounded error code, never raw parser/source/credential text."""


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise ValueError("nonfinite_json_number")


def decode_json(text: str) -> Any:
    """Unambiguous JSON for declaration parsing and evidence-pointer lookup."""
    return json.loads(text, object_pairs_hook=_unique_object, parse_constant=_reject_constant)


def node_id(scope: str, kind: str, local_id: str) -> str:
    """Stable source-scoped identity. Content version and line numbers are separate."""
    return "node_" + digest([scope, kind, local_id])


def file_evidence(source: SourceFile, *, pointer: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"path": source.path, "fileSha256": source.sha256,
                              "startLine": 1, "endLine": source.text.count("\n") + 1}
    if pointer is not None:
        result["pointer"] = pointer
    return result


def contract_files() -> dict[str, bytes]:
    return {name: (CONTRACT_ROOT / name).read_bytes()
            for name in ("README.md", "manifest.schema.json", "graph.schema.json")}


def contract_digest() -> str:
    return digest({name: hashlib.sha256(data).hexdigest() for name, data in contract_files().items()})


def _validate_schema(value: Any, schema: dict[str, Any]) -> None:
    from jsonschema import Draft202012Validator
    from referencing import Registry
    # No retrieval function: even a malicious $ref can never perform a request.
    try:
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema, registry=Registry())
        if next(validator.iter_errors(value), None) is not None:
            raise PluginError("plugin_schema_invalid")
    except PluginError:
        raise
    except Exception:
        raise PluginError("plugin_schema_invalid") from None


def validate_manifest(manifest: dict[str, Any]) -> None:
    _validate_schema(manifest, json.loads((CONTRACT_ROOT / "manifest.schema.json").read_bytes()))
    schema = manifest["configSchema"]
    if schema.get("type") != "object" or schema.get("additionalProperties") is not False:
        raise PluginError("plugin_config_schema_not_closed")
    # Configuration schema is trusted deployment data, but must be self-contained.
    pending: list[Any] = [schema]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            if any(key in item for key in ("$id", "$schema", "$dynamicRef")):
                raise PluginError("plugin_config_schema_reference_rejected")
            if "$ref" in item and (not isinstance(item["$ref"], str) or not item["$ref"].startswith("#/")):
                raise PluginError("plugin_config_schema_reference_rejected")
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
    from jsonschema import Draft202012Validator
    try:
        Draft202012Validator.check_schema(schema)
    except Exception:
        raise PluginError("plugin_config_schema_invalid") from None


def validate_snapshot(snapshot: Snapshot) -> None:
    from .validator import _snapshot_findings
    if not isinstance(snapshot.source_id, str) or not snapshot.source_id or _snapshot_findings(snapshot):
        raise PluginError("plugin_snapshot_invalid")


def _validate_evidence(items: list[dict[str, Any]], files: dict[str, SourceFile]) -> None:
    for item in items:
        source = files.get(item["path"])
        if source is None or item["fileSha256"] != source.sha256:
            raise PluginError("plugin_evidence_source_mismatch")
        if not 1 <= item["startLine"] <= item["endLine"] <= source.text.count("\n") + 1:
            raise PluginError("plugin_evidence_location_invalid")
        if "pointer" in item:
            try:
                if re.search(r"~(?![01])", item["pointer"]):
                    raise ValueError("invalid_escape")
                value = decode_json(source.text)
                for token in item["pointer"].split("/")[1:]:
                    token = token.replace("~1", "/").replace("~0", "~")
                    if isinstance(value, list):
                        if re.fullmatch(r"0|[1-9][0-9]*", token) is None:
                            raise ValueError("invalid_array_index")
                        value = value[int(token)]
                    else:
                        value = value[token]
            except (ValueError, KeyError, TypeError, IndexError, RecursionError):
                raise PluginError("plugin_evidence_pointer_invalid") from None


def validate_graph(graph: dict[str, Any], snapshot: Snapshot) -> None:
    validate_snapshot(snapshot)
    try:
        size = len(canonical(graph))
    except (ValueError, TypeError, RecursionError):
        raise PluginError("plugin_result_not_json") from None
    if size > MAX_RESULT_BYTES:
        raise PluginError("plugin_result_too_large")
    _validate_schema(graph, json.loads((CONTRACT_ROOT / "graph.schema.json").read_bytes()))
    files = {file.path: file for file in snapshot.files}
    nodes = {node["id"]: node for node in graph["nodes"]}
    if len(nodes) != len(graph["nodes"]):
        raise PluginError("plugin_duplicate_node")
    for node in nodes.values():
        if node["id"] != node_id(snapshot.source_id, node["kind"], node["localId"]):
            raise PluginError("plugin_identity_mismatch")
        _validate_evidence(node["evidence"], files)
        if node["kind"] == "port":
            if nodes.get(node["owner"], {}).get("kind") not in {"asset", "operation"}:
                raise PluginError("plugin_port_owner_invalid")
            fields = [field["path"] for field in node["fields"]]
            if len(fields) != len(set(fields)):
                raise PluginError("plugin_duplicate_field")
    for edge in graph["edges"]:
        _validate_evidence(edge["evidence"], files)
        for endpoint in [*edge["sources"], edge["target"]]:
            node = nodes.get(endpoint["node"])
            if node is None:
                raise PluginError("plugin_dangling_edge")
            if "field" in endpoint and (node["kind"] != "port" or endpoint["field"] not in {field["path"] for field in node["fields"]}):
                raise PluginError("plugin_unknown_field")
        if edge["kind"] in {"value_dependency", "condition_dependency"}:
            if any(nodes[end["node"]]["kind"] != "port" for end in [*edge["sources"], edge["target"]]):
                raise PluginError("plugin_value_edge_requires_ports")
        elif len(edge["sources"]) != 1 or any("field" in end for end in [*edge["sources"], edge["target"]]):
            raise PluginError("plugin_structural_edge_invalid")
    coverage = graph["coverage"]
    if len(coverage) != len(files) or {item["path"] for item in coverage} != set(files):
        raise PluginError("plugin_coverage_incomplete")
    for finding in graph["findings"]:
        _validate_evidence(finding["evidence"], files)
    unsupported = {item["path"] for item in coverage if item["state"] == "unsupported"}
    reported = {item["path"] for finding in graph["findings"] for item in finding["evidence"]}
    if not unsupported <= reported:
        raise PluginError("plugin_unsupported_without_finding")
    if "legacyAnalysis" in graph:
        from .validator import validate_payload
        if validate_payload(graph["legacyAnalysis"], snapshot).status == "FAIL":
            raise PluginError("plugin_legacy_analysis_invalid")


@dataclass(frozen=True)
class Plugin:
    manifest: dict[str, Any]
    analyze: Callable[[Snapshot, dict[str, Any]], dict[str, Any]]


class PluginRegistry:
    """Explicit first-party registrations; IDs never become import paths.

    Only trusted code may construct a registry. Running an unreviewed callable
    here on a credential-bearing host is NOT made safe by output validation.
    """
    def __init__(self, plugins: tuple[Plugin, ...]):
        self._plugins: dict[str, Plugin] = {}
        for plugin in plugins:
            manifest = deepcopy(plugin.manifest)
            validate_manifest(manifest)
            if manifest["id"] in self._plugins:
                raise PluginError("plugin_duplicate_registration")
            self._plugins[manifest["id"]] = Plugin(manifest, plugin.analyze)

    def manifests(self) -> list[dict[str, Any]]:
        return [deepcopy(self._plugins[key].manifest) for key in sorted(self._plugins)]

    def analyze(self, plugin_id: str, snapshot: Snapshot, config: dict[str, Any]) -> dict[str, Any]:
        plugin = self._plugins.get(plugin_id)
        if plugin is None:
            raise PluginError("plugin_not_registered")
        validate_snapshot(snapshot)
        _validate_schema(config, plugin.manifest["configSchema"])
        # Immutable wire-shaped input config; plugins cannot mutate receipt inputs.
        try:
            config_hash = digest(config)
            selected_config = deepcopy(config)
        except (ValueError, TypeError, RecursionError):
            raise PluginError("plugin_config_not_json") from None
        try:
            graph = plugin.analyze(snapshot, selected_config)
        except Exception:
            raise PluginError("plugin_analysis_failed") from None
        validate_graph(graph, snapshot)
        result = {"format": "dataflow-discovery.plugin-result/1", "plugin": deepcopy(plugin.manifest),
                  "contractDigest": contract_digest(), "sourceId": snapshot.source_id,
                  "snapshotSha256": snapshot.sha256, "configDigest": config_hash, "graph": graph,
                  "coverageComplete": bool(graph["nodes"]) and not graph["findings"]
                      and all(item["state"] == "analyzed" for item in graph["coverage"]),
                  "publicationAuthorized": False, "runtimeVerified": False}
        result["resultDigest"] = digest(result)
        return result
