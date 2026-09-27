"""Trusted child: compile metadata-bound queries and optionally execute once.

Secrets arrive on stdin, not argv/environment. Raw driver errors are discarded.
"""
from __future__ import annotations

import importlib
import json
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
import sys

# Only deployment-owned source, not cwd/PYTHONPATH, is imported under python -I.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from metadata_query import QueryError, compile_query, exact, require  # noqa: E402


def connect(dialect, config):
    exact(config, {"host", "port", "username", "password", "database"}, {"serviceName", "cafile"})
    require(all(isinstance(config[k], str) and config[k] and len(config[k]) <= 2048
                for k in ("host", "username", "password", "database")), "query_connection_invalid")
    require(type(config["port"]) is int and 1 <= config["port"] <= 65535, "query_connection_invalid")
    require("cafile" not in config or (dialect == "mssql" and isinstance(config["cafile"], str) and bool(config["cafile"])), "query_connection_invalid")
    require("serviceName" not in config or dialect == "oracle", "query_connection_invalid")
    args = {"host": config["host"], "port": config["port"], "user": config["username"],
            "password": config["password"], "database": config["database"]}
    try:
        if dialect == "mssql":
            driver = importlib.import_module("pytds")
            args["dsn"] = args.pop("host")
            return driver.connect(**args, timeout=30, login_timeout=5, disable_connect_retry=True,
                                  autocommit=False, **({"cafile": config["cafile"], "validate_host": True} if config.get("cafile") else {}))
        if dialect == "postgres":
            driver = importlib.import_module("psycopg2")
            conn = driver.connect(**args, connect_timeout=5, options="-c statement_timeout=30000 -c default_transaction_read_only=on")
            return conn
        if dialect == "mysql":
            driver = importlib.import_module("pymysql")
            conn = driver.connect(**args, connect_timeout=5, read_timeout=30, write_timeout=5, autocommit=False)
            with conn.cursor() as cursor:
                cursor.execute("SET SESSION MAX_EXECUTION_TIME=30000")
                cursor.execute("START TRANSACTION READ ONLY")
            return conn
        if dialect == "oracle":
            driver = importlib.import_module("oracledb")
            service = config.get("serviceName") or config["database"]
            require(isinstance(service, str) and len(service) <= 256, "query_connection_invalid")
            conn = driver.connect(user=args["user"], password=args["password"], host=args["host"],
                                  port=args["port"], service_name=service, tcp_connect_timeout=5)
            conn.call_timeout = 30000
            with conn.cursor() as cursor:
                cursor.execute("SET TRANSACTION READ ONLY")
            return conn
    except (ImportError, ModuleNotFoundError) as error:
        raise QueryError("query_driver_unavailable") from error
    raise QueryError("query_platform_unsupported")


def value_json(value):
    if value is None or isinstance(value, (str, bool)):
        require(not isinstance(value, str) or len(value) <= 8192, "query_result_too_large")
        return value
    if isinstance(value, (Decimal, int)):
        return str(value)  # Preserve decimal/integer precision outside JS/JSON numbers.
    if isinstance(value, float):
        import math
        require(math.isfinite(value), "query_result_invalid")
        return value
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    raise QueryError("query_result_type_unsupported")


def execute(compiled, config, connect_impl=connect):
    wire = compiled.wire("named" if compiled.dialect == "oracle" else "pyformat")
    connection = cursor = None
    try:
        connection = connect_impl(compiled.dialect, config)
        cursor = connection.cursor()
        # SQL is generated above from SQLAlchemy SELECT nodes; values are bound,
        # never interpolated. No model SQL/text() or arbitrary statements here.
        cursor.execute(wire["sql"], wire["parameters"])
        names = [item[0] for item in cursor.description]
        require(names == [c["name"] for c in compiled.columns], "query_result_schema_mismatch")
        rows = cursor.fetchmany(compiled.limit + 1)
        return {"columns": compiled.columns,
                "rows": [dict(zip(names, [value_json(v) for v in row])) for row in rows[:compiled.limit]],
                "truncated": len(rows) > compiled.limit,
                "observedAt": datetime.now(timezone.utc).isoformat(),
                "sql": compiled.wire()["sql"]}
    finally:
        try:
            if cursor is not None:
                cursor.close()
        finally:
            if connection is not None:
                try:
                    connection.rollback()  # Never commit, including on successful reads.
                finally:
                    connection.close()


def run(request):
    exact(request, {"operation", "plan", "metadata", "binding"}, {"connection"})
    require(request["operation"] in {"compile", "execute"})
    compiled = compile_query(request["plan"], request["metadata"], request["binding"])
    if request["operation"] == "compile":
        require("connection" not in request)
        return compiled.wire()
    require("connection" in request, "query_connection_unavailable")
    require(request["connection"].get("database") == request["binding"]["database"], "query_source_mismatch")
    return execute(compiled, request["connection"])


def public_error(error):
    """Map DB-native refusal codes, including DB-API args (MySQL / Oracle)."""
    if isinstance(error, QueryError):
        return str(error)
    codes = [getattr(error, name, None) for name in ("number", "pgcode", "errno")]
    first = error.args[0] if error.args else None
    if isinstance(first, int):
        codes.append(first)
    codes.append(getattr(first, "code", None))
    return "query_source_denied" if any(code in (229, 230, 916, 1031, 1044, 1045, 1142, "42501") for code in codes) else "query_execution_unconfirmed"


def main():
    try:
        raw = sys.stdin.buffer.read(524289)
        require(len(raw) <= 524288, "query_request_too_large")
        request = json.loads(raw)
        result = run(request)
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False)
        require(len(encoded.encode()) <= 1048576, "query_result_too_large")
        print(encoded)
        return 0
    except Exception as error:
        # Never stringify DB exceptions (SQL, literals, endpoints or secrets).
        print(json.dumps({"error": public_error(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
