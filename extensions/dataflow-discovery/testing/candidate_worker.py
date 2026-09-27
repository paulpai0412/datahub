#!/usr/bin/env python3
"""UNTRUSTED result producer, for the fixed credential-free test image only.

The Host owns Docker admission, cancellation, output limits, source capture and
final validation in a DIFFERENT process. Nothing printed here is a PASS receipt.
Do not invoke this entrypoint in the Pi/model runtime or on the ordinary Host.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys


def main() -> int:
    # Refuse ordinary host/runtime use BEFORE touching inputs or candidate code.
    if os.getuid() != 10001 or os.getgid() != 10001:
        return 2
    profile_path = Path("/opt/discovery-test/run_checks.py")
    profile_spec = importlib.util.spec_from_file_location("_image_runtime_profile", profile_path)
    if profile_spec is None or profile_spec.loader is None:
        return 2
    profile = importlib.util.module_from_spec(profile_spec)
    profile_spec.loader.exec_module(profile)
    if not all(profile.runtime_profile()["checks"].values()):
        return 2

    # Only reviewed framework code is on this path. Candidate file names cannot
    # introduce sibling packages or replace the framework/entrypoint.
    sys.path.insert(0, "/work/framework")
    from dataflow_discovery.candidate_protocol import MAX_INPUT_BYTES, decode_input
    from dataflow_discovery.plugin_api import canonical, decode_json

    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        return 2
    snapshot, _manifest, config = decode_input(decode_json(raw.decode("utf-8")))
    candidate_path = Path("/work/candidate/plugin.py")
    if candidate_path.is_symlink() or not candidate_path.is_file():
        return 2
    candidate_spec = importlib.util.spec_from_file_location("plugin", candidate_path)
    if candidate_spec is None or candidate_spec.loader is None:
        return 2
    candidate = importlib.util.module_from_spec(candidate_spec)
    # Standard import semantics (e.g. dataclasses resolves __module__). This
    # namespace exists only inside this disposable, untrusted interpreter.
    sys.modules[candidate_spec.name] = candidate
    # From this point EVERYTHING in this process, including stdout, is untrusted.
    candidate_spec.loader.exec_module(candidate)
    analyze = getattr(candidate, "analyze", None)
    if not callable(analyze):
        return 2
    graph = analyze(snapshot, config)
    sys.stdout.buffer.write(canonical({"graph": graph}))
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception:
        # Never expose candidate exception strings, paths or arbitrary traceback.
        sys.stderr.write(json.dumps({"code": "candidate_worker_failed"}) + "\n")
        code = 2
    raise SystemExit(code)
