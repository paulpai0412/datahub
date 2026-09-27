#!/usr/bin/env python3
"""Operator-only offline draft from retained Host data; never executes a plugin.

Input envelopes are existing prepare.stdout / validate.stdout JSON artifacts.
Their PASS string is not authenticated authority. Verify their Host provenance
separately. This command performs no capture, HTTP request, activation or emit.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions/dataflow-discovery/src"))
from dataflow_discovery.api_native import compile_api_draft, compare_api_draft
from dataflow_discovery.candidate_protocol import MAX_INPUT_BYTES, MAX_OUTPUT_BYTES
from dataflow_discovery.plugin_api import PluginError, canonical, decode_json


def read_json(path: Path, limit: int):
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise PluginError("api_draft_file_too_large")
    return decode_json(data.decode("utf-8"))


def envelope(path: Path, limit: int):
    value = read_json(path, limit)
    if not isinstance(value, dict) or set(value) != {"status", "result"} or value["status"] != "PASS":
        raise PluginError("api_draft_artifact_invalid")
    return value["result"]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared-input", type=Path, required=True)
    parser.add_argument("--validated-result", type=Path, required=True)
    parser.add_argument("--tenant-id", required=True, help="operator context; not a model-provided identity")
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--service-id", required=True)
    parser.add_argument("--observations", type=Path, help="optional offline SDK-value baseline, not live evidence")
    args = parser.parse_args(argv)
    try:
        draft = compile_api_draft(envelope(args.prepared_input, MAX_INPUT_BYTES + 4096),
                                  envelope(args.validated_result, MAX_OUTPUT_BYTES),
                                  {"tenantId": args.tenant_id, "sourceId": args.source_id, "serviceId": args.service_id})
        observations = read_json(args.observations, 4 * 1024 * 1024) if args.observations else None
        comparison = compare_api_draft(draft, observations)
        print(canonical({"draft": draft, "comparison": comparison}).decode("utf-8"))
        return 0
    except PluginError as error:
        print(canonical({"status": "FAIL", "code": str(error)}).decode("utf-8"))
    except (OSError, ValueError, TypeError, AttributeError, KeyError, RecursionError):
        print('{"status":"FAIL","code":"api_draft_input_invalid"}')
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
