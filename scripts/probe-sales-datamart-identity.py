#!/usr/bin/env python3
"""One approved, case-specific read-only identity probe. Not an Agent tool.

Imports only the hash-approved configuration/factory in a clean child process.
Never calls run_etl, changes Source/Secret/metadata, or reads business tables.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / ".local/evidence/dataflow-discovery"
APPROVAL = BASE / "identity-probe-approval-20260914.json"
RECEIPT = BASE / "identity-probe-run-20260914.json"
SNAPSHOT = "ed276f258ceed74e491d85b16d8e54da9408cc9484b44a3bbccf8e4aec1af77f"
CONTAINER = "284caebbc279fbb23f532c0406baeb3e4f9ac922aec972694c4321f1c2f209b1"
IMAGE = "mcr.microsoft.com/mssql/server@sha256:46f719fd3457d4e7e8e5845fe00c35c20e7bae7ff1e8b9fe595f2a81029f5ba8"
QUERY = """SELECT DB_NAME() AS database_name, DB_ID() AS database_id,
ORIGINAL_LOGIN() AS original_login, SUSER_SNAME() AS login_name,
USER_NAME() AS database_user,
CONVERT(nvarchar(128), SERVERPROPERTY('ServerName')) AS server_name,
CONVERT(nvarchar(128), SERVERPROPERTY('MachineName')) AS machine_name,
CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')) AS product_version"""
TARGETS = (
    ("source", "AdventureWorks2019", "datahub_ingest", ".local/sqlserver/recovered.env", "DATAHUB_MSSQL_PASSWORD"),
    ("target", "SalesDatamart", "sales_datamart_loader", ".local/sqlserver/sales-datamart.env", "SALESDATAMART_LOADER_PASSWORD"),
)


class ProbeError(ValueError):
    """Only fixed operator reason codes, never driver messages or source data."""


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def persist(receipt: dict) -> None:
    temporary = RECEIPT.with_suffix(".pending")
    with temporary.open("x", encoding="utf-8") as output:
        os.chmod(temporary, 0o600)
        json.dump(receipt, output, indent=2)
        output.write("\n")
    os.replace(temporary, RECEIPT)


def preflight() -> dict:
    approval = json.loads(APPROVAL.read_text())
    if approval.get("status") != "USER_APPROVED_READONLY_IDENTITY_PROBE" or approval.get("snapshotSha256") != SNAPSHOT:
        raise ProbeError("approval_mismatch")
    if approval.get("operatorSha256") != digest(Path(__file__)) or approval.get("querySha256") != hashlib.sha256(QUERY.encode()).hexdigest():
        raise ProbeError("approved_probe_changed")
    sys.path.insert(0, str(ROOT / "extensions/dataflow-discovery/src"))
    from dataflow_discovery.snapshot import capture_snapshot
    policy = json.loads((BASE / "agent-discovery-deployment-proposal-20260914.json").read_text())["sourcePolicy"]
    snapshot = capture_snapshot(ROOT, policy["paths"], source_id=policy["sourceId"])
    if snapshot.sha256 != SNAPSHOT:
        raise ProbeError("approved_source_changed")
    # Never inspect Config.Env, which contains unrelated secrets.
    template = "{{.Id}}\n{{.Config.Image}}\n{{.Config.Hostname}}\n{{.State.Running}}\n{{json .NetworkSettings.Ports}}"
    inspected = subprocess.run(["docker", "--context", "default", "inspect", "--format", template, CONTAINER],
                               capture_output=True, text=True, timeout=10, check=True).stdout.splitlines()
    if len(inspected) != 5 or inspected[0] != CONTAINER or inspected[1] != IMAGE or inspected[3] != "true":
        raise ProbeError("source_container_mismatch")
    bindings = json.loads(inspected[4]).get("1433/tcp", [])
    if not any(binding.get("HostPort") == "14334" and binding.get("HostIp") in {"0.0.0.0", "127.0.0.1"} for binding in bindings):
        raise ProbeError("source_port_mapping_mismatch")
    expected_versions = {"SQLAlchemy": "1.4.54", "python-tds": "1.17.1", "sqlalchemy-pytds": "0.3.5"}
    versions = {name: importlib.metadata.version(name) for name in expected_versions}
    if versions != expected_versions:
        raise ProbeError("driver_version_changed")
    return {"snapshotSha256": snapshot.sha256, "sourceFiles": {file.path: file.sha256 for file in snapshot.files},
            "containerId": inspected[0], "containerHostname": inspected[2], "image": inspected[1], "versions": versions}


def secret(path: Path, key: str) -> str:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ProbeError("secret_file_permissions")
        result = None
        for line in stream:
            if line.startswith(key + "="):
                if result is not None:
                    raise ProbeError("duplicate_secret_key")
                result = line.split("=", 1)[1].strip()
        if not result:
            raise ProbeError("secret_key_missing")
        if len(result) >= 2 and result[0] == result[-1] and result[0] in {"'", '"'}:
            result = result[1:-1]
        if not result or "\x00" in result or "\n" in result:
            raise ProbeError("invalid_secret_value")
        return result


def verify_identity(row: dict, *, database: str, principal: str, hostname: str) -> None:
    if row.get("database_name") != database or type(row.get("database_id")) is not int or row["database_id"] <= 0:
        raise ProbeError("database_identity_mismatch")
    if any(row.get(key) != principal for key in ("original_login", "login_name", "database_user")):
        raise ProbeError("principal_identity_mismatch")
    if str(row.get("machine_name", "")).casefold() != hostname.casefold():
        raise ProbeError("instance_hostname_mismatch")
    if not row.get("server_name") or not str(row.get("product_version", "")).startswith("15."):
        raise ProbeError("server_identity_mismatch")


def worker() -> int:
    receipt = json.loads(RECEIPT.read_text())
    if receipt.get("status") != "PROBE_STARTED" or any(receipt.get("attempted", {}).values()):
        raise ProbeError("probe_cannot_be_replayed")
    before = preflight()  # Before case imports or secret access.
    package_root = ROOT / "extensions/sales-datamart/src"
    sys.path.insert(0, str(package_root))
    config = importlib.import_module("sales_datamart.config")
    etl = importlib.import_module("sales_datamart.etl")
    loaded = {}
    expected_modules = {"sales_datamart": "__init__.py", "sales_datamart.config": "config.py", "sales_datamart.etl": "etl.py"}
    for name, filename in expected_modules.items():
        location = sys.modules[name].__file__
        if not isinstance(location, str):
            raise ProbeError("loaded_module_has_no_file")
        path = Path(location).resolve()
        relative = str(path.relative_to(ROOT))
        if path != package_root / "sales_datamart" / filename or before["sourceFiles"].get(relative) != digest(path):
            raise ProbeError("loaded_module_identity_mismatch")
        loaded[name] = relative
    receipt["preflight"] = before
    receipt["loadedModules"] = loaded
    receipt["verified"] = {}
    persist(receipt)
    from sqlalchemy import event, text

    def timeouts(dialect, connection_record, args, params):
        # Public SQLAlchemy event; only time budgets, never routing or credentials.
        params["login_timeout"] = 5
        params["timeout"] = 5

    try:
        for role, database, principal, location, key in TARGETS:
            os.environ[key] = secret(ROOT / location, key)
            factory = config.source_connection if role == "source" else config.target_connection
            selected = factory()
            if (selected.host, selected.port, selected.database, selected.username) != ("127.0.0.1", 14334, database, principal):
                raise ProbeError("configuration_identity_mismatch")
            engine = etl._engine(selected)
            try:
                if (engine.url.drivername, engine.url.host, engine.url.port, engine.url.database, engine.url.username) != ("mssql+pytds", "127.0.0.1", 14334, database, principal):
                    raise ProbeError("engine_url_mismatch")
                event.listen(engine, "do_connect", timeouts)
                receipt["attempted"][role] = True
                persist(receipt)  # Durable intent before authentication/query.
                with engine.connect() as connection:
                    row = dict(connection.execute(text(QUERY)).mappings().one())
                receipt["identities"][role] = row
                persist(receipt)
                verify_identity(row, database=database, principal=principal, hostname=before["containerHostname"])
                receipt["verified"][role] = True
                persist(receipt)
            finally:
                engine.dispose()
                os.environ.pop(key, None)
        after = preflight()
        if before != after:
            raise ProbeError("probe_source_or_container_drift")
        left, right = receipt["identities"]["source"], receipt["identities"]["target"]
        if any(left[key] != right[key] for key in ("server_name", "machine_name", "product_version")) or left["database_id"] == right["database_id"]:
            raise ProbeError("instance_or_database_pair_mismatch")
        receipt.update(status="CURRENT_CONFIGURED_CONNECTION_IDENTITIES_VERIFIED", finishedAt=datetime.now(timezone.utc).isoformat(),
                       sourceUnchanged=True, credentialsInReceipt=False, businessRowsRead=False, etlExecuted=False,
                       provesPriorRunIdentity=False, provesTlsServerIdentity=False, metadataWrites=0)
        persist(receipt)
        return 0
    finally:
        for _, _, _, _, key in TARGETS:
            os.environ.pop(key, None)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--execute-approved-probe", action="store_true")
    mode.add_argument("--worker-approved", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker_approved:
        return worker()
    if args.preflight:
        result = preflight()
        print(json.dumps({"status": "PREFLIGHT_ONLY_NO_SECRETS_OR_SQL", "snapshotSha256": result["snapshotSha256"]}))
        return 0
    preflight()
    with RECEIPT.open("x", encoding="utf-8") as output:
        os.chmod(RECEIPT, 0o600)
        json.dump({"status": "PROBE_STARTED", "startedAt": datetime.now(timezone.utc).isoformat(),
                   "attempted": {"source": False, "target": False}, "identities": {}}, output)
    with tempfile.TemporaryDirectory(prefix="identity-probe-", dir=BASE) as home:
        environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "LANG": "C.UTF-8",
                       "DATAHUB_TELEMETRY_ENABLED": "false", "SALESDATAMART_SOURCE_HOST": "127.0.0.1",
                       "SALESDATAMART_TARGET_HOST": "127.0.0.1", "SALESDATAMART_SOURCE_PORT": "14334", "SALESDATAMART_TARGET_PORT": "14334"}
        try:
            completed = subprocess.run([str(ROOT / ".venv/bin/python"), "-I", "-B", str(Path(__file__).resolve()), "--worker-approved"],
                                       env=environment, cwd=ROOT, capture_output=True, timeout=60, check=False)
            if completed.returncode:
                raise ProbeError("probe_worker_failed")
        except (subprocess.TimeoutExpired, ValueError) as error:
            # Child has terminated; never print driver errors, URLs or environments.
            receipt = json.loads(RECEIPT.read_text())
            receipt.update(status="INCOMPLETE_DO_NOT_REPLAY", parentFailureCode=type(error).__name__)
            persist(receipt)
            print(json.dumps({"status": receipt["status"], "receipt": str(RECEIPT.relative_to(ROOT))}))
            return 1
    result = json.loads(RECEIPT.read_text())
    print(json.dumps({"status": result["status"], "receipt": str(RECEIPT.relative_to(ROOT))}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        code = str(error) if isinstance(error, ProbeError) else type(error).__name__
        if "--worker-approved" in sys.argv and RECEIPT.exists():
            try:
                receipt = json.loads(RECEIPT.read_text())
                receipt.update(status="INCOMPLETE_DO_NOT_REPLAY", failureCode=code)
                persist(receipt)
            except Exception:
                pass  # Preserve the pre-query receipt; parent reports missing failure detail.
        print(json.dumps({"status": "STOPPED", "failureCode": code}), file=sys.stderr)
        raise SystemExit(1) from None
