"""Manual monthly/territory ETL over the existing SalesDatamart.

Only dm.monthly_territory_summary is refreshed. Table creation is a separate
operator action. Discovery must read this source, never import/execute it.
No source reload, arbitrary SQL, credential arguments, or automatic retry.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import json
from typing import Any, Mapping, cast

from pytds.extensions import ISOLATION_LEVEL_SERIALIZABLE
from sqlalchemy import text
from sqlalchemy.engine import Connection, CursorResult, RootTransaction, URL
from sqlalchemy.future import Engine, create_engine
from sqlalchemy.pool import NullPool

from .config import target_connection


_GROUP_SQL = """
SELECT
    DATEFROMPARTS(YEAR(d.[FullDate]), MONTH(d.[FullDate]), 1) AS [MonthStart],
    t.[SourceTerritoryID] AS [TerritoryID],
    t.[TerritoryName] AS [TerritoryName],
    COUNT_BIG(*) AS [LineCount],
    COUNT_BIG(DISTINCT f.[SalesOrderID]) AS [OrderCount],
    SUM(CAST(f.[OrderQty] AS bigint)) AS [Quantity],
    SUM(CAST(f.[LineNetAmount] AS decimal(38,6))) AS [NetSales],
    SUM(CAST(f.[SourceLineTotal] AS decimal(38,6))) AS [SourceLineTotal]
FROM [dm].[fact_sales_order_line] AS f
JOIN [dm].[dim_date] AS d ON d.[DateKey] = f.[OrderDateKey]
JOIN [dm].[dim_territory] AS t ON t.[TerritoryKey] = f.[TerritoryKey]
GROUP BY DATEFROMPARTS(YEAR(d.[FullDate]), MONTH(d.[FullDate]), 1),
    t.[SourceTerritoryID], t.[TerritoryName]
"""
_INSERT_SQL = """
INSERT INTO [dm].[monthly_territory_summary]
    ([MonthStart], [TerritoryID], [TerritoryName], [LineCount],
     [OrderCount], [Quantity], [NetSales], [SourceLineTotal])
""" + _GROUP_SQL
_TARGET_GROUP_SQL = """
SELECT [MonthStart], [TerritoryID], [TerritoryName], [LineCount],
    [OrderCount], [Quantity], [NetSales], [SourceLineTotal]
FROM [dm].[monthly_territory_summary]
"""
_SOURCE_TOTALS_SQL = """
SELECT COUNT_BIG(*) AS [line_count],
    SUM(CAST([OrderQty] AS bigint)) AS [quantity],
    SUM(CAST([LineNetAmount] AS decimal(38,6))) AS [net_sales],
    SUM(CAST([SourceLineTotal] AS decimal(38,6))) AS [source_line_total]
FROM [dm].[fact_sales_order_line]
"""
_TARGET_TOTALS_SQL = """
SELECT SUM([LineCount]) AS [line_count], SUM([Quantity]) AS [quantity],
    SUM([NetSales]) AS [net_sales], SUM([SourceLineTotal]) AS [source_line_total]
FROM [dm].[monthly_territory_summary]
"""
_DIFFERENCES_SQL = f"""
WITH expected AS ({_GROUP_SQL}), actual AS ({_TARGET_GROUP_SQL})
SELECT
 (SELECT COUNT_BIG(*) FROM (SELECT * FROM expected EXCEPT SELECT * FROM actual) AS missing) AS [missing_groups],
 (SELECT COUNT_BIG(*) FROM (SELECT * FROM actual EXCEPT SELECT * FROM expected) AS unexpected) AS [unexpected_groups],
 (SELECT COUNT_BIG(*) FROM actual) AS [summary_rows]
"""
_LOCK_SQL = """
DECLARE @result int;
EXEC @result = sys.sp_getapplock
    @Resource = :resource, @LockMode = 'Exclusive',
    @LockOwner = 'Session', @LockTimeout = 0;
IF @result < 0 THROW 51000, 'Territory summary source or target busy', 1;
"""


class SummaryError(RuntimeError):
    """A bounded error without SQL text, source rows or credentials."""


def _totals(connection: Connection, statement: str) -> dict[str, Any]:
    result = cast(CursorResult, connection.execute(text(statement)))
    row = dict(cast(Mapping[str, Any], result.mappings().one()))
    if type(row['line_count']) is not int or row['line_count'] <= 0:
        raise SummaryError('empty_or_invalid_source')
    if type(row['quantity']) is not int or row['quantity'] <= 0:
        raise SummaryError('invalid_quantity')
    for field in ('net_sales', 'source_line_total'):
        if not isinstance(row[field], Decimal) or not row[field].is_finite() or row[field] < 0:
            raise SummaryError('invalid_amount')
    return row


def refresh_summary(connection: Connection) -> None:
    # Only this new target is replaced, inside the caller's transaction.
    connection.execute(text('DELETE FROM [dm].[monthly_territory_summary]'))
    connection.execute(text(_INSERT_SQL))


def validate_summary(connection: Connection, expected: dict[str, Any]) -> int:
    if _totals(connection, _TARGET_TOTALS_SQL) != expected:
        raise SummaryError('summary_totals_mismatch')
    # Fixed SQL composed solely from the literal queries in this module.
    # pi-lens-ignore: python-sql-injection
    result = cast(CursorResult, connection.execute(text(_DIFFERENCES_SQL)))
    comparison = cast(Mapping[str, Any], result.mappings().one())
    if (comparison['missing_groups'] or comparison['unexpected_groups']
            or type(comparison['summary_rows']) is not int or comparison['summary_rows'] <= 0):
        raise SummaryError('summary_groups_mismatch')
    return comparison['summary_rows']


def run_summary(*, apply: bool = False) -> dict[str, Any]:
    """Read totals by default; --apply refreshes only the new summary.

    Reuse the existing ETL's application-lock resource. Keep the session-owned
    lock through fresh-connection readback; NullPool physically closes sessions.
    A lost commit acknowledgement or failed readback is UNKNOWN, never retried.
    """
    config = target_connection()
    engine = cast(Engine, create_engine(URL.create('mssql+pytds', username=config.username,
        password=config.password(), host=config.host, port=config.port, database=config.database),
        # Use pytds' public isolation option: the pinned SQLAlchemy dialect's
        # isolation setter incorrectly treats autocommit as a callable.
        connect_args={'validate_host': False, 'timeout': 30, 'login_timeout': 5,
                      'disable_connect_retry': True, 'isolation_level': ISOLATION_LEVEL_SERIALIZABLE},
        poolclass=NullPool, hide_parameters=True))
    started = datetime.now(timezone.utc).isoformat()
    commit_attempted = False
    try:
        with engine.connect() as connection:
            if connection.get_isolation_level() != 'SERIALIZABLE':
                raise SummaryError('source_isolation_not_serializable')
            transaction = cast(RootTransaction, connection.begin())
            try:
                connection.execute(text('SET XACT_ABORT ON; SET LOCK_TIMEOUT 0;'))
                connection.execute(text(_LOCK_SQL), {'resource': 'datahub.sales_datamart.etl.v1'})
                expected = _totals(connection, _SOURCE_TOTALS_SQL)
                if not apply:
                    transaction.rollback()
                    return {'status': 'READ_ONLY_SOURCE_OBSERVED', 'startedAt': started,
                            'source': {key: str(value) for key, value in expected.items()}, 'targetWrites': 0}
                refresh_summary(connection)
                rows = validate_summary(connection, expected)
                commit_attempted = True
                transaction.commit()
            except Exception:
                if transaction.is_active:
                    transaction.rollback()
                raise
            with engine.connect() as fresh:
                if fresh.get_isolation_level() != 'SERIALIZABLE':
                    raise SummaryError('readback_isolation_not_serializable')
                if validate_summary(fresh, expected) != rows:
                    raise SummaryError('fresh_summary_readback_mismatch')
            return {'status': 'COMMITTED_READBACK_VERIFIED', 'startedAt': started,
                    'finishedAt': datetime.now(timezone.utc).isoformat(), 'summaryRows': rows,
                    'totals': {key: str(value) for key, value in expected.items()},
                    'writeTarget': 'SalesDatamart.dm.monthly_territory_summary',
                    'sourceIsolation': 'SERIALIZABLE', 'sourceIsolationVerified': True,
                    'readbackIsolationVerified': True, 'freshReadbackVerified': True}
    except Exception as error:
        return {'status': 'UNKNOWN' if commit_attempted else 'FAILED_PRECOMMIT',
                'code': str(error) if isinstance(error, SummaryError) else type(error).__name__,
                'startedAt': started, 'retryAllowed': False}
    finally:
        engine.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(description='Manual monthly/territory SalesDatamart summary')
    parser.add_argument('--apply', action='store_true', help='replace only dm.monthly_territory_summary')
    args = parser.parse_args()
    try:
        result = run_summary(apply=args.apply)
    except Exception as error:
        # Setup/cleanup failure may hide a committed write; do not infer rollback.
        result = {'status': 'UNKNOWN', 'code': type(error).__name__, 'retryAllowed': False}
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] in {'READ_ONLY_SOURCE_OBSERVED', 'COMMITTED_READBACK_VERIFIED'} else 1


if __name__ == '__main__':
    raise SystemExit(main())
