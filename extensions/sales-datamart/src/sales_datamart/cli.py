"""Fixed ETL entrypoint. The Agent receives neither this CLI nor credentials."""
from __future__ import annotations

import argparse
import importlib
import json
import os
import resource
import selectors
import signal
import sys
import time

_etl = importlib.import_module("sales_datamart.etl")
run_etl = _etl.run_etl
receipt_digest = _etl.receipt_digest
COMMIT_WAIT_SECONDS = 30


def _await_commit(receipt_hash: str) -> None:
    """One bounded permission message on the owning Host's private stdin pipe.

    Parent death closes the pipe. No permission, malformed input or deadline
    raises while the ETL transaction is still open, rather than committing on
    EOF or reusing an earlier permission. This is not a portable authorization.
    """
    expected = ("COMMIT " + receipt_hash + "\n").encode("ascii")
    deadline = time.monotonic() + COMMIT_WAIT_SECONDS
    value = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
        while b"\n" not in value:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise _etl.ETLError("commit_authorization_timeout")
            chunk = os.read(sys.stdin.fileno(), 129 - len(value))
            if not chunk:
                raise _etl.ETLError("commit_authorization_missing")
            value.extend(chunk)
            if len(value) > 128:
                raise _etl.ETLError("commit_authorization_invalid")
    if value != expected:
        raise _etl.ETLError("commit_authorization_invalid")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the fixed AdventureWorks SalesDatamart ETL")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="read and validate without target writes")
    mode.add_argument("--host-controlled", action="store_true",
                      help="require the owning Host's one-use pre-commit permission")
    args = parser.parse_args(argv)
    # The legacy trusted-operator path has no Host handshake. Any failure there
    # is conservatively uncertain; never label a post-commit error as rolled back.
    commit_authorized = not args.dry_run and not args.host_controlled

    def before_commit(receipt: dict) -> None:
        nonlocal commit_authorized
        digest = receipt_digest(receipt)
        print(json.dumps({"phase": "READY_TO_COMMIT", "receipt": receipt,
                          "receipt_sha256": digest}, sort_keys=True), flush=True)
        _await_commit(digest)
        commit_authorized = True

    previous_alarm = None
    alarm_installed = False
    try:
        if args.host_controlled:
            # This fixed Host runs on POSIX. The child's deadline cannot outlive
            # admission even if its parent disappears. Signal death is UNKNOWN.
            deadline_ms = int(os.environ["SALESDATAMART_DEADLINE_MS"])
            remaining = min(300.0, deadline_ms / 1000 - time.time())
            if remaining <= 0:
                raise _etl.ETLError("execution_deadline")
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_AS, (1073741824, 1073741824))
            resource.setrlimit(resource.RLIMIT_CPU, (300, 300))
            previous_alarm = signal.signal(signal.SIGALRM, signal.SIG_DFL)
            alarm_installed = True
            signal.setitimer(signal.ITIMER_REAL, remaining)
        receipt = run_etl(dry_run=args.dry_run,
                          before_commit=before_commit if args.host_controlled else None)
        output = {**receipt, "receipt_sha256": receipt_digest(receipt)}
        if args.host_controlled:
            output = {"phase": "FINISHED", "receipt": output}
        print(json.dumps(output, ensure_ascii=False, sort_keys=True), flush=True)
        return 0
    except Exception:
        # SQLAlchemy errors can include SQL parameters. Never print traceback,
        # exception text, rows or credentials into the Agent/Host result channel.
        print(json.dumps({"phase": "FAILED", "status": "UNKNOWN" if commit_authorized else "FAILED",
                          "code": "commit_or_readback_unconfirmed" if commit_authorized else "etl_failed_before_commit"}),
              flush=True)
        return 1
    finally:
        if alarm_installed:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_alarm)


if __name__ == "__main__":
    raise SystemExit(main())
