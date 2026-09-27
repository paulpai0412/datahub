from __future__ import annotations

from datetime import date
from decimal import Decimal
import importlib
from pathlib import Path
import sys
import unittest

import sqlglot
from sqlglot import exp

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions/sales-datamart/src"))
agent_query = importlib.import_module("sales_datamart.agent_query")
QueryInconclusive = agent_query.QueryInconclusive
SALES_BY_CATEGORY = agent_query.SALES_BY_CATEGORY
sales_by_category = agent_query.sales_by_category


class FakeResult:
    def __init__(self, rows):
        self.rows = rows
        self.closed = False

    def mappings(self):
        return iter(self.rows)

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, rows):
        self.result = FakeResult(rows)
        self.statement = None
        self.params = None

    def execute(self, statement, params):
        self.statement, self.params = statement, params
        return self.result


class SalesByCategoryTests(unittest.TestCase):
    def test_static_statement_is_bounded_and_has_only_the_reporting_view(self):
        statements = sqlglot.parse(str(SALES_BY_CATEGORY), read="tsql")
        self.assertEqual(len(statements), 1)
        query = statements[0]
        assert isinstance(query, exp.Select)
        self.assertEqual(len(list(query.find_all(exp.Table))), 1)
        self.assertEqual(len(list(query.find_all(exp.Join))), 0)
        self.assertEqual(next(query.find_all(exp.Table)).sql(dialect="tsql"),
                         "[reporting].[v_sales_order_line]")
        self.assertIn("TOP (201)", str(SALES_BY_CATEGORY))
        self.assertIn("[OrderDate] < :end_exclusive", str(SALES_BY_CATEGORY))
        self.assertEqual(set(SALES_BY_CATEGORY._bindparams), {"from_date", "end_exclusive"})

    def test_bound_dates_and_decimal_rows_no_text_or_secret_in_receipt(self):
        connection = FakeConnection([
            {"month": date(2014, 6, 1), "category": "Bikes", "sales_amount": Decimal("120.500001")},
            {"month": date(2014, 6, 1), "category": "Clothing", "sales_amount": Decimal("0.300000")},
        ])
        result = sales_by_category(connection, "2014-06-01", "2014-06-30")
        self.assertEqual(connection.params,
                         {"from_date": date(2014, 6, 1), "end_exclusive": date(2014, 7, 1)})
        self.assertIs(connection.statement, SALES_BY_CATEGORY)
        self.assertTrue(connection.result.closed)
        self.assertTrue(result["complete"])
        self.assertIsNone(result["dataAsOf"])
        self.assertEqual(result["points"], [
            {"month": "2014-06-01", "category": "Bikes", "salesAmount": "120.500001"},
            {"month": "2014-06-01", "category": "Clothing", "salesAmount": "0.300000"},
        ])
        self.assertEqual(set(result), {"complete", "observedAt", "dataAsOf", "points"})

    def test_invalid_range_rejected_before_execute(self):
        for first, last in [("2014-07-01", "2014-07-02"), ("2014-06-31", "2014-06-31"),
                            ("2014-06-30", "2014-06-01"), ("2014-06-01;DROP", "2014-06-30")]:
            connection = FakeConnection([])
            with self.subTest(first=first, last=last), self.assertRaises(QueryInconclusive):
                sales_by_category(connection, first, last)
            self.assertIsNone(connection.statement)

    def test_zero_rows_overflow_and_unexpected_result_fail_closed_and_close(self):
        good = {"month": date(2014, 6, 1), "category": "Bikes", "sales_amount": Decimal("1.000000")}
        for rows in [[], [good] * 201,
                     [{**good, "category": "bad\nname"}],
                     [{**good, "month": date(2014, 5, 1)}],
                     [{**good, "sales_amount": Decimal("NaN")}]]:
            connection = FakeConnection(rows)
            with self.subTest(rows=len(rows)), self.assertRaises(QueryInconclusive):
                sales_by_category(connection, "2014-06-01", "2014-06-30")
            self.assertTrue(connection.result.closed)


if __name__ == "__main__":
    unittest.main()
