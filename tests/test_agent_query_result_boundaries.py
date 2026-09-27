"""Offline result boundaries: real compiler/serializer, explicitly fake DB-API."""
from copy import deepcopy
from datetime import date, datetime, timezone
from decimal import Decimal
import importlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "extensions/datahub-agent/integration"))
compiler = importlib.import_module("metadata_query")
runner = importlib.import_module("query_runner")

FIELDS = [("id", "bigint"), ("amount", "decimal(38,18)"), ("label", "nvarchar(100)"),
          ("day", "date"), ("enabled", "bit")]
META = [{"urn": "urn:li:dataset:(urn:li:dataPlatform:mssql,boundary.dbo.probe,TEST)",
         "qualifiedName": "boundary.dbo.probe", "platform": "mssql", "platformInstanceUrn": None,
         "environment": "TEST", "fields": [{"path": n, "nativeType": t} for n, t in FIELDS]}]
BINDING = {"database": "boundary", "platform": "mssql", "platformInstanceUrn": None,
           "environment": "TEST", "datasetPrefix": ""}
PLAN = {"datasets": [{"urn": META[0]["urn"], "alias": "p"}], "joins": [],
        "select": [{"field": {"dataset": "p", "field": n}, "as": n} for n, _ in FIELDS],
        "filters": [], "groupBy": [], "orderBy": [{"field": "id", "direction": "asc"}], "limit": 2}


def execute_rows(rows, plan=None):
    events = []
    compiled = compiler.compile_query(plan or PLAN, META, BINDING)

    class Cursor:
        description = [(c["name"],) for c in compiled.columns]

        def execute(self, sql, params):
            events.append("execute")

        def fetchmany(self, size):
            events.append(("fetchmany", size))
            return rows[:size]

        def close(self):
            events.append("cursor_close")

    class Connection:
        def cursor(self):
            return Cursor()

        def rollback(self):
            events.append("rollback")

        def close(self):
            events.append("close")

    try:
        return runner.execute(compiled, {}, lambda *_: Connection()), events
    except Exception:
        assert events[-3:] == ["cursor_close", "rollback", "close"]
        raise


class ResultBoundaries(unittest.TestCase):
    def test_exact_decimal_bigint_null_boolean_date_and_empty_string_json(self):
        rows = [(9223372036854775807, Decimal("12345678901234567890.123456789012345678"),
                 "", date(2026, 9, 27), False),
                (-9223372036854775808, None, "中文📦", None, True)]
        result, events = execute_rows(rows)
        wire = json.loads(json.dumps(result, allow_nan=False))
        self.assertEqual(wire["rows"], [
            {"id": "9223372036854775807", "amount": "12345678901234567890.123456789012345678",
             "label": "", "day": "2026-09-27", "enabled": False},
            {"id": "-9223372036854775808", "amount": None, "label": "中文📦", "day": None, "enabled": True}])
        self.assertFalse(wire["truncated"])
        self.assertEqual(events.count("execute"), 1)
        self.assertEqual(events[-3:], ["cursor_close", "rollback", "close"])
        encoded_zero = runner.value_json(Decimal("-0.000000000000000000"))
        self.assertEqual(Decimal(encoded_zero).as_tuple(), Decimal("-0.000000000000000000").as_tuple())
        self.assertEqual(runner.value_json(datetime(2026, 9, 27, tzinfo=timezone.utc)), "2026-09-27T00:00:00+00:00")

    def test_empty_is_no_rows_but_null_and_count_zero_are_real_rows(self):
        empty, _ = execute_rows([])
        self.assertEqual(empty["rows"], [])
        self.assertEqual(len(empty["columns"]), len(FIELDS))
        self.assertFalse(empty["truncated"])
        aggregate = deepcopy(PLAN)
        aggregate.update(select=[{"field": {"dataset": "p", "field": "amount"}, "aggregate": "sum", "as": "total"},
                                 {"field": None, "aggregate": "count", "as": "count"}], orderBy=[])
        result, _ = execute_rows([(None, 0)], aggregate)
        self.assertEqual(result["rows"], [{"total": None, "count": "0"}])
        self.assertFalse(result["truncated"])

    def test_limit_lookahead_not_equal_length_inference(self):
        for limit in (1, 2, 1000):
            for size in (0, limit - 1, limit, limit + 1):
                with self.subTest(limit=limit, size=size):
                    plan = dict(PLAN, limit=limit)
                    rows = [(n, Decimal("0.00"), "", None, False) for n in range(size)]
                    result, events = execute_rows(rows, plan)
                    self.assertEqual(len(result["rows"]), min(size, limit))
                    self.assertEqual(result["truncated"], size > limit)
                    self.assertIn(("fetchmany", limit + 1), events)
                    self.assertEqual(events.count("execute"), 1)

    def test_invalid_limits_refused_before_connection(self):
        for limit in (0, -1, 1001, True, 1.5, "2"):
            with self.subTest(limit=limit), self.assertRaises(compiler.QueryError):
                compiler.compile_query(dict(PLAN, limit=limit), META, BINDING)

    def test_cell_boundary_and_invalid_values_fail_without_coercion(self):
        self.assertEqual(runner.value_json("界" * 8192), "界" * 8192)
        for value, error in [("界" * 8193, "query_result_too_large"),
                             (float("nan"), "query_result_invalid"),
                             (float("inf"), "query_result_invalid"),
                             (b"binary", "query_result_type_unsupported")]:
            with self.subTest(error=error), self.assertRaisesRegex(compiler.QueryError, error):
                execute_rows([(1, None, value, None, False)])

    def test_child_main_byte_limit_emits_only_safe_error(self):
        # Exercise actual main JSON byte accounting in a credential-free process;
        # the execute callback is a synthetic fixture, not a DB connection.
        code = """
import sys, json
sys.path.insert(0, sys.argv[1])
import query_runner as r
r.run = lambda _: {'rows': [{'payload': '界' * 8192}] * 50}
raise SystemExit(r.main())
"""
        run = subprocess.run([sys.executable, "-I", "-B", "-c", code,
                              str(ROOT / "extensions/datahub-agent/integration")],
                             input="{}", capture_output=True, text=True, timeout=10,
                             env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        self.assertEqual(run.returncode, 1)
        self.assertEqual(json.loads(run.stdout), {"error": "query_result_too_large"})
        self.assertEqual(run.stderr, "")


if __name__ == "__main__":
    unittest.main()
