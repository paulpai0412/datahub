"""One fixed, read-only reporting-view aggregate for the trusted Host.

This is not a general SQL executor or a credential resolver. A Host must first
authorize its DataHub actor and source scope, then provide a connection using a
reporting-only SQL Server login; this function never selects a connection or user.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from itertools import islice
import re
from typing import Any

from sqlalchemy import text


class QueryInconclusive(ValueError):
    """No complete, bounded and well-formed result may be shown."""


# A fixed statement (not model-provided SQL). TOP 201 is a sentinel: >200
# grouped rows rejects the whole result; it must never be silently truncated.
SALES_BY_CATEGORY = text("""
SELECT TOP (201)
    DATEFROMPARTS(YEAR([OrderDate]), MONTH([OrderDate]), 1) AS [month],
    COALESCE([ProductCategoryName], N'Unknown') AS [category],
    SUM([LineNetAmount]) AS [sales_amount]
FROM [reporting].[v_sales_order_line]
WHERE [OrderDate] >= :from_date AND [OrderDate] < :end_exclusive
GROUP BY DATEFROMPARTS(YEAR([OrderDate]), MONTH([OrderDate]), 1),
         COALESCE([ProductCategoryName], N'Unknown')
ORDER BY [month], [category]
""")

_SCALE = Decimal("0.000001")
_EARLIEST = date(2011, 5, 31)
_LATEST = date(2014, 6, 30)


def _date(value: str) -> date:
    if not isinstance(value, str) or not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", value):
        raise QueryInconclusive("sql_invalid_request")
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise QueryInconclusive("sql_invalid_request") from None
    if parsed.isoformat() != value:
        raise QueryInconclusive("sql_invalid_request")
    return parsed


def validate_range(from_date: str, through: str) -> tuple[date, date]:
    first, last = _date(from_date), _date(through)
    if first < _EARLIEST or last > _LATEST or first > last:
        raise QueryInconclusive("sql_invalid_request")
    return first, last


def sales_by_category(connection: Any, from_date: str, through: str) -> dict[str, Any]:
    """Run exactly this one parameterized SELECT; do not catch/convert DB errors.

    The caller owns the connection's identity, per-statement timeout and abort.
    An SQL error or lost connection is an UNKNOWN outcome, never zero sales.
    """
    first, last = validate_range(from_date, through)
    observed_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    # pi-lens-ignore: python-sql-injection
    result = connection.execute(SALES_BY_CATEGORY, {
        "from_date": first, "end_exclusive": last + timedelta(days=1),
    })
    try:
        rows = list(islice(result.mappings(), 201))
    finally:
        result.close()
    if not rows or len(rows) > 200:
        raise QueryInconclusive("sql_result_inconclusive")
    points: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for row in rows:
        if set(row.keys()) != {"month", "category", "sales_amount"}:
            raise QueryInconclusive("sql_result_inconclusive")
        month, category, amount = row["month"], row["category"], row["sales_amount"]
        if (type(month) is not date or month.day != 1 or
                month < first.replace(day=1) or month > last.replace(day=1) or
                not isinstance(category, str) or not 1 <= len(category) <= 80 or
                any(ord(ch) < 32 or ord(ch) == 127 for ch in category) or
                not isinstance(amount, Decimal) or not amount.is_finite() or
                amount < 0 or amount >= Decimal("1000000000000000")):
            raise QueryInconclusive("sql_result_inconclusive")
        try:
            if amount != amount.quantize(_SCALE):
                raise QueryInconclusive("sql_result_inconclusive")
            value = format(amount, ".6f")
        except InvalidOperation:
            raise QueryInconclusive("sql_result_inconclusive") from None
        key = (month.isoformat(), category)
        if key in seen:
            raise QueryInconclusive("sql_result_inconclusive")
        seen.add(key)
        points.append({"month": key[0], "category": key[1], "salesAmount": value})
    return {"complete": True, "observedAt": observed_at, "dataAsOf": None, "points": points}
