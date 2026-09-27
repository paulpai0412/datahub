"""Trusted data-only boundary for isolated plugin execution.

No candidate modules are imported here. A separate, untrusted process returns a
JSON graph; the Host validates that graph against its original captured input.
Candidate output cannot supply the manifest, receipt digests or approval flags.
"""
from dataclasses import asdict
from typing import Any

from .plugin_api import (
    Plugin, PluginError, PluginRegistry, _validate_schema, canonical,
    decode_json, validate_manifest, validate_snapshot,
)
from .snapshot import Snapshot, SourceFile

INPUT_FORMAT = "dataflow-discovery.isolated-input/1"
MAX_INPUT_BYTES = 131_072
MAX_OUTPUT_BYTES = 60_000


def snapshot_input(snapshot: Snapshot, manifest: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    """Serialize already-authorized captured text, never a Host root or credential."""
    validate_manifest(manifest)
    validate_snapshot(snapshot)
    _validate_schema(config, manifest["configSchema"])
    value = {"format": INPUT_FORMAT, "sourceId": snapshot.source_id,
             "snapshotSha256": snapshot.sha256,
             "files": [asdict(file) for file in snapshot.files],
             "manifest": manifest, "config": config}
    # Canonical JSON both bounds the wire and detaches the caller's mutable data.
    encoded = canonical(value)
    if len(encoded) > MAX_INPUT_BYTES:
        raise PluginError("plugin_input_too_large")
    return decode_json(encoded.decode("utf-8"))


def decode_input(value: Any) -> tuple[Snapshot, dict[str, Any], dict[str, Any]]:
    """Reconstruct value objects only. This is not authorization to capture paths."""
    if (not isinstance(value, dict)
            or set(value) != {"format", "sourceId", "snapshotSha256", "files", "manifest", "config"}
            or value["format"] != INPUT_FORMAT or not isinstance(value["files"], list)):
        raise PluginError("plugin_input_invalid")
    try:
        files = tuple(SourceFile(**file) for file in value["files"]
                      if isinstance(file, dict) and set(file) == {"path", "text", "sha256", "size_bytes"})
        if len(files) != len(value["files"]):
            raise PluginError("plugin_input_invalid")
        snapshot = Snapshot(source_id=value["sourceId"], files=files, sha256=value["snapshotSha256"])
        snapshot_input(snapshot, value["manifest"], value["config"])
    except PluginError:
        raise
    except (TypeError, ValueError, KeyError, AttributeError, RecursionError):
        raise PluginError("plugin_input_invalid") from None
    return snapshot, value["manifest"], value["config"]


def validate_candidate_output(trusted_input: dict[str, Any], output: bytes) -> dict[str, Any]:
    """Use the original Host input, not identities/flags reported by the worker."""
    snapshot, manifest, config = decode_input(trusted_input)
    if len(output) > MAX_OUTPUT_BYTES:
        raise PluginError("plugin_output_too_large")
    try:
        value = decode_json(output.decode("utf-8"))
    except (ValueError, RecursionError):
        raise PluginError("plugin_output_invalid") from None
    if not isinstance(value, dict) or set(value) != {"graph"}:
        raise PluginError("plugin_output_invalid")
    # This fixed callback returns DATA, never code or a candidate-supplied callable.
    registry = PluginRegistry((Plugin(manifest, lambda _snapshot, _config: value["graph"]),))
    return registry.analyze(manifest["id"], snapshot, config)
