"""Offline unit checks only; never connect to SQL Server or execute ETL SQL."""
from contextlib import ExitStack
from decimal import Decimal
import unittest
from unittest.mock import MagicMock, patch

import sqlglot
from sqlglot import exp
from sales_datamart import territory_summary as etl


class TerritorySummaryTests(unittest.TestCase):
    def totals(self):
        return {'line_count': 3, 'quantity': 5,
                'net_sales': Decimal('12345678901234567890.123456'),
                'source_line_total': Decimal('12345678901234567890.123456')}

    def connection(self, *rows):
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.get_isolation_level.return_value = 'SERIALIZABLE'
        results = []
        for row in rows:
            result = MagicMock()
            result.mappings.return_value.one.return_value = row
            results.append(result)
        connection.execute.side_effect = results
        return connection

    def differences(self, **changes):
        return {'missing_groups': 0, 'unexpected_groups': 0, 'summary_rows': 2, **changes}

    def test_sql_sources_projection_and_exclusive_write_target(self):
        insert = sqlglot.parse_one(etl._INSERT_SQL, dialect='tsql')
        self.assertIsInstance(insert, exp.Insert)
        self.assertEqual(insert.this.this.sql(dialect='tsql'), '[dm].[monthly_territory_summary]')
        self.assertEqual([column.name for column in insert.this.expressions], [
            'MonthStart', 'TerritoryID', 'TerritoryName', 'LineCount',
            'OrderCount', 'Quantity', 'NetSales', 'SourceLineTotal'])
        self.assertEqual({table.name for table in insert.expression.find_all(exp.Table)},
                         {'fact_sales_order_line', 'dim_date', 'dim_territory'})
        projection = insert.expression
        self.assertEqual(len(projection.expressions), 8)
        self.assertEqual(projection.expressions[1].this.sql(dialect='tsql'), 't.[SourceTerritoryID]')
        self.assertEqual(projection.expressions[2].this.sql(dialect='tsql'), 't.[TerritoryName]')
        self.assertIn('DISTINCT', projection.expressions[4].sql(dialect='tsql'))
        sqlglot.parse_one(etl._DIFFERENCES_SQL, dialect='tsql')
        connection = MagicMock()
        etl.refresh_summary(connection)
        statements = [str(call.args[0]) for call in connection.execute.call_args_list]
        self.assertEqual(statements, ['DELETE FROM [dm].[monthly_territory_summary]', etl._INSERT_SQL])

    def test_valid_totals_preserve_decimal_precision(self):
        expected = self.totals()
        actual = etl._totals(self.connection(expected), etl._SOURCE_TOTALS_SQL)
        self.assertEqual(actual, expected)
        self.assertIsInstance(actual['net_sales'], Decimal)

    def test_invalid_or_empty_source_is_rejected(self):
        for invalid in ({'line_count': 0}, {'line_count': True}, {'quantity': 0},
                        {'net_sales': Decimal('NaN')}, {'net_sales': 1.0},
                        {'source_line_total': Decimal('-1')}):
            with self.subTest(invalid=invalid), self.assertRaises(etl.SummaryError):
                etl._totals(self.connection({**self.totals(), **invalid}), etl._SOURCE_TOTALS_SQL)

    def test_equal_totals_do_not_hide_wrong_groups(self):
        for invalid in ({'missing_groups': 1}, {'unexpected_groups': 1}, {'summary_rows': 0}):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(etl.SummaryError, 'summary_groups_mismatch'):
                etl.validate_summary(self.connection(self.totals(), self.differences(**invalid)), self.totals())
        with self.assertRaisesRegex(etl.SummaryError, 'summary_totals_mismatch'):
            etl.validate_summary(self.connection({**self.totals(), 'quantity': 6}), self.totals())

    def run_offline(self, *, apply, invalid_groups=False, commit_failure=False,
                    readback_failure=False, isolation='SERIALIZABLE'):
        # Every external boundary is replaced before run_summary: no env secrets,
        # driver connection, or database is used by these lifecycle unit tests.
        owner = self.connection(None, None, self.totals(), None, None, self.totals(),
                                self.differences(missing_groups=int(invalid_groups)))
        owner.get_isolation_level.return_value = isolation
        fresh = self.connection(self.totals(), self.differences(unexpected_groups=int(readback_failure)))
        engine = MagicMock()
        engine.connect.side_effect = [owner, fresh]
        transaction = owner.begin.return_value
        if commit_failure:
            transaction.commit.side_effect = RuntimeError('private-driver-detail')
        with ExitStack() as stack:
            config = stack.enter_context(patch.object(etl, 'target_connection')).return_value
            config.username = 'unit-loader'
            config.password.return_value = 'unit-placeholder'
            config.host, config.port, config.database = 'unit.invalid', 1433, 'SalesDatamart'
            factory = stack.enter_context(patch.object(etl, 'create_engine', return_value=engine))
            result = etl.run_summary(apply=apply)
        self.assertTrue(factory.call_args.kwargs['connect_args']['disable_connect_retry'])
        self.assertEqual(factory.call_args.kwargs['connect_args']['timeout'], 30)
        engine.dispose.assert_called_once()
        return result, owner, fresh, engine

    def test_default_observation_has_no_target_write_or_commit(self):
        result, owner, _, engine = self.run_offline(apply=False)
        self.assertEqual(result['status'], 'READ_ONLY_SOURCE_OBSERVED')
        self.assertEqual(result['targetWrites'], 0)
        self.assertEqual(owner.execute.call_count, 3)
        owner.begin.return_value.commit.assert_not_called()
        owner.begin.return_value.rollback.assert_called_once()
        self.assertEqual(engine.connect.call_count, 1)

    def test_apply_commits_then_checks_a_separate_connection(self):
        result, owner, fresh, engine = self.run_offline(apply=True)
        self.assertEqual(result['status'], 'COMMITTED_READBACK_VERIFIED')
        self.assertEqual(result['writeTarget'], 'SalesDatamart.dm.monthly_territory_summary')
        self.assertEqual(result['summaryRows'], 2)
        self.assertEqual(result['totals']['net_sales'], '12345678901234567890.123456')
        owner.begin.return_value.commit.assert_called_once()
        self.assertEqual(engine.connect.call_count, 2)
        self.assertEqual(fresh.execute.call_count, 2)

    def test_failed_validation_rolls_back_without_commit(self):
        result, owner, _, engine = self.run_offline(apply=True, invalid_groups=True)
        self.assertEqual(result['status'], 'FAILED_PRECOMMIT')
        self.assertFalse(result['retryAllowed'])
        owner.begin.return_value.commit.assert_not_called()
        owner.begin.return_value.rollback.assert_called_once()
        self.assertEqual(engine.connect.call_count, 1)

    def test_commit_or_readback_failure_is_unknown_without_retry(self):
        for failure in ('commit_failure', 'readback_failure'):
            with self.subTest(failure=failure):
                result, owner, _, engine = self.run_offline(
                    apply=True, commit_failure=failure == 'commit_failure',
                    readback_failure=failure == 'readback_failure')
                self.assertEqual(result['status'], 'UNKNOWN')
                self.assertFalse(result['retryAllowed'])
                self.assertNotIn('private-driver-detail', str(result))
                owner.begin.return_value.commit.assert_called_once()
                self.assertEqual(engine.connect.call_count, 1 if failure == 'commit_failure' else 2)

    def test_weaker_isolation_is_rejected_before_sql(self):
        result, owner, _, _ = self.run_offline(apply=True, isolation='READ COMMITTED')
        self.assertEqual(result['status'], 'FAILED_PRECOMMIT')
        self.assertEqual(result['code'], 'source_isolation_not_serializable')
        owner.execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
