"""Protected Host-only fixed reporting query child; never an Agent shell tool."""

from __future__ import annotations

from hashlib import sha256
import json
import os
import sys
from typing import Any

from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL
from sqlalchemy.pool import NullPool

from .agent_query import SALES_BY_CATEGORY, QueryInconclusive, sales_by_category, validate_range


PREFLIGHT = text("""
SELECT ORIGINAL_LOGIN() AS login_name, DB_NAME() AS database_name,
       HAS_PERMS_BY_NAME(N'reporting.v_sales_order_line', N'OBJECT', N'SELECT') AS can_select_view,
       HAS_PERMS_BY_NAME(N'reporting', N'SCHEMA', N'INSERT') AS can_insert_reporting,
       HAS_PERMS_BY_NAME(N'reporting', N'SCHEMA', N'UPDATE') AS can_update_reporting,
       HAS_PERMS_BY_NAME(N'reporting', N'SCHEMA', N'DELETE') AS can_delete_reporting,
       HAS_PERMS_BY_NAME(N'dm', N'SCHEMA', N'SELECT') AS can_select_dm,
       IS_SRVROLEMEMBER(N'sysadmin') AS server_admin,
       IS_ROLEMEMBER(N'db_owner') AS db_owner
""")


def run(connection: Any, from_date: str, through: str) -> dict[str, Any]:
    """Fail before the business SELECT if login or effective privilege has drifted."""
    validate_range(from_date, through)
    # pi-lens-ignore: python-sql-injection
    result = connection.execute(PREFLIGHT)
    try:
        rows = list(result.mappings())
    finally:
        result.close()
    if (len(rows) != 1 or dict(rows[0]) != {
        "login_name": "sales_datamart_grafana", "database_name": "SalesDatamart",
        "can_select_view": 1, "can_insert_reporting": 0,
        "can_update_reporting": 0, "can_delete_reporting": 0,
        "can_select_dm": 0, "server_admin": 0, "db_owner": 0,
    }):
        raise QueryInconclusive("sql_source_permission_unconfirmed")
    return sales_by_category(connection, from_date, through)


def main() -> int:
    if len(sys.argv) != 5 or sys.argv[1] != "--host-controlled" or \
            len(sys.argv[4]) != 64 or \
            sha256(str(SALES_BY_CATEGORY).encode()).hexdigest() != sys.argv[4]:
        raise QueryInconclusive("sql_query_version_mismatch")
    password = os.environ.get("SALESDATAMART_GRAFANA_PASSWORD")
    if not password:
        raise QueryInconclusive("sql_secret_unavailable")
    engine = create_engine(
        URL.create("mssql+pytds", username="sales_datamart_grafana",
                   password=password, host="127.0.0.1", port=14334,
                   database="SalesDatamart"),
        connect_args={"validate_host": False, "timeout": 30,
                      "login_timeout": 5, "disable_connect_retry": True},
        poolclass=NullPool, future=True,
    )
    try:
        connection = engine.connect()
        try:
            result = run(connection, sys.argv[2], sys.argv[3])
        finally:
            connection.close()
    finally:
        engine.dispose()
    # No raw SQL, credentials or database exception text in stdout/stderr.
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        sys.stderr.write("sql_execution_unconfirmed\n")
        raise SystemExit(1) from None
