"""One-shot, bounded AdventureWorks -> SalesDatamart ETL.

The case-specific SQL is deliberately explicit: the trusted Host chooses the
fixed scope, while the Agent never supplies an endpoint, SQL statement, path, or
credential. Source work is read-only; only the separately provisioned target
loader can write the SalesDatamart schemas.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
import importlib
import json
import time
from typing import Any, Callable, Iterable, Mapping, Sequence

# SQLAlchemy and the case package are runtime dependencies of the trusted Host.
# Dynamic loading keeps this extension importable by the repository-wide LSP,
# whose interpreter is not the project's .venv.
_sqlalchemy = importlib.import_module("sqlalchemy")
_sqlalchemy_engine = importlib.import_module("sqlalchemy.engine")
create_engine = _sqlalchemy.create_engine
text = _sqlalchemy.text
URL = _sqlalchemy_engine.URL
SqlConnection = Any
Engine = Any

from . import __version__
_config = importlib.import_module("sales_datamart.config")
DbConfig = _config.Connection
Scope = _config.Scope
source_connection = _config.source_connection
target_connection = _config.target_connection


_DECIMAL_6 = Decimal("0.000001")
_DECIMAL_4 = Decimal("0.0001")
_MAX_DECIMAL_19_6 = Decimal("9999999999999.999999")
_MAX_DECIMAL_19_4 = Decimal("999999999999999.9999")

# Fixed test-case execution limits, included in the Host's approved definition.
STATEMENT_TIMEOUT_SECONDS = 30
LOGIN_TIMEOUT_SECONDS = 5
MAX_FETCH_ROWS = 100_000


class ETLError(RuntimeError):
    """A safe, bounded error suitable for a non-secret run receipt."""


class EmptySourceError(ETLError):
    """The approved scope contained no source fact rows."""


class SourceValidationError(ETLError):
    """Source data did not satisfy the fixed ETL contract."""


class SimulatedFailure(ETLError):
    """Only used by rollback integration tests, never by the CLI."""


@dataclass(frozen=True)
class ProductRow:
    source_product_id: int
    product_name: str
    product_number: str
    source_product_subcategory_id: int | None
    product_subcategory_name: str | None
    source_product_category_id: int | None
    product_category_name: str | None


@dataclass(frozen=True)
class CustomerRow:
    source_customer_id: int
    source_territory_id: int | None


@dataclass(frozen=True)
class TerritoryRow:
    source_territory_id: int
    territory_name: str
    country_region_code: str
    territory_group: str


@dataclass(frozen=True)
class FactRow:
    sales_order_id: int
    sales_order_detail_id: int
    order_date: date
    source_product_id: int
    source_customer_id: int
    source_territory_id: int | None
    status: int
    currency_rate_id: int | None
    order_qty: int
    unit_price: Decimal
    unit_price_discount: Decimal
    line_net_amount: Decimal
    source_line_total: Decimal


@dataclass(frozen=True)
class Extracted:
    products: tuple[ProductRow, ...]
    customers: tuple[CustomerRow, ...]
    territories: tuple[TerritoryRow, ...]
    facts: tuple[FactRow, ...]

    @property
    def expected_line_net_amount(self) -> Decimal:
        return sum((row.line_net_amount for row in self.facts), Decimal("0")).quantize(_DECIMAL_6)

    @property
    def source_line_total(self) -> Decimal:
        return sum((row.source_line_total for row in self.facts), Decimal("0")).quantize(_DECIMAL_6)

    @property
    def order_count(self) -> int:
        return len({row.sales_order_id for row in self.facts})

    @property
    def quantity(self) -> int:
        return sum(row.order_qty for row in self.facts)


_PRODUCT_SQL = text(
    """
    SELECT
        p.ProductID AS source_product_id,
        p.Name AS product_name,
        p.ProductNumber AS product_number,
        p.ProductSubcategoryID AS source_product_subcategory_id,
        ps.Name AS product_subcategory_name,
        ps.ProductCategoryID AS source_product_category_id,
        pc.Name AS product_category_name
    FROM [Production].[Product] AS p
    LEFT JOIN [Production].[ProductSubcategory] AS ps
      ON ps.ProductSubcategoryID = p.ProductSubcategoryID
    LEFT JOIN [Production].[ProductCategory] AS pc
      ON pc.ProductCategoryID = ps.ProductCategoryID
    ORDER BY p.ProductID
    """
)

_CUSTOMER_SQL = text(
    """
    SELECT CustomerID AS source_customer_id, TerritoryID AS source_territory_id
    FROM [Sales].[Customer]
    ORDER BY CustomerID
    """
)

_TERRITORY_SQL = text(
    """
    SELECT
        TerritoryID AS source_territory_id,
        Name AS territory_name,
        CountryRegionCode AS country_region_code,
        [Group] AS territory_group
    FROM [Sales].[SalesTerritory]
    ORDER BY TerritoryID
    """
)

_FACT_SQL = text(
    """
    SELECT
        h.SalesOrderID AS sales_order_id,
        d.SalesOrderDetailID AS sales_order_detail_id,
        CONVERT(date, h.OrderDate) AS order_date,
        d.ProductID AS source_product_id,
        h.CustomerID AS source_customer_id,
        h.TerritoryID AS source_territory_id,
        h.Status AS status,
        h.CurrencyRateID AS currency_rate_id,
        d.OrderQty AS order_qty,
        CONVERT(decimal(19,4), d.UnitPrice) AS unit_price,
        CONVERT(decimal(19,4), d.UnitPriceDiscount) AS unit_price_discount,
        CONVERT(decimal(19,6), d.LineTotal) AS source_line_total
    FROM [Sales].[SalesOrderHeader] AS h
    JOIN [Sales].[SalesOrderDetail] AS d
      ON d.SalesOrderID = h.SalesOrderID
    WHERE h.OrderDate >= :start_date
      AND h.OrderDate < :end_date_exclusive
      AND h.Status = :status
      AND h.CurrencyRateID IS NULL
    ORDER BY d.SalesOrderID, d.SalesOrderDetailID
    """
)

_LOCK_SQL = text(
    """
    SET NOCOUNT ON;
    DECLARE @result int;
    EXEC @result = sys.sp_getapplock
        @Resource = :resource,
        @LockMode = 'Exclusive',
        @LockOwner = 'Transaction',
        @LockTimeout = 0;
    IF @result < 0
        THROW 51000, 'SalesDatamart ETL lock unavailable', 1;
    """
)

_INSERT_DATE_SQL = text(
    """
    INSERT INTO [dm].[dim_date]
        ([DateKey], [FullDate], [CalendarYear], [CalendarQuarter], [CalendarMonth], [MonthName], [DayOfMonth])
    SELECT :date_key, :full_date, :calendar_year, :calendar_quarter, :calendar_month, :month_name, :day_of_month
    WHERE NOT EXISTS (
        SELECT 1 FROM [dm].[dim_date] WHERE [DateKey] = :date_key
    )
    """
)

_UPDATE_TERRITORY_SQL = text(
    """
    UPDATE [dm].[dim_territory]
    SET [TerritoryName] = :territory_name,
        [CountryRegionCode] = :country_region_code,
        [TerritoryGroup] = :territory_group
    WHERE [SourceTerritoryID] = :source_territory_id
    """
)

_INSERT_TERRITORY_SQL = text(
    """
    INSERT INTO [dm].[dim_territory]
        ([SourceTerritoryID], [TerritoryName], [CountryRegionCode], [TerritoryGroup])
    SELECT :source_territory_id, :territory_name, :country_region_code, :territory_group
    WHERE NOT EXISTS (
        SELECT 1 FROM [dm].[dim_territory]
        WHERE [SourceTerritoryID] = :source_territory_id
    )
    """
)

_UPDATE_PRODUCT_SQL = text(
    """
    UPDATE [dm].[dim_product]
    SET [ProductName] = :product_name,
        [ProductNumber] = :product_number,
        [SourceProductSubcategoryID] = :source_product_subcategory_id,
        [ProductSubcategoryName] = :product_subcategory_name,
        [SourceProductCategoryID] = :source_product_category_id,
        [ProductCategoryName] = :product_category_name
    WHERE [SourceProductID] = :source_product_id
    """
)

_INSERT_PRODUCT_SQL = text(
    """
    INSERT INTO [dm].[dim_product]
        ([SourceProductID], [ProductName], [ProductNumber], [SourceProductSubcategoryID],
         [ProductSubcategoryName], [SourceProductCategoryID], [ProductCategoryName])
    SELECT :source_product_id, :product_name, :product_number, :source_product_subcategory_id,
           :product_subcategory_name, :source_product_category_id, :product_category_name
    WHERE NOT EXISTS (
        SELECT 1 FROM [dm].[dim_product]
        WHERE [SourceProductID] = :source_product_id
    )
    """
)

_UPDATE_CUSTOMER_SQL = text(
    """
    UPDATE [dm].[dim_customer]
    SET [SourceTerritoryID] = :source_territory_id,
        [TerritoryKey] = :territory_key
    WHERE [SourceCustomerID] = :source_customer_id
    """
)

_INSERT_CUSTOMER_SQL = text(
    """
    INSERT INTO [dm].[dim_customer]
        ([SourceCustomerID], [SourceTerritoryID], [TerritoryKey])
    SELECT :source_customer_id, :source_territory_id, :territory_key
    WHERE NOT EXISTS (
        SELECT 1 FROM [dm].[dim_customer]
        WHERE [SourceCustomerID] = :source_customer_id
    )
    """
)

_UPDATE_FACT_SQL = text(
    """
    UPDATE [dm].[fact_sales_order_line]
    SET [OrderDateKey] = :order_date_key,
        [ProductKey] = :product_key,
        [CustomerKey] = :customer_key,
        [TerritoryKey] = :territory_key,
        [Status] = :status,
        [CurrencyRateID] = :currency_rate_id,
        [OrderQty] = :order_qty,
        [UnitPrice] = :unit_price,
        [UnitPriceDiscount] = :unit_price_discount,
        [LineNetAmount] = :line_net_amount,
        [SourceLineTotal] = :source_line_total
    WHERE [SalesOrderID] = :sales_order_id
      AND [SalesOrderDetailID] = :sales_order_detail_id
    """
)

_INSERT_FACT_SQL = text(
    """
    INSERT INTO [dm].[fact_sales_order_line]
        ([SalesOrderID], [SalesOrderDetailID], [OrderDateKey], [ProductKey], [CustomerKey],
         [TerritoryKey], [Status], [CurrencyRateID], [OrderQty], [UnitPrice],
         [UnitPriceDiscount], [LineNetAmount], [SourceLineTotal])
    SELECT :sales_order_id, :sales_order_detail_id, :order_date_key, :product_key, :customer_key,
           :territory_key, :status, :currency_rate_id, :order_qty, :unit_price,
           :unit_price_discount, :line_net_amount, :source_line_total
    WHERE NOT EXISTS (
        SELECT 1 FROM [dm].[fact_sales_order_line]
        WHERE [SalesOrderID] = :sales_order_id
          AND [SalesOrderDetailID] = :sales_order_detail_id
    )
    """
)

_TARGET_METRICS_SQL = text(
    """
    SELECT
        COUNT_BIG(*) AS fact_count,
        COALESCE(SUM(CONVERT(decimal(38,6), f.[OrderQty])), 0) AS quantity,
        COALESCE(SUM(CONVERT(decimal(38,6), f.[LineNetAmount])), 0) AS line_net_amount,
        COALESCE(SUM(CONVERT(decimal(38,6), f.[SourceLineTotal])), 0) AS source_line_total,
        COUNT(DISTINCT f.[SalesOrderID]) AS order_count
    FROM [dm].[fact_sales_order_line] AS f
    JOIN [dm].[dim_date] AS d ON d.[DateKey] = f.[OrderDateKey]
    WHERE d.[FullDate] >= :start_date
      AND d.[FullDate] <= :end_date
      AND f.[Status] = :status
      AND f.[CurrencyRateID] IS NULL
    """
)

_VIEW_COUNT_SQL = text(
    "SELECT COUNT_BIG(*) AS reporting_view_count FROM [reporting].[v_sales_order_line] WHERE :include_rows = 1"
)


def _engine(config: DbConfig) -> Engine:
    return create_engine(
        URL.create(
            "mssql+pytds",
            username=config.username,
            password=config.password(),
            host=config.host,
            port=config.port,
            database=config.database,
        ),
        connect_args={
            "validate_host": False,
            "timeout": STATEMENT_TIMEOUT_SECONDS,
            "login_timeout": LOGIN_TIMEOUT_SECONDS,
            "disable_connect_retry": True,
        },
        pool_pre_ping=True,
        future=True,
    )


def _as_int(value: Any, name: str) -> int:
    if isinstance(value, bool):
        raise SourceValidationError(f"invalid_{name}")
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        raise SourceValidationError(f"invalid_{name}") from None


def _as_text(value: Any, name: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value:
        raise SourceValidationError(f"invalid_{name}")
    return value


def _as_decimal(value: Any, name: str, places: Decimal) -> Decimal:
    try:
        result = Decimal(value).quantize(places, rounding=ROUND_HALF_UP)
    except (InvalidOperation, TypeError, ValueError):
        raise SourceValidationError(f"invalid_{name}") from None
    return result


def _as_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    raise SourceValidationError("invalid_order_date")


def _fetch(conn: SqlConnection, statement: Any, params: Mapping[str, Any] | None = None) -> list[Mapping[str, Any]]:
    result = conn.execute(statement, params or {})
    try:
        rows = list(result.mappings().fetchmany(MAX_FETCH_ROWS + 1))
        if len(rows) > MAX_FETCH_ROWS:
            raise ETLError("query_row_limit_exceeded")
        return rows
    finally:
        result.close()


def _mapping_int(row: Mapping[str, Any], key: str, name: str) -> int:
    return _as_int(row.get(key), name)


def _target_decimal(value: Any, name: str) -> Decimal:
    try:
        return Decimal(value).quantize(_DECIMAL_6)
    except (InvalidOperation, TypeError, ValueError):
        raise ETLError(f"invalid_{name}") from None


def _line_net_amount(quantity: int, unit_price: Decimal, discount: Decimal) -> Decimal:
    result = (Decimal(quantity) * unit_price * (Decimal("1") - discount)).quantize(
        _DECIMAL_6, rounding=ROUND_HALF_UP
    )
    if result < 0 or result > _MAX_DECIMAL_19_6:
        raise SourceValidationError("line_net_amount_out_of_range")
    return result


def _parse_products(rows: Iterable[Mapping[str, Any]]) -> tuple[ProductRow, ...]:
    return tuple(
        ProductRow(
            source_product_id=_as_int(row["source_product_id"], "product_id"),
            product_name=_as_text(row["product_name"], "product_name"),  # type: ignore[arg-type]
            product_number=_as_text(row["product_number"], "product_number"),  # type: ignore[arg-type]
            source_product_subcategory_id=(
                None
                if row["source_product_subcategory_id"] is None
                else _as_int(row["source_product_subcategory_id"], "product_subcategory_id")
            ),
            product_subcategory_name=_as_text(
                row["product_subcategory_name"], "product_subcategory_name", nullable=True
            ),
            source_product_category_id=(
                None
                if row["source_product_category_id"] is None
                else _as_int(row["source_product_category_id"], "product_category_id")
            ),
            product_category_name=_as_text(
                row["product_category_name"], "product_category_name", nullable=True
            ),
        )
        for row in rows
    )


def _parse_customers(rows: Iterable[Mapping[str, Any]]) -> tuple[CustomerRow, ...]:
    return tuple(
        CustomerRow(
            source_customer_id=_as_int(row["source_customer_id"], "customer_id"),
            source_territory_id=(
                None
                if row["source_territory_id"] is None
                else _as_int(row["source_territory_id"], "customer_territory_id")
            ),
        )
        for row in rows
    )


def _parse_territories(rows: Iterable[Mapping[str, Any]]) -> tuple[TerritoryRow, ...]:
    return tuple(
        TerritoryRow(
            source_territory_id=_as_int(row["source_territory_id"], "territory_id"),
            territory_name=_as_text(row["territory_name"], "territory_name"),  # type: ignore[arg-type]
            country_region_code=_as_text(row["country_region_code"], "country_region_code"),  # type: ignore[arg-type]
            territory_group=_as_text(row["territory_group"], "territory_group"),  # type: ignore[arg-type]
        )
        for row in rows
    )


def _parse_facts(rows: Iterable[Mapping[str, Any]]) -> tuple[FactRow, ...]:
    parsed: list[FactRow] = []
    for row in rows:
        order_qty = _as_int(row["order_qty"], "order_qty")
        unit_price = _as_decimal(row["unit_price"], "unit_price", _DECIMAL_4)
        discount = _as_decimal(row["unit_price_discount"], "unit_price_discount", _DECIMAL_4)
        source_line_total = _as_decimal(row["source_line_total"], "source_line_total", _DECIMAL_6)
        if source_line_total.copy_abs() > _MAX_DECIMAL_19_6:
            raise SourceValidationError("source_line_total_out_of_range")
        parsed.append(
            FactRow(
                sales_order_id=_as_int(row["sales_order_id"], "sales_order_id"),
                sales_order_detail_id=_as_int(row["sales_order_detail_id"], "sales_order_detail_id"),
                order_date=_as_date(row["order_date"]),
                source_product_id=_as_int(row["source_product_id"], "fact_product_id"),
                source_customer_id=_as_int(row["source_customer_id"], "fact_customer_id"),
                source_territory_id=(
                    None
                    if row["source_territory_id"] is None
                    else _as_int(row["source_territory_id"], "fact_territory_id")
                ),
                status=_as_int(row["status"], "status"),
                currency_rate_id=(
                    None
                    if row["currency_rate_id"] is None
                    else _as_int(row["currency_rate_id"], "currency_rate_id")
                ),
                order_qty=order_qty,
                unit_price=unit_price,
                unit_price_discount=discount,
                line_net_amount=_line_net_amount(order_qty, unit_price, discount),
                source_line_total=source_line_total,
            )
        )
    return tuple(parsed)


def _ensure_unique(values: Sequence[int], name: str) -> set[int]:
    result = set(values)
    if len(result) != len(values):
        raise SourceValidationError(f"duplicate_{name}")
    return result


def _validate_extracted(extracted: Extracted, scope: Scope) -> None:
    scope.validate()
    if not extracted.facts:
        raise EmptySourceError("empty_approved_scope")
    product_ids = _ensure_unique([row.source_product_id for row in extracted.products], "product_id")
    customer_ids = _ensure_unique([row.source_customer_id for row in extracted.customers], "customer_id")
    territory_ids = _ensure_unique([row.source_territory_id for row in extracted.territories], "territory_id")
    fact_keys = {(row.sales_order_id, row.sales_order_detail_id) for row in extracted.facts}
    if len(fact_keys) != len(extracted.facts):
        raise SourceValidationError("duplicate_fact_key")
    for row in extracted.customers:
        if row.source_territory_id is not None and row.source_territory_id not in territory_ids:
            raise SourceValidationError("customer_territory_orphan")
    for row in extracted.facts:
        if not scope.start_date <= row.order_date <= scope.end_date:
            raise SourceValidationError("fact_outside_date_scope")
        if row.status != scope.status:
            raise SourceValidationError("fact_status_out_of_scope")
        if row.currency_rate_id is not None:
            raise SourceValidationError("fact_currency_out_of_scope")
        if row.source_product_id not in product_ids:
            raise SourceValidationError("fact_product_orphan")
        if row.source_customer_id not in customer_ids:
            raise SourceValidationError("fact_customer_orphan")
        if row.source_territory_id is not None and row.source_territory_id not in territory_ids:
            raise SourceValidationError("fact_territory_orphan")
        if row.order_qty <= 0:
            raise SourceValidationError("invalid_order_qty")
        if row.unit_price < 0 or not Decimal("0") <= row.unit_price_discount <= Decimal("1"):
            raise SourceValidationError("invalid_amount")
        if abs(row.line_net_amount - row.source_line_total) > _DECIMAL_6:
            raise SourceValidationError("line_total_mismatch")


def extract(source_engine: Engine, scope: Scope) -> Extracted:
    """Read only the seven approved source tables and the fixed local-currency scope."""
    scope.validate()
    with source_engine.connect() as conn:
        products = _parse_products(_fetch(conn, _PRODUCT_SQL))
        customers = _parse_customers(_fetch(conn, _CUSTOMER_SQL))
        territories = _parse_territories(_fetch(conn, _TERRITORY_SQL))
        facts = _parse_facts(
            _fetch(
                conn,
                _FACT_SQL,
                {
                    "start_date": scope.start_date,
                    "end_date_exclusive": scope.end_exclusive,
                    "status": scope.status,
                },
            )
        )
    extracted = Extracted(products, customers, territories, facts)
    _validate_extracted(extracted, scope)
    return extracted


def _date_rows(scope: Scope) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    current = scope.start_date
    while current <= scope.end_date:
        rows.append(
            {
                "date_key": current.year * 10000 + current.month * 100 + current.day,
                "full_date": current,
                "calendar_year": current.year,
                "calendar_quarter": (current.month - 1) // 3 + 1,
                "calendar_month": current.month,
                "month_name": current.strftime("%B"),
                "day_of_month": current.day,
            }
        )
        current += timedelta(days=1)
    return rows


def _execute_many(conn: SqlConnection, statement: Any, rows: Iterable[Mapping[str, Any]]) -> None:
    values = list(rows)
    if values:
        conn.execute(statement, values)


def _load_dimensions(conn: SqlConnection, extracted: Extracted, scope: Scope) -> tuple[dict[int, int], dict[int, int], dict[int, int]]:
    _execute_many(conn, _INSERT_DATE_SQL, _date_rows(scope))

    _execute_many(
        conn,
        _UPDATE_TERRITORY_SQL,
        (
            {
                "source_territory_id": row.source_territory_id,
                "territory_name": row.territory_name,
                "country_region_code": row.country_region_code,
                "territory_group": row.territory_group,
            }
            for row in extracted.territories
        ),
    )
    _execute_many(
        conn,
        _INSERT_TERRITORY_SQL,
        (
            {
                "source_territory_id": row.source_territory_id,
                "territory_name": row.territory_name,
                "country_region_code": row.country_region_code,
                "territory_group": row.territory_group,
            }
            for row in extracted.territories
        ),
    )
    territory_keys = {
        _mapping_int(row, "source_territory_id", "target_source_territory_id"): _mapping_int(
            row, "territory_key", "target_territory_key"
        )
        for row in _fetch(conn, text("SELECT [SourceTerritoryID] AS source_territory_id, [TerritoryKey] AS territory_key FROM [dm].[dim_territory]"))
    }

    _execute_many(
        conn,
        _UPDATE_PRODUCT_SQL,
        (
            {
                "source_product_id": row.source_product_id,
                "product_name": row.product_name,
                "product_number": row.product_number,
                "source_product_subcategory_id": row.source_product_subcategory_id,
                "product_subcategory_name": row.product_subcategory_name,
                "source_product_category_id": row.source_product_category_id,
                "product_category_name": row.product_category_name,
            }
            for row in extracted.products
        ),
    )
    _execute_many(
        conn,
        _INSERT_PRODUCT_SQL,
        (
            {
                "source_product_id": row.source_product_id,
                "product_name": row.product_name,
                "product_number": row.product_number,
                "source_product_subcategory_id": row.source_product_subcategory_id,
                "product_subcategory_name": row.product_subcategory_name,
                "source_product_category_id": row.source_product_category_id,
                "product_category_name": row.product_category_name,
            }
            for row in extracted.products
        ),
    )
    product_keys = {
        _mapping_int(row, "source_product_id", "target_source_product_id"): _mapping_int(
            row, "product_key", "target_product_key"
        )
        for row in _fetch(conn, text("SELECT [SourceProductID] AS source_product_id, [ProductKey] AS product_key FROM [dm].[dim_product]"))
    }

    customer_params = []
    for row in extracted.customers:
        customer_params.append(
            {
                "source_customer_id": row.source_customer_id,
                "source_territory_id": row.source_territory_id,
                "territory_key": 0 if row.source_territory_id is None else territory_keys[row.source_territory_id],
            }
        )
    _execute_many(conn, _UPDATE_CUSTOMER_SQL, customer_params)
    _execute_many(conn, _INSERT_CUSTOMER_SQL, customer_params)
    customer_keys = {
        _mapping_int(row, "source_customer_id", "target_source_customer_id"): _mapping_int(
            row, "customer_key", "target_customer_key"
        )
        for row in _fetch(conn, text("SELECT [SourceCustomerID] AS source_customer_id, [CustomerKey] AS customer_key FROM [dm].[dim_customer]"))
    }
    return product_keys, customer_keys, territory_keys


def _load_facts(
    conn: SqlConnection,
    extracted: Extracted,
    product_keys: Mapping[int, int],
    customer_keys: Mapping[int, int],
    territory_keys: Mapping[int, int],
) -> None:
    params = []
    for row in extracted.facts:
        params.append(
            {
                "sales_order_id": row.sales_order_id,
                "sales_order_detail_id": row.sales_order_detail_id,
                "order_date_key": row.order_date.year * 10000 + row.order_date.month * 100 + row.order_date.day,
                "product_key": product_keys[row.source_product_id],
                "customer_key": customer_keys[row.source_customer_id],
                "territory_key": 0 if row.source_territory_id is None else territory_keys[row.source_territory_id],
                "status": row.status,
                "currency_rate_id": row.currency_rate_id,
                "order_qty": row.order_qty,
                "unit_price": row.unit_price,
                "unit_price_discount": row.unit_price_discount,
                "line_net_amount": row.line_net_amount,
                "source_line_total": row.source_line_total,
            }
        )
    _execute_many(conn, _UPDATE_FACT_SQL, params)
    _execute_many(conn, _INSERT_FACT_SQL, params)


def _acquire_lock(conn: SqlConnection) -> None:
    # Static allowlisted SQL with a bound resource; no caller-controlled SQL.
    # pi-lens-ignore: python-sql-injection
    conn.execute(_LOCK_SQL, {"resource": "datahub.sales_datamart.etl.v1"})


def _target_metrics(conn: SqlConnection, scope: Scope) -> Mapping[str, Any]:
    return conn.execute(
        _TARGET_METRICS_SQL,
        {"start_date": scope.start_date, "end_date": scope.end_date, "status": scope.status},
    ).mappings().one()


def _validate_target(conn: SqlConnection, extracted: Extracted, scope: Scope) -> Mapping[str, Any]:
    metrics = _target_metrics(conn, scope)
    expected = {
        "fact_count": len(extracted.facts),
        "quantity": extracted.quantity,
        "line_net_amount": extracted.expected_line_net_amount,
        "source_line_total": extracted.source_line_total,
        "order_count": extracted.order_count,
    }
    actual = {
        "fact_count": _mapping_int(metrics, "fact_count", "target_fact_count"),
        "quantity": _mapping_int(metrics, "quantity", "target_quantity"),
        "line_net_amount": _target_decimal(metrics.get("line_net_amount"), "target_line_net_amount"),
        "source_line_total": _target_decimal(metrics.get("source_line_total"), "target_source_line_total"),
        "order_count": _mapping_int(metrics, "order_count", "target_order_count"),
    }
    if actual != expected:
        raise ETLError("target_source_reconciliation_failed")
    view_rows = _fetch(conn, _VIEW_COUNT_SQL, {"include_rows": 1})
    if len(view_rows) != 1:
        raise ETLError("reporting_view_count_unavailable")
    view_count = _mapping_int(view_rows[0], "reporting_view_count", "reporting_view_count")
    if view_count < actual["fact_count"]:
        raise ETLError("reporting_view_row_loss")
    return {**actual, "reporting_view_count": view_count}


def _receipt(scope: Scope, extracted: Extracted, metrics: Mapping[str, Any], elapsed_ms: int) -> dict[str, Any]:
    line_net = _target_decimal(metrics.get("line_net_amount"), "receipt_line_net_amount")
    orders = _mapping_int(metrics, "order_count", "receipt_order_count")
    return {
        "format": "sales-datamart.etl.receipt/1",
        "status": "COMMITTED",
        "etl_version": __version__,
        "scope": scope.as_dict(),
        "source": {"database": "AdventureWorks2019", "mode": "read_only", "tables": 7},
        "target": {"database": "SalesDatamart", "schemas": ["dm", "reporting"]},
        "counts": {
            "source_products": len(extracted.products),
            "source_customers": len(extracted.customers),
            "source_territories": len(extracted.territories),
            "source_fact_rows": len(extracted.facts),
            "target_fact_rows": _mapping_int(metrics, "fact_count", "receipt_fact_count"),
            "reporting_view_rows": _mapping_int(metrics, "reporting_view_count", "receipt_view_count"),
            "quantity": _mapping_int(metrics, "quantity", "receipt_quantity"),
            "orders": orders,
        },
        "reconciliation": {
            "line_net_amount": str(line_net),
            "source_line_total": str(metrics["source_line_total"]),
            "aov": None if orders == 0 else str((line_net / Decimal(orders)).quantize(_DECIMAL_6)),
        },
        "elapsed_ms": elapsed_ms,
        "credentials_in_receipt": False,
        "rows_in_receipt": False,
    }


def run_etl(
    scope: Scope | None = None,
    *,
    dry_run: bool = False,
    source_engine: Engine | None = None,
    target_engine: Engine | None = None,
    failure_injection: str | None = None,
    before_commit: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Extract, validate, and atomically upsert the fixed scope.

    ``failure_injection='before_commit'`` exists only for a rollback test and is
    intentionally not exposed by the command-line entrypoint.
    """
    selected_scope = scope or Scope()
    selected_scope.validate()
    owns_source = source_engine is None
    owns_target = not dry_run and target_engine is None
    source = source_engine or _engine(source_connection())
    target = None if dry_run else (target_engine or _engine(target_connection()))
    started = time.monotonic()
    try:
        if dry_run:
            preview = extract(source, selected_scope)
            return {
                "format": "sales-datamart.etl.receipt/1",
                "status": "VALIDATED",
                "etl_version": __version__,
                "scope": selected_scope.as_dict(),
                "counts": {
                    "source_products": len(preview.products),
                    "source_customers": len(preview.customers),
                    "source_territories": len(preview.territories),
                    "source_fact_rows": len(preview.facts),
                    "quantity": preview.quantity,
                    "orders": preview.order_count,
                },
                "credentials_in_receipt": False,
                "rows_in_receipt": False,
            }
        if target is None:
            raise ETLError("target_unavailable")
        with target.begin() as conn:
            # Obtain the existing transaction-owned lock before source work too.
            # A competing writer must not start source work while this run owns it.
            _acquire_lock(conn)
            extraction_started_at = datetime.now(timezone.utc).isoformat()
            extracted = extract(source, selected_scope)
            extraction_finished_at = datetime.now(timezone.utc).isoformat()
            product_keys, customer_keys, territory_keys = _load_dimensions(conn, extracted, selected_scope)
            _load_facts(conn, extracted, product_keys, customer_keys, territory_keys)
            metrics = _validate_target(conn, extracted, selected_scope)
            if failure_injection == "before_commit":
                raise SimulatedFailure("injected_failure_before_commit")
            if failure_injection is not None:
                raise ETLError("unknown_failure_injection")
            # Format/validate aggregate evidence before the transaction can commit.
            receipt = _receipt(selected_scope, extracted, metrics,
                               round((time.monotonic() - started) * 1000))
            receipt["source_observation"] = {
                "started_at": extraction_started_at,
                "ended_at": extraction_finished_at,
                "consistent_snapshot": False,
                "isolation": "driver/database default; not verified as snapshot",
            }
            if before_commit is not None:
                # Refusal/EOF/timeout must raise here, still inside the transaction.
                before_commit({**receipt, "status": "VALIDATED"})
        committed_at = datetime.now(timezone.utc).isoformat()
        # A commit ACK alone does not establish current readable target values.
        with target.connect() as conn:
            observed = _validate_target(conn, extracted, selected_scope)
        if observed != metrics:
            raise ETLError("committed_target_readback_changed")
        return {**receipt, "committed_at": committed_at,
                "readback_at": datetime.now(timezone.utc).isoformat(),
                "elapsed_ms": round((time.monotonic() - started) * 1000)}
    finally:
        if owns_source:
            source.dispose()
        if owns_target and target is not None:
            target.dispose()


def receipt_digest(receipt: Mapping[str, Any]) -> str:
    """Hash a non-secret receipt for an external run record."""
    canonical = json.dumps(receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
