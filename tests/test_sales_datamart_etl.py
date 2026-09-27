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

    def test_view_must_preserve_rows_within_the_approved_scope(self) -> None:
        extracted = _extracted()
        scope = Scope()
        fact_metrics = {
            "fact_count": 1,
            "quantity": extracted.quantity,
            "line_net_amount": extracted.expected_line_net_amount,
            "source_line_total": extracted.source_line_total,
            "order_count": extracted.order_count,
        }
        for total_rows, scoped_rows, allowed in ((1, 0, False), (1, 1, True), (2, 2, False)):
            with self.subTest(total_rows=total_rows, scoped_rows=scoped_rows):
                def read_view(_conn, statement, params):
                    self.assertIs(statement, etl._VIEW_METRICS_SQL)
                    self.assertEqual(params["start_date"], scope.start_date)
                    self.assertEqual(params["end_date"], scope.end_date)
                    self.assertEqual(params["status"], scope.status)
                    # Prior out-of-scope rows could mask missing or duplicated
                    # view rows when only the unfiltered total was compared.
                    return [{"reporting_view_count": total_rows,
                             "reporting_view_scope_count": scoped_rows,
                             "reporting_view_quantity": extracted.quantity,
                             "reporting_view_line_net_amount": extracted.expected_line_net_amount,
                             "reporting_view_source_line_total": extracted.source_line_total,
                             "reporting_view_order_count": extracted.order_count}]

                with patch.object(etl, "_target_metrics", return_value=fact_metrics), patch.object(
                    etl, "_fetch", side_effect=read_view
                ):
                    if allowed:
                        result = etl._validate_target(MagicMock(), extracted, scope)
                        self.assertEqual(result["reporting_view_count"], 1)
                    else:
                        with self.assertRaisesRegex(etl.ETLError, "reporting_view_scope_mismatch"):
                            etl._validate_target(MagicMock(), extracted, scope)

    def test_view_same_count_with_wrong_amount_or_order_is_not_committable(self) -> None:
        extracted = _extracted()
        scope = Scope()
        fact_metrics = {
            "fact_count": 1,
            "quantity": extracted.quantity,
            "line_net_amount": extracted.expected_line_net_amount,
            "source_line_total": extracted.source_line_total,
            "order_count": extracted.order_count,
        }
        matching = {
            "reporting_view_count": 1,
            "reporting_view_scope_count": 1,
            "reporting_view_quantity": extracted.quantity,
            "reporting_view_line_net_amount": extracted.expected_line_net_amount,
            "reporting_view_source_line_total": extracted.source_line_total,
            "reporting_view_order_count": extracted.order_count,
        }
        for field, wrong in (
            ("reporting_view_quantity", Decimal("3.000000")),
            ("reporting_view_line_net_amount", Decimal("19.000000")),
            ("reporting_view_source_line_total", Decimal("19.000000")),
            ("reporting_view_order_count", 2),
        ):
            with self.subTest(field=field), patch.object(etl, "_target_metrics", return_value=fact_metrics), patch.object(
                etl, "_fetch", return_value=[{**matching, field: wrong}]
            ):
                with self.assertRaisesRegex(etl.ETLError, "reporting_view_metrics_mismatch"):
                    etl._validate_target(MagicMock(), extracted, scope)

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

    def test_receipt_aov_uses_panel_half_away_rounding_on_six_place_tie(self) -> None:
        first = _extracted().facts[0]
        rows = (
            replace(first, sales_order_id=10, order_qty=1,
                    unit_price=Decimal("0.5000"), unit_price_discount=Decimal("0"),
                    line_net_amount=Decimal("0.500000"), source_line_total=Decimal("0.500000")),
            replace(first, sales_order_id=11, sales_order_detail_id=2, order_qty=1,
                    unit_price=Decimal("0.5050"), unit_price_discount=Decimal("0.0099"),
                    line_net_amount=Decimal("0.500001"), source_line_total=Decimal("0.500001")),
        )
        extracted = _extracted(facts=rows)
        _validate_extracted(extracted, Scope())
        for row in rows:
            self.assertEqual(row.line_net_amount, _line_net_amount(row.order_qty, row.unit_price, row.unit_price_discount))
        metrics = {"fact_count": 2, "quantity": 2, "line_net_amount": Decimal("1.000001"),
                   "source_line_total": Decimal("1.000001"), "order_count": 2,
                   "reporting_view_count": 2}
        self.assertEqual(etl._receipt(Scope(), extracted, metrics, 1)["reconciliation"]["aov"], "0.500001")

    def test_source_dimension_zero_cannot_overwrite_unknown_member(self) -> None:
        sample = _extracted()
        _validate_extracted(sample, Scope())
        cases = (
            ("product_id", replace(sample, products=(replace(sample.products[0], source_product_id=0),))),
            ("customer_id", replace(sample, customers=(replace(sample.customers[0], source_customer_id=0),))),
            ("territory_id", replace(sample, territories=(replace(sample.territories[0], source_territory_id=0),))),
        )
        for name, extracted in cases:
            with self.subTest(dimension=name):
                with self.assertRaisesRegex(SourceValidationError, f"reserved_{name}_zero"):
                    _validate_extracted(extracted, Scope())

    def test_target_unknown_member_drift_blocks_first_dimension_write(self) -> None:
        for returned in ([], [{"canonical": 0}], [{"canonical": 1}, {"canonical": 1}]):
            with self.subTest(returned=returned), patch.object(etl, "_fetch", return_value=returned), patch.object(etl, "_execute_many") as write:
                with self.assertRaisesRegex(etl.ETLError, "target_unknown_member_invalid"):
                    etl._load_dimensions(MagicMock(), _extracted(), Scope())
                write.assert_not_called()

    def test_canonical_target_unknown_members_keep_normal_dimension_mapping(self) -> None:
        rows = (
            [{"canonical": 1}],
            [{"source_territory_id": 0, "territory_key": 0}, {"source_territory_id": 1, "territory_key": 7}],
            [{"source_product_id": 0, "product_key": 0}, {"source_product_id": 1, "product_key": 8}],
            [{"source_customer_id": 0, "customer_key": 0}, {"source_customer_id": 1, "customer_key": 9}],
        )
        with patch.object(etl, "_fetch", side_effect=rows) as fetch, patch.object(etl, "_execute_many") as write:
            products, customers, territories = etl._load_dimensions(MagicMock(), _extracted(), Scope())
        self.assertEqual((products[1], customers[1], territories[1]), (8, 9, 7))
        self.assertEqual(fetch.call_count, 4)
        self.assertIs(fetch.call_args_list[0].args[1], etl._UNKNOWN_MEMBERS_SQL)
        self.assertEqual(write.call_count, 7)

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
