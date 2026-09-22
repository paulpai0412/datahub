from __future__ import annotations

from dataclasses import replace
from datetime import date
from decimal import Decimal
import importlib
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions/sales-datamart/src"))
config = importlib.import_module("sales_datamart.config")
etl = importlib.import_module("sales_datamart.etl")
ConfigurationError = config.ConfigurationError
Scope = config.Scope
CustomerRow = etl.CustomerRow
EmptySourceError = etl.EmptySourceError
Extracted = etl.Extracted
FactRow = etl.FactRow
ProductRow = etl.ProductRow
SourceValidationError = etl.SourceValidationError
TerritoryRow = etl.TerritoryRow
_line_net_amount = etl._line_net_amount
_validate_extracted = etl._validate_extracted


def _extracted(*, facts: tuple[FactRow, ...] | None = None) -> Extracted:
    return Extracted(
        products=(ProductRow(1, "Product", "P-1", None, None, None, None),),
        customers=(CustomerRow(1, None),),
        territories=(TerritoryRow(1, "Territory", "US", "North"),),
        facts=facts or (
            FactRow(
                sales_order_id=10,
                sales_order_detail_id=1,
                order_date=date(2012, 1, 2),
                source_product_id=1,
                source_customer_id=1,
                source_territory_id=None,
                status=5,
                currency_rate_id=None,
                order_qty=2,
                unit_price=Decimal("10.0000"),
                unit_price_discount=Decimal("0.1000"),
                line_net_amount=Decimal("18.000000"),
                source_line_total=Decimal("18.000000"),
            ),
        ),
    )


class SalesDatamartETLTests(unittest.TestCase):
    def test_fetch_bounds_rows_and_closes_result_without_swallowing_errors(self) -> None:
        conn = MagicMock()
        result = conn.execute.return_value
        for size in (2, 3):
            with self.subTest(size=size), patch.object(etl, "MAX_FETCH_ROWS", 2):
                result.reset_mock()
                rows = [{"id": i} for i in range(size)]
                result.mappings.return_value.fetchmany.return_value = rows
                if size == 2:
                    self.assertEqual(etl._fetch(conn, "fixed-query"), rows)
                else:
                    with self.assertRaisesRegex(etl.ETLError, "query_row_limit_exceeded"):
                        etl._fetch(conn, "fixed-query")
                result.mappings.return_value.fetchmany.assert_called_once_with(3)
                result.mappings.return_value.all.assert_not_called()
                result.close.assert_called_once()
        result.reset_mock()
        result.mappings.return_value.fetchmany.side_effect = RuntimeError("query_failed")
        with self.assertRaisesRegex(RuntimeError, "query_failed"):
            etl._fetch(conn, "fixed-query")
        result.close.assert_called_once()

    def test_failed_target_lock_prevents_source_extraction(self) -> None:
        with patch.object(etl, "_acquire_lock", side_effect=etl.ETLError("lock_busy")), patch.object(etl, "extract") as extract:
            with self.assertRaisesRegex(etl.ETLError, "lock_busy"):
                etl.run_etl(source_engine=MagicMock(), target_engine=MagicMock())
            extract.assert_not_called()

    def test_commit_pipe_requires_exact_permission_and_fails_on_parent_eof(self) -> None:
        cli = importlib.import_module("sales_datamart.cli")
        digest = "a" * 64
        for payload, accepted in [(f"COMMIT {digest}\n".encode(), True),
                                  (b"", False), (b"COMMIT wrong\n", False),
                                  (b"x" * 129, False)]:
            with self.subTest(payload=payload):
                read_fd, write_fd = os.pipe()
                with os.fdopen(read_fd, "rb") as pipe:
                    os.write(write_fd, payload)
                    os.close(write_fd)
                    with patch.object(cli.sys, "stdin", pipe):
                        if accepted:
                            cli._await_commit(digest)
                        else:
                            with self.assertRaises(etl.ETLError):
                                cli._await_commit(digest)

    def test_line_formula_uses_decimal_and_six_places(self) -> None:
        self.assertEqual(
            _line_net_amount(3, Decimal("19.9950"), Decimal("0.1250")),
            Decimal("52.486875"),
        )

    def test_scope_rejects_arbitrary_scope_or_currency(self) -> None:
        with self.assertRaisesRegex(ConfigurationError, "unsupported_scope"):
            Scope(scope_id="other").validate()
        with self.assertRaisesRegex(ConfigurationError, "unsupported_currency_scope"):
            Scope(local_currency_only=False).validate()

    def test_empty_scope_is_not_success(self) -> None:
        sample = _extracted()
        empty = Extracted(sample.products, sample.customers, sample.territories, ())
        with self.assertRaisesRegex(EmptySourceError, "empty_approved_scope"):
            _validate_extracted(empty, Scope())

    def test_duplicate_fact_key_is_rejected(self) -> None:
        row = _extracted().facts[0]
        with self.assertRaisesRegex(SourceValidationError, "duplicate_fact_key"):
            _validate_extracted(_extracted(facts=(row, row)), Scope())

    def test_orphan_fact_is_rejected(self) -> None:
        orphan = replace(_extracted().facts[0], source_product_id=999)
        with self.assertRaisesRegex(SourceValidationError, "fact_product_orphan"):
            _validate_extracted(_extracted(facts=(orphan,)), Scope())

    def test_non_local_currency_is_rejected_even_if_caller_constructs_a_row(self) -> None:
        non_local = replace(_extracted().facts[0], currency_rate_id=12)
        with self.assertRaisesRegex(SourceValidationError, "fact_currency_out_of_scope"):
            _validate_extracted(_extracted(facts=(non_local,)), Scope())

    def test_formula_mismatch_is_rejected(self) -> None:
        mismatch = replace(_extracted().facts[0], source_line_total=Decimal("19.000000"))
        with self.assertRaisesRegex(SourceValidationError, "line_total_mismatch"):
            _validate_extracted(_extracted(facts=(mismatch,)), Scope())


if __name__ == "__main__":
    unittest.main()
