"""Trusted Host CLI for source-bound DataFlow Discovery."""

from __future__ import annotations

import argparse
import importlib
import json
from pathlib import Path

_host = importlib.import_module("dataflow_discovery.host")
_snapshot = importlib.import_module("dataflow_discovery.snapshot")
_validator = importlib.import_module("dataflow_discovery.validator")
Limits = _snapshot.Limits
capture_and_analyze = _host.capture_and_analyze
capture_snapshot = _snapshot.capture_snapshot
validate_payload = _validator.validate_payload
publication_preview = _validator.publication_preview
preview_digest = _validator.preview_digest


def _paths(parser: argparse.ArgumentParser, values: list[str] | None) -> list[str]:
    if not values:
        parser.error("at least one explicit --path is required")
    return values


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analyze an explicitly approved source snapshot")
    subparsers = parser.add_subparsers(dest="command", required=True)

    analyze_parser = subparsers.add_parser("analyze")
    analyze_parser.add_argument("--root", required=True, help="absolute trusted Host source root")
    analyze_parser.add_argument("--source-id", required=True)
    analyze_parser.add_argument("--path", action="append", dest="paths")

    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--root", required=True)
    validate_parser.add_argument("--source-id", required=True)
    validate_parser.add_argument("--analysis", required=True, type=Path)
    validate_parser.add_argument("--path", action="append", dest="paths")

    args = parser.parse_args(argv)
    paths = _paths(parser, args.paths)
    if args.command == "analyze":
        receipt = capture_and_analyze(args.root, paths, source_id=args.source_id)
        print(json.dumps(receipt.to_dict(), ensure_ascii=False, sort_keys=True))
        return 0

    try:
        payload = json.loads(args.analysis.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, TypeError, json.JSONDecodeError):
        print(json.dumps({"status": "FAIL", "findings": ["analysis_file_unavailable"]}))
        return 2
    if not isinstance(payload, dict):
        print(json.dumps({"status": "FAIL", "findings": ["analysis_payload_not_object"]}))
        return 2
    snapshot = capture_snapshot(args.root, paths, source_id=args.source_id, limits=Limits())
    report = validate_payload(payload.get("analysis", payload), snapshot)
    output = report.to_dict()
    if report.status != "FAIL":
        analysis = _validator._analysis_from_dict(payload.get("analysis", payload))
        preview = publication_preview(analysis, snapshot)
        output["publication_preview_digest"] = preview_digest(preview)
        output["publishable_count"] = len(preview["candidates"])
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))
    return 0 if report.status != "FAIL" else 2


if __name__ == "__main__":
    raise SystemExit(main())
