"""Image entrypoint for reviewed first-party checks, not arbitrary plugin admission.

Docker configuration and source digests must ALSO be checked by the calling Host.
This process cannot attest to the Host's mounts, image identity or approval.
"""
from __future__ import annotations

import errno
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
import traceback


def runtime_profile() -> dict:
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
    mounts = {line.split()[4]: line.split()[5].split(",")
              for line in Path("/proc/self/mountinfo").read_text().splitlines()}
    checks = {
        "nonRoot": os.getuid() == 10001 and os.getgid() == 10001,
        "capabilitiesDropped": int(status["CapEff"].strip(), 16) == 0,
        "noNewPrivileges": status["NoNewPrivs"].strip() == "1",
        "rootReadOnly": "ro" in mounts.get("/", []),
        "sourceReadOnly": "ro" in mounts.get("/work", []),
        "tmpNoSuidNoDevices": {"nosuid", "nodev"} <= set(mounts.get("/tmp", [])),
        "loopbackOnly": {path.name for path in Path("/sys/class/net").iterdir()} == {"lo"},
        "noDockerSocket": not Path("/var/run/docker.sock").exists(),
        "noHome": os.environ.get("HOME") == "/nonexistent" and not Path("/nonexistent").exists(),
    }
    # Documentation-only TEST-NET address, not a production/service endpoint.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(1)
        try:
            connection.connect(("192.0.2.1", 443))
            checks["egressUnavailable"] = False
        except OSError as error:
            checks["egressUnavailable"] = error.errno == errno.ENETUNREACH
    return {"checks": checks, "python": platform.python_version(),
            "packages": {dist.metadata["Name"]: dist.version for dist in importlib.metadata.distributions()},
            "git": subprocess.check_output(["git", "--version"], text=True).strip()}


def main() -> int:
    result = {"format": "dataflow-discovery.isolated-framework-check/1", "status": "BLOCKED",
              "scope": "reviewed_first_party_framework_only", "activationAuthorized": False,
              "modelAdherenceVerified": False, "datahubReadbackVerified": False}
    try:
        profile = runtime_profile()
        result["runtime"] = profile
        if not all(profile["checks"].values()):
            result["code"] = "runtime_profile_rejected"
        else:
            completed = subprocess.run(
                [sys.executable, "/work/scripts/check-discovery-plugin-contract.py", "--output", "/tmp/conformance.json"],
                cwd="/work", env={"PATH": os.defpath, "HOME": "/nonexistent", "LANG": "C.UTF-8",
                    "PYTHONDONTWRITEBYTECODE": "1", "DATAHUB_TELEMETRY_ENABLED": "false"},
                timeout=190, capture_output=True, check=False)
            # Protected local Docker stderr retains diagnostic evidence on failure;
            # callers must not publish it or treat it as an acceptance statement.
            if completed.returncode != 0:
                sys.stderr.buffer.write(completed.stderr)
            receipt = Path("/tmp/conformance.json")
            if not receipt.is_file() or receipt.stat().st_size > 2 * 1024 * 1024:
                result["code"] = "framework_receipt_missing_or_oversize"
            else:
                result["conformance"] = json.loads(receipt.read_text())
                result["exitCode"] = completed.returncode
                result["status"] = "PASS" if completed.returncode == 0 and result["conformance"]["status"] == "PASS" else "FAIL"
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        # Public result is bounded; original infrastructure error remains in the
        # separate local stderr artifact, never an authority-bearing model report.
        traceback.print_exc(file=sys.stderr)
        result["code"] = "isolated_framework_check_failed"
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
