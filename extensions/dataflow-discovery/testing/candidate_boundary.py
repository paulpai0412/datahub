#!/usr/bin/env python3
"""Trusted DATA-only preparation/validation; never imports a candidate module.

Run separately from candidate_worker.py in the fixed bounded image. The Host
supplies original input and captures stdout. Candidate-reported PASS is ignored.
"""
import base64
from hashlib import sha256
import sys
import re

sys.path.insert(0, "/work/framework")
from dataflow_discovery.candidate_protocol import (
    MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, snapshot_input, validate_candidate_output,
)
from dataflow_discovery.plugin_api import PluginError, canonical, decode_json
from dataflow_discovery.snapshot import SourceFile, _make_snapshot


def prepare(value: dict) -> dict:
    if set(value) != {"sourceId", "files", "manifestText", "config"} or not isinstance(value["files"], list):
        raise PluginError("candidate_input_invalid")
    files = []
    for item in value["files"]:
        if not isinstance(item, dict) or set(item) != {"path", "text"} or not isinstance(item["text"], str):
            raise PluginError("candidate_input_invalid")
        encoded = item["text"].encode("utf-8")
        files.append(SourceFile(path=item["path"], text=item["text"], sha256=sha256(encoded).hexdigest(), size_bytes=len(encoded)))
    manifest = decode_json(value["manifestText"])
    return snapshot_input(_make_snapshot(value["sourceId"], files), manifest, value["config"])


def main() -> int:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 2 * MAX_OUTPUT_BYTES + 4097)
    if len(raw) > MAX_INPUT_BYTES + 2 * MAX_OUTPUT_BYTES + 4096:
        raise PluginError("candidate_input_too_large")
    value = decode_json(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise PluginError("candidate_input_invalid")
    if sys.argv[1:] == ["prepare"]:
        result = prepare(value)
    elif sys.argv[1:] == ["validate"] and set(value) == {"input", "outputBase64"}:
        output = base64.b64decode(value["outputBase64"], validate=True)
        result = validate_candidate_output(value["input"], output)
    else:
        raise PluginError("candidate_boundary_operation_invalid")
    sys.stdout.buffer.write(canonical({"status": "PASS", "result": result}))
    return 0


if __name__ == "__main__":
    try:
        status = main()
    except (PluginError, ValueError, TypeError, KeyError, AttributeError, RecursionError) as error:
        # These are input/contract failures, not activation or reviewer verdicts.
        code = str(error) if isinstance(error, PluginError) else "candidate_input_invalid"
        if re.fullmatch(r"[a-z_]{1,80}", code) is None:
            code = "candidate_input_invalid"
        sys.stdout.buffer.write(canonical({"status": "FAIL", "code": code}))
        status = 2
    raise SystemExit(status)
