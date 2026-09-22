#!/usr/bin/env python3
"""Check the resolved healthcheck; --live verifies real probes, exits and reaping.

Does not read login credentials or modify metadata. Live mode observes the existing
OpenSearch container for at least six new Docker healthchecks (about 30 seconds).
"""

import argparse
import json
from pathlib import Path
import subprocess
import time
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
CONTAINER = "ekop-datahub-opensearch-1"


def run(*args: str) -> str:
    return subprocess.check_output(args, cwd=ROOT, text=True, timeout=20)


def validate_probe(probe: list[str]) -> None:
    assert probe[:2] == ["CMD", "curl"], "Healthcheck must directly execute curl, not a shell"
    assert "--fail" in probe[2:-1], "HTTP failures must fail the healthcheck"
    url = urlsplit(probe[-1])
    assert url.scheme == "http" and url.hostname == "localhost" and url.port == 9200
    assert url.path == "/_cluster/health"
    assert parse_qs(url.query) == {"wait_for_status": ["yellow"], "timeout": ["0s"]}


def zombie_count(parent: int) -> int:
    count = 0
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
            fields = stat[stat.rfind(")") + 2:].split()
            count += fields[0] == "Z" and int(fields[1]) == parent
        except (OSError, ValueError, IndexError):
            continue
    return count


def inspect() -> dict:
    template = '{"pid":{{.State.Pid}},"health":{{json .State.Health}},"test":{{json .Config.Healthcheck.Test}}}'
    return json.loads(run("docker", "inspect", CONTAINER, "--format", template))


def check_live(expected: list[str]) -> None:
    first = inspect()
    assert first["pid"] > 0
    assert first["test"] == expected, "Running container has not applied the resolved healthcheck"
    existing = {log["Start"] for log in first["health"]["Log"]}
    seen = set()
    state = first
    deadline = time.monotonic() + 120
    while len(seen) < 6:
        state = inspect()
        assert state["pid"] == first["pid"], "Container restarted during observation"
        assert zombie_count(state["pid"]) == 0, "OpenSearch still owns zombie processes"
        for log in state["health"]["Log"]:
            if log["Start"] not in existing:
                assert log["ExitCode"] == 0, "New real healthcheck failed"
                seen.add(log["Start"])
        assert time.monotonic() < deadline, "Timed out waiting for six new healthy probes"
        if len(seen) < 6:
            time.sleep(1)
    assert state["health"]["Status"] == "healthy"
    # Real HTTP error, no shell: the nonexistent read-only route must return curl 22.
    failed = subprocess.run(
        ["docker", "exec", CONTAINER, *expected[1:-1],
         "http://localhost:9200/_ekop_missing_healthcheck_route"],
        cwd=ROOT, capture_output=True, text=True, timeout=20,
    )
    assert failed.returncode == 22, f"HTTP error did not propagate: {failed.returncode}"
    assert zombie_count(state["pid"]) == 0
    print(f"PASS: {len(seen)} new real healthy probes, stable PID, zero zombies, HTTP error exit 22")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    # Capture resolved Compose internally: never print environments or credentials.
    config = json.loads(run(str(ROOT / "scripts/compose.sh"), "config", "--format", "json"))
    probe = config["services"]["opensearch"]["healthcheck"]["test"]
    validate_probe(probe)
    print("PASS: resolved Compose directly executes curl with one complete health URL")
    if args.live:
        check_live(probe)


if __name__ == "__main__":
    main()
