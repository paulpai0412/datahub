#!/usr/bin/env python3
"""Operator-approved, one-shot SQL-native recovery drill; never an Agent tool.

Creates COPY_ONLY backups and a new isolated instance/volume. Never cleans up,
replaces databases, retries writes, or changes the original service. Credentials
are not emitted. Three required logins are re-created on the clone with the
restored user SIDs and fresh temporary passwords, without granting extra roles.
This is not a backup/restore of master, jobs, or original login secrets.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "wferp-mssql-test"
SOURCE_ID = "284caebbc279fbb23f532c0406baeb3e4f9ac922aec972694c4321f1c2f209b1"
IMAGE = "mcr.microsoft.com/mssql/server@sha256:46f719fd3457d4e7e8e5845fe00c35c20e7bae7ff1e8b9fe595f2a81029f5ba8"
CLONE = "dataflow-discovery-restore-check"
VOLUME = "dataflow-discovery-restore-check-data"
DATABASES = ("AdventureWorks2019", "SalesDatamart")
TABLES = ("Sales.SalesOrderHeader", "Sales.SalesOrderDetail", "Sales.Customer", "Sales.SalesTerritory",
          "Production.Product", "Production.ProductSubcategory", "Production.ProductCategory")
TARGETS = ("dm.dim_date", "dm.dim_product", "dm.dim_customer", "dm.dim_territory", "dm.fact_sales_order_line", "reporting.v_sales_order_line")
SQLCMD = '/opt/mssql-tools18/bin/sqlcmd'


def command(args: list[str], *, sql: str | None = None, timeout: int = 120) -> str:
    result = subprocess.run(args, input=sql, text=True, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        # Never emit raw command stderr: credential/login errors can be sensitive.
        raise RuntimeError(f"command_exit_{result.returncode}")
    return result.stdout.strip()


def query(container: str, sql: str, *, timeout: int = 120) -> str:
    return command(["docker", "exec", "-i", container, "sh", "-c",
                    f'SQLCMDPASSWORD="$MSSQL_SA_PASSWORD" {SQLCMD} -S tcp:127.0.0.1,1433 -U sa -C -b -m 1 -l 5 -t 110 -h -1 -W -s \"|\" -w 65535'],
                   sql="SET NOCOUNT ON;\n" + sql + "\nGO\n", timeout=timeout)


def literal(value: str) -> str:
    return "N'" + value.replace("'", "''") + "'"


def measurement_sql() -> str:
    parts: list[str] = []
    for database, tables in ((DATABASES[0], TABLES), (DATABASES[1], TARGETS)):
        parts.append(f"USE [{database}];")
        for table in tables:
            parts.append(f"SELECT 'COUNT|{database}|{table}|' + CONVERT(varchar(30),COUNT_BIG(*)) FROM {table};")
        allowed = ",".join(literal(name) for name in tables)
        parts.append(f"""
SELECT 'COLUMN|{database}|' + CONVERT(varchar(64), HASHBYTES('SHA2_256',
  CONCAT(CONVERT(nvarchar(max),s.name),'.',o.name,'.',c.name,'|',t.name,'|',c.max_length,'|',c.precision,'|',c.scale,
         '|',c.is_nullable,'|',c.is_identity,'|',c.is_computed,'|',c.collation_name,'|',OBJECT_DEFINITION(c.default_object_id))),2)
FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
JOIN sys.columns c ON c.object_id=o.object_id JOIN sys.types t ON t.user_type_id=c.user_type_id
WHERE s.name+'.'+o.name IN ({allowed}) ORDER BY s.name,o.name,c.column_id;
SELECT 'CONSTRAINT|{database}|' + CONVERT(varchar(64),HASHBYTES('SHA2_256',CONCAT(name,'|',definition,'|',is_disabled,'|',is_not_trusted)),2)
FROM sys.check_constraints WHERE OBJECT_SCHEMA_NAME(parent_object_id)+'.'+OBJECT_NAME(parent_object_id) IN ({allowed}) ORDER BY name;
SELECT 'FOREIGN_KEY|{database}|' + CONVERT(varchar(64),HASHBYTES('SHA2_256',CONCAT(name,'|',is_disabled,'|',is_not_trusted,'|',delete_referential_action,'|',update_referential_action)),2)
FROM sys.foreign_keys WHERE OBJECT_SCHEMA_NAME(parent_object_id)+'.'+OBJECT_NAME(parent_object_id) IN ({allowed}) ORDER BY name;
""")
    parts.append("""
USE [SalesDatamart];
SELECT 'TOTAL|fact|' + CONVERT(varchar(30),COUNT_BIG(*))+'|'+CONVERT(varchar(30),COUNT(DISTINCT SalesOrderID))+'|'+CONVERT(varchar(30),SUM(CONVERT(bigint,OrderQty)))+'|'+CONVERT(varchar(50),SUM(LineNetAmount)) FROM dm.fact_sales_order_line;
SELECT 'TOTAL|view|' + CONVERT(varchar(30),COUNT_BIG(*))+'|'+CONVERT(varchar(30),COUNT(DISTINCT SalesOrderID))+'|'+CONVERT(varchar(30),SUM(CONVERT(bigint,OrderQty)))+'|'+CONVERT(varchar(50),SUM(LineNetAmount)) FROM reporting.v_sales_order_line;
EXECUTE AS USER = 'sales_datamart_loader';
SELECT 'ACL|loader|'+CONCAT(HAS_PERMS_BY_NAME('dm','SCHEMA','SELECT'),'|',HAS_PERMS_BY_NAME('dm','SCHEMA','INSERT'),'|',HAS_PERMS_BY_NAME('dm','SCHEMA','UPDATE'),'|',HAS_PERMS_BY_NAME('dm','SCHEMA','DELETE'),'|',HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CREATE TABLE'),'|',HAS_PERMS_BY_NAME('dm','SCHEMA','ALTER'),'|',HAS_PERMS_BY_NAME('reporting','SCHEMA','SELECT'));
REVERT;
EXECUTE AS USER = 'sales_datamart_grafana';
SELECT 'ACL|grafana|'+CONCAT(HAS_PERMS_BY_NAME('dm','SCHEMA','SELECT'),'|',HAS_PERMS_BY_NAME('dm','SCHEMA','INSERT'),'|',HAS_PERMS_BY_NAME('dm','SCHEMA','UPDATE'),'|',HAS_PERMS_BY_NAME('dm','SCHEMA','DELETE'),'|',HAS_PERMS_BY_NAME('reporting','SCHEMA','SELECT'),'|',HAS_PERMS_BY_NAME('reporting','SCHEMA','INSERT'),'|',HAS_PERMS_BY_NAME('reporting','SCHEMA','ALTER'));
REVERT;
USE [AdventureWorks2019];
EXECUTE AS USER = 'datahub_ingest';
""")
    for table in TABLES:
        parts.append(f"SELECT 'ACL|reader|{table}|'+CONCAT(HAS_PERMS_BY_NAME('{table}','OBJECT','SELECT'),'|',HAS_PERMS_BY_NAME('{table}','OBJECT','VIEW DEFINITION'),'|',HAS_PERMS_BY_NAME('{table}','OBJECT','INSERT'),'|',HAS_PERMS_BY_NAME('{table}','OBJECT','UPDATE'),'|',HAS_PERMS_BY_NAME('{table}','OBJECT','DELETE'),'|',IS_ROLEMEMBER('db_datareader'));")
    parts.append("""
BEGIN TRY
  EXEC('SELECT TOP (0) 1 FROM Sales.SalesReason');
  SELECT 'ACL|excluded_table|UNEXPECTED_ACCESS';
END TRY
BEGIN CATCH
  SELECT 'ACL|excluded_table|'+CONVERT(varchar(20),ERROR_NUMBER());
END CATCH;
REVERT;
""")
    return "\n".join(parts)


def measure(container: str) -> list[str]:
    lines = [line.strip() for line in query(container, measurement_sql()).splitlines() if line.strip()]
    allowed = ("COUNT|", "COLUMN|", "CONSTRAINT|", "FOREIGN_KEY|", "TOTAL|", "ACL|")
    if not lines or any(not line.startswith(allowed) for line in lines):
        raise RuntimeError("unexpected_measurement_output")
    required = {"ACL|loader|1|1|1|1|0|0|1", "ACL|grafana|0|0|0|0|1|0|0", "ACL|excluded_table|229"}
    required.update(f"ACL|reader|{table}|1|1|0|0|0|0" for table in TABLES)
    if not required.issubset(lines):
        raise RuntimeError("least_privilege_check_failed")
    return lines


def restore_database(database: str, backup: Path, files: list[tuple[str, str]]) -> None:
    """One database on the already-created isolated clone; no replace/retry."""
    if database not in DATABASES:
        raise RuntimeError("database_outside_approved_scope")
    query(CLONE, f"IF DB_ID({literal(database)}) IS NOT NULL THROW 51000, 'restore_target_exists', 1;")
    remote = f"/var/opt/mssql/data/{database}-recovery.bak"
    exists = subprocess.run(["docker", "exec", CLONE, "test", "-e", remote], capture_output=True, check=False, timeout=10)
    if exists.returncode == 1:
        command(["docker", "cp", str(backup), f"{CLONE}:{remote}"])
    elif exists.returncode != 0:
        raise RuntimeError("backup_copy_state_unknown")
    # Reuse a partially completed copy only after proving identical bytes;
    # never overwrite an existing backup. The image's mssql user has gid 0,
    # not a group named mssql, so ask the running pinned image for both IDs.
    with backup.open('rb') as stream:
        expected_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
    copied_hash = command(["docker", "exec", "-u", "0", CLONE, "sha256sum", remote]).split()[0]
    if copied_hash != expected_hash:
        raise RuntimeError("existing_backup_copy_mismatch")
    uid = command(["docker", "exec", CLONE, "id", "-u"])
    gid = command(["docker", "exec", CLONE, "id", "-g"])
    if not uid.isdecimal() or not gid.isdecimal():
        raise RuntimeError("clone_user_identity_unknown")
    command(["docker", "exec", "-u", "0", CLONE, "chown", f"{uid}:{gid}", remote])
    command(["docker", "exec", "-u", "0", CLONE, "chmod", "600", remote])
    query(CLONE, f"RESTORE VERIFYONLY FROM DISK={literal(remote)} WITH CHECKSUM;")
    moves = ', '.join(f"MOVE {literal(name)} TO {literal('/var/opt/mssql/data/'+database+'-restored.'+('ldf' if kind=='LOG' else 'mdf'))}" for name, kind in files)
    query(CLONE, f"IF DB_ID({literal(database)}) IS NOT NULL THROW 51000, 'restore_target_exists', 1; RESTORE DATABASE [{database}] FROM DISK={literal(remote)} WITH {moves}, RECOVERY, CHECKSUM;")
    query(CLONE, f"DBCC CHECKDB([{database}]) WITH PHYSICAL_ONLY, NO_INFOMSGS;")


def restore_required_logins() -> list[str]:
    """Re-create only the three required clone logins; never read source secrets."""
    principals = (("AdventureWorks2019", "datahub_ingest"),
                  ("SalesDatamart", "sales_datamart_loader"),
                  ("SalesDatamart", "sales_datamart_grafana"))
    secret_path = ROOT / '.local/sqlserver/restore-check-principals.env'
    # Refuse ambiguous replay; a partial login creation requires reconciliation.
    if secret_path.exists():
        raise RuntimeError('clone_principal_secrets_already_exist')
    identities = []
    for database, login in principals:
        if query(CLONE, f"SELECT CASE WHEN SUSER_ID({literal(login)}) IS NULL THEN 'MISSING' ELSE 'EXISTS' END;") != 'MISSING':
            raise RuntimeError('clone_principal_already_exists')
        sid = query(CLONE, f"USE [{database}]; SELECT CONVERT(varchar(514),sid,1) FROM sys.database_principals WHERE name={literal(login)} AND type='S' AND authentication_type_desc='INSTANCE';")
        if not re.fullmatch(r'0x[0-9a-fA-F]{32}', sid):
            raise RuntimeError('restored_user_sid_not_supported')
        identities.append((database, login, sid))
    passwords = {login: secrets.token_urlsafe(32)+'aA1!' for _, login in principals}
    with secret_path.open('x') as stream:
        stream.write(''.join(login.upper()+'_PASSWORD='+password+'\n' for login,password in passwords.items()))
    secret_path.chmod(0o600)
    probes = []
    tables = {'datahub_ingest': 'Sales.SalesOrderHeader', 'sales_datamart_loader': 'dm.fact_sales_order_line',
              'sales_datamart_grafana': 'reporting.v_sales_order_line'}
    for database, login, sid in identities:
        query(CLONE, f"CREATE LOGIN [{login}] WITH PASSWORD={literal(passwords[login])}, SID={sid}, DEFAULT_DATABASE=[{database}], CHECK_POLICY=ON, CHECK_EXPIRATION=OFF;")
        # Supply the temporary password over stdin, not argv or emitted logs.
        shell = ('IFS= read -r login; IFS= read -r SQLCMDPASSWORD; export SQLCMDPASSWORD; '
                 f'exec {SQLCMD} -S tcp:127.0.0.1,1433 -U "$login" -d {database} -C -b -m 1 -l 5 -t 30 -h -1 -W')
        sql = f"SET NOCOUNT ON; SELECT 'AUTH|{login}|'+CONVERT(varchar(30),COUNT_BIG(*)) FROM {tables[login]};\nGO\n"
        result = command(['docker','exec','-i',CLONE,'sh','-c',shell], sql=login+'\n'+passwords[login]+'\n'+sql)
        if not re.fullmatch(r'AUTH\|'+re.escape(login)+r'\|[0-9]+', result):
            raise RuntimeError('clone_login_probe_not_verified')
        probes.append(result)
    return probes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-approved-drill", action="store_true", required=True)
    parser.parse_args()
    os.umask(0o077)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(4)
    output = ROOT / ".local/evidence/dataflow-discovery" / f"recovery-drill-{run_id}.json"
    receipt: dict = {"run_id": run_id, "source": SOURCE, "clone": CLONE, "volume": VOLUME,
                     "image": IMAGE, "status": "IN_PROGRESS", "stage": "preflight", "backups": [], "cleanup_performed": False}
    def save() -> None:
        output.write_text(json.dumps(receipt, indent=2) + "\n")
        output.chmod(0o600)
    save()
    try:
        actual = command(["docker", "inspect", "--format", "{{.Id}}|{{.Config.Image}}|{{.State.Status}}", SOURCE])
        if actual != f"{SOURCE_ID}|{IMAGE}|running":
            raise RuntimeError("source_identity_changed")
        if command(["docker", "ps", "-a", "--filter", f"name=^{CLONE}$", "--format", "{{.Names}}"]):
            raise RuntimeError("clone_already_exists_reconcile_do_not_replay")
        if VOLUME in command(["docker", "volume", "ls", "--format", "{{.Name}}"] ).splitlines():
            raise RuntimeError("volume_already_exists_reconcile_do_not_replay")
        secret_file = ROOT / ".local/sqlserver/restore-check.env"
        if secret_file.exists() or (ROOT / '.local/sqlserver/restore-check-principals.env').exists():
            raise RuntimeError("clone_secret_file_already_exists")
        free_kib = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))
        if free_kib * 1024 < 4_000_000_000:
            raise RuntimeError("insufficient_memory_for_isolated_drill")
        folder = ROOT / ".local/sqlserver/backups" / run_id
        folder.mkdir(parents=True, mode=0o700)
        before = measure(SOURCE)
        receipt["source_before"] = before
        logical_files: dict[str, list[tuple[str, str]]] = {}
        for database in DATABASES:
            receipt["stage"] = f"inspect_files_{database}"; save()
            files = query(SOURCE, f"USE [{database}]; SELECT name, type_desc FROM sys.database_files ORDER BY file_id;")
            logical_files[database] = []
            for line in files.splitlines():
                if not line.strip():
                    continue
                name, separator, kind = line.strip().partition('|')
                if not separator or not name or kind not in {'LOG', 'ROWS'}:
                    raise RuntimeError("unexpected_database_file_layout")
                logical_files[database].append((name, kind))
            if sorted(kind for _, kind in logical_files[database]) != ["LOG", "ROWS"]:
                raise RuntimeError("unexpected_database_file_layout")
            receipt["source_logical_files"] = logical_files
            receipt["stage"] = f"backup_{database}"; save()
            remote = f"/var/opt/mssql/data/discovery-{run_id}-{database}.bak"
            command(["docker", "exec", SOURCE, "test", "!", "-e", remote])
            query(SOURCE, f"BACKUP DATABASE [{database}] TO DISK={literal(remote)} WITH COPY_ONLY, CHECKSUM;")
            target = folder / f"{database}.bak"
            command(["docker", "cp", f"{SOURCE}:{remote}", str(target)])
            target.chmod(0o600)
            with target.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            receipt["backups"].append({"database": database, "host_file": str(target.relative_to(ROOT)), "source_staging_file": remote,
                                       "sha256": digest, "bytes": target.stat().st_size, "copy_only": True})
            save()
        # Recheck resource budget after backup work, before deploying a new process.
        free_kib = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))
        if free_kib * 1024 < 4_000_000_000:
            raise RuntimeError("insufficient_memory_for_isolated_drill")
        with secret_file.open('x') as stream:
            stream.write('ACCEPT_EULA=Y\nMSSQL_PID=Developer\nMSSQL_MEMORY_LIMIT_MB=1536\nMSSQL_SA_PASSWORD='+secrets.token_urlsafe(32)+'aA1!\n')
        secret_file.chmod(0o600)
        receipt["stage"] = "create_isolated_volume"; save()
        command(["docker", "volume", "create", "--label", f"dataflow.discovery.drill={run_id}", VOLUME])
        receipt["stage"] = "start_isolated_container"; save()
        receipt["clone_id"] = command(["docker", "run", "-d", "--pull", "never", "--name", CLONE, "--network", "none",
                                       "--memory", "2g", "--cpus", "1.5", "--restart", "no", "--env-file", str(secret_file),
                                       "--mount", f"type=volume,source={VOLUME},target=/var/opt/mssql", IMAGE])
        save()
        ready = False
        for _ in range(45):
            try:
                if query(CLONE, "SELECT 'READY';", timeout=10).strip() == 'READY':
                    ready = True
                    break
            except (RuntimeError, subprocess.TimeoutExpired):
                time.sleep(2)
        if not ready:
            raise RuntimeError("isolated_sql_not_ready")
        for database in DATABASES:
            receipt["stage"] = f"restore_{database}"; save()
            restore_database(database, folder / f"{database}.bak", logical_files[database])
            receipt.setdefault("restored_databases", []).append(database)
            save()
        receipt["stage"] = "restore_required_logins"; save()
        receipt["clone_login_probes"] = restore_required_logins()
        receipt["stage"] = "compare_restored_data_and_permissions"; save()
        restored = measure(CLONE)
        after = measure(SOURCE)
        receipt.update(restored=restored, source_after=after)
        if before != restored or before != after:
            raise RuntimeError("restore_or_source_drift_mismatch")
        receipt.update(status="PASS", stage="complete", scope="two_database_native_backup_restore_and_database_user_permissions",
                       server_logins_restored=False, required_logins_reprovisioned=True,
                       original_service_modified=False, resources_retained=True)
        save()
        print(json.dumps({"status": "PASS", "receipt": str(output.relative_to(ROOT)), "clone": CLONE, "resources_retained": True}))
    except Exception as error:
        receipt.update(status="INCOMPLETE_RECONCILE_BEFORE_RETRY", error_type=type(error).__name__)
        if isinstance(error, RuntimeError):
            receipt["error_code"] = str(error)
        save()
        print(json.dumps({"status": receipt["status"], "stage": receipt["stage"], "receipt": str(output.relative_to(ROOT)), "error_type":type(error).__name__}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
