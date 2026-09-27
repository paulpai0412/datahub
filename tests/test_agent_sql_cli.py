from __future__ import annotations

from datetime import date
from decimal import Decimal
import importlib
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions/sales-datamart/src"))
cli = importlib.import_module("sales_datamart.sql_cli")
agent_query = importlib.import_module("sales_datamart.agent_query")


class FakeResult:
    def __init__(self, rows):
        self.rows = rows
        self.closed = False

    def mappings(self):
        return iter(self.rows)

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, preflight, rows):
        self.results = [FakeResult([preflight]), FakeResult(rows)]
        self.calls = []

    def execute(self, statement, params=None):
        self.calls.append((statement, params))
        return self.results[len(self.calls) - 1]


PERMITTED = {
    "login_name": "sales_datamart_grafana", "database_name": "SalesDatamart",
    "can_select_view": 1, "can_insert_reporting": 0,
    "can_update_reporting": 0, "can_delete_reporting": 0,
    "can_select_dm": 0, "server_admin": 0, "db_owner": 0,
}
ROWS = [{"month": date(2014, 6, 1), "category": "Bikes", "sales_amount": Decimal("12.000001")}]


class SqlChildTests(unittest.TestCase):
    def test_identity_preflight_then_one_bound_business_select(self):
        conn = FakeConnection(PERMITTED, ROWS)
        value = cli.run(conn, "2014-06-01", "2014-06-30")
        self.assertEqual(value["points"], [{"month": "2014-06-01",
                                            "category": "Bikes", "salesAmount": "12.000001"}])
        self.assertEqual(len(conn.calls), 2)
        self.assertIs(conn.calls[0][0], cli.PREFLIGHT)
        self.assertIs(conn.calls[1][0], agent_query.SALES_BY_CATEGORY)
        self.assertEqual(conn.calls[1][1]["end_exclusive"], date(2014, 7, 1))
        self.assertTrue(all(result.closed for result in conn.results))

    def test_invalid_dates_rejected_before_permission_query(self):
        conn = FakeConnection(PERMITTED, ROWS)
        with self.assertRaises(agent_query.QueryInconclusive):
            cli.run(conn, "2014-06-31", "2014-06-30")
        self.assertEqual(conn.calls, [])

    def test_denied_or_changed_login_never_reaches_aggregate(self):
        for bad in [
            {**PERMITTED, "login_name": "sales_datamart_loader"},
            {**PERMITTED, "can_select_view": 0},
            {**PERMITTED, "can_select_dm": 1},
            {**PERMITTED, "server_admin": 1},
            {**PERMITTED, "db_owner": 1},
            {**PERMITTED, "can_update_reporting": 1},
            {**PERMITTED, "extra": "unknown"},
        ]:
            conn = FakeConnection(bad, ROWS)
            with self.subTest(bad=bad), self.assertRaises(agent_query.QueryInconclusive):
                cli.run(conn, "2014-06-01", "2014-06-30")
            self.assertEqual(len(conn.calls), 1)
            self.assertTrue(conn.results[0].closed)

    def test_wrong_approved_query_digest_stops_before_credentials_or_connect(self):
        with patch.object(sys, "argv", ["module", "--host-controlled", "2014-06-01",
                                        "2014-06-30", "0" * 64]), \
             patch.dict("os.environ", {}, clear=True), \
             patch.object(cli, "create_engine") as engine:
            with self.assertRaises(agent_query.QueryInconclusive):
                cli.main()
            engine.assert_not_called()


if __name__ == "__main__":
    unittest.main()
