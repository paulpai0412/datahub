#!/usr/bin/env python3
"""Fixed local checks for reviewed first-party source, NOT a candidate sandbox.

Run only on a trusted development checkout. Unreviewed generated plugins require
an isolated runner; this command never produces deployment/activation authority.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SUITES = (
    "tests.test_discovery_plugin_contract", "tests.test_dataflow_discovery_snapshot",
    "tests.test_dataflow_discovery_analysis", "tests.test_dataflow_discovery_host",
    "tests.test_dataflow_discovery_python_sql",
)


def sources() -> dict[str, str]:
    extension = ROOT / "extensions/dataflow-discovery"
    paths = [*extension.joinpath("src").rglob("*.py"), *extension.joinpath("contracts/v1").iterdir(),
             ROOT / "scripts/check-discovery-plugin-contract.py",
             ROOT / "extensions/sales-datamart/src/sales_datamart/etl.py",
             *(ROOT / (suite.replace(".", "/") + ".py") for suite in SUITES)]
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths) if path.is_file()}


def sha(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="New local receipt; existing evidence is never overwritten")
    args = parser.parse_args()
    # Reserve the new evidence path before tests; never replace an old receipt.
    with args.output.open("x", encoding="utf-8") as output:
        before = sources()
        command = [sys.executable, "-m", "unittest", "-v", *SUITES]
        env = {"PATH": os.defpath, "HOME": "/nonexistent", "PYTHONDONTWRITEBYTECODE": "1",
               "PYTHONPATH": str(ROOT / "extensions/dataflow-discovery/src"), "DATAHUB_TELEMETRY_ENABLED": "false"}
        report = {"format": "dataflow-discovery.local-conformance/1", "scope": "reviewed_first_party_framework_only",
                  "sourceDigest": sha(before), "sources": before, "suites": list(SUITES), "command": command,
                  "contractDigest": sha({Path(path).name: value for path, value in before.items()
                      if path.startswith("extensions/dataflow-discovery/contracts/v1/")}),
                  "suiteDigest": sha({suite: before[suite.replace(".", "/") + ".py"] for suite in SUITES}),
                  "python": sys.version.split()[0], "packages": {},
                  "isolationVerified": False, "modelAdherenceVerified": False,
                  "datahubReadbackVerified": False, "activationAuthorized": False,
                  "startedAt": datetime.now(timezone.utc).isoformat()}
        try:
            report["packages"] = {name: importlib.metadata.version(name)
                                  for name in ("jsonschema", "acryl-datahub", "sqlglot")}
            result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, timeout=180, check=False)
            report.update(exitCode=result.returncode, stdoutSha256=hashlib.sha256(result.stdout).hexdigest(),
                          stderrSha256=hashlib.sha256(result.stderr).hexdigest(),
                          validationOutput=(result.stdout + result.stderr).decode("utf-8", errors="replace"))
            report["status"] = "PASS" if result.returncode == 0 else "FAIL"
        except importlib.metadata.PackageNotFoundError:
            report.update(status="BLOCKED", code="local_check_dependency_missing")
        except (OSError, subprocess.TimeoutExpired):
            report.update(status="BLOCKED", code="local_check_process_failed")
        report["sourceUnchanged"] = before == sources()
        if not report["sourceUnchanged"]:
            report.update(status="BLOCKED", code="source_changed_during_check")
        report["finishedAt"] = datetime.now(timezone.utc).isoformat()
        json.dump(report, output, ensure_ascii=False, indent=2)
        output.write("\n")
    print(json.dumps({key: report[key] for key in ("status", "scope", "sourceDigest", "sourceUnchanged", "activationAuthorized")}))
    return 0 if report["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
