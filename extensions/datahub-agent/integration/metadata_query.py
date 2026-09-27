"""Metadata-bound SELECT compiler. No SQL text, endpoint or secret from a model.

The Node Host supplies a freshly authorized snapshot and a deployment-owned
connection binding. This module never connects to a database or imports drivers.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import math
import re
from typing import Any

from sqlalchemy import column, table, select, bindparam, func, distinct, and_
from sqlalchemy.dialects import mssql, oracle, postgresql, mysql
from sqlalchemy.sql.elements import quoted_name


class QueryError(ValueError):
    """A stable public code, never driver exceptions or submitted values."""


def require(ok: Any, code: str = "query_invalid_request") -> None:
    if not ok:
        raise QueryError(code)


def exact(value: Any, required: set[str], optional: set[str] | None = None) -> None:
    require(isinstance(value, dict) and required <= value.keys()
            and value.keys() <= required | (optional or set()))


def identifier(value: Any) -> str:
    require(isinstance(value, str) and 0 < len(value) <= 256
            and not any(ord(c) < 32 or ord(c) == 127 for c in value), "query_metadata_invalid")
    return value


def output_name(value: Any) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,62}", value)
            and value.lower() not in {"constructor", "prototype", "__proto__"})
    return value


def scalar(value: Any) -> Any:
    require(value is None or isinstance(value, (str, int, float, bool)))
    if isinstance(value, str):
        require(len(value) <= 2048 and "\x00" not in value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        require(math.isfinite(value) and abs(value) <= 9007199254740991)
    return value


DIALECTS = {"mssql": mssql.dialect, "oracle": oracle.dialect,
            "postgres": postgresql.dialect, "mysql": mysql.dialect}
AGGREGATES = {"sum", "avg", "min", "max", "count", "count_distinct"}


@dataclass(frozen=True)
class CompiledQuery:
    statement: Any
    parameters: dict[str, Any]
    columns: list[dict[str, str]]
    dialect: str
    limit: int

    def wire(self, paramstyle: str = "named") -> dict[str, Any]:
        compiled = self.statement.compile(dialect=DIALECTS[self.dialect](paramstyle=paramstyle),
                                          compile_kwargs={"render_postcompile": True})
        return {"sql": str(compiled), "parameters": {**compiled.params, **self.parameters},
                "columns": self.columns, "limit": self.limit, "dialect": self.dialect}


def physical_table(metadata: dict[str, Any], binding: dict[str, Any]) -> Any:
    """Pinned SQL connector name adapter; no suffix matching between instances.

    datasetPrefix is the connector's exact configured name prefix (possibly
    empty). Ambiguous dotted/encoded/nested table paths are not guessed.
    """
    platform = metadata.get("platform")
    require(platform in DIALECTS, "query_platform_unsupported")
    for key in ("platform", "platformInstanceUrn", "environment"):
        require(key in metadata and key in binding and metadata[key] == binding[key],
                "query_source_mismatch")
    name, prefix = metadata.get("qualifiedName"), binding.get("datasetPrefix")
    if not isinstance(prefix, str) or (prefix != "" and not prefix.endswith(".")):
        raise QueryError("query_connection_invalid")
    if not isinstance(name, str) or not name.startswith(prefix):
        raise QueryError("query_source_mismatch")
    parts = name[len(prefix):].split(".")
    count = 3 if platform in {"mssql", "postgres"} else 2
    require(len(parts) == count and all(parts), "query_table_unresolved")
    for part in parts:
        identifier(part)
        require(not any(c in part for c in '[]"`'), "query_table_unresolved")
    if platform in {"mssql", "postgres", "mysql"}:
        require(parts[0] == binding.get("database"), "query_source_mismatch")
    # A connection is already database-bound. Do not emit a four-part linked
    # server name or a cross-database lookup; schema and table are always quoted.
    schema = parts[-2]
    return table(quoted_name(parts[-1], True), schema=quoted_name(schema, True))


def column_type(native: Any) -> str:
    word = str(native or "").lower().split("(")[0].strip()
    if word in {"bigint", "int", "integer", "smallint", "tinyint", "decimal", "numeric",
                "number", "float", "real", "double", "double precision", "money", "smallmoney"}:
        return "number"
    if word in {"date", "datetime", "datetime2", "smalldatetime", "datetimeoffset",
                "timestamp", "timestamp with time zone", "timestamp without time zone"}:
        return "time"
    if word in {"boolean", "bool", "bit"}:
        return "boolean"
    return "string"


def compile_query(plan: dict[str, Any], metadata: list[dict[str, Any]], binding: dict[str, Any]) -> CompiledQuery:
    """Dynamic projections, aggregates, filters and sorting; no business templates.

    Expressions are constructed from SQLAlchemy nodes, never literal_column,
    text(model_sql), user-selected function names or string-concatenated SQL.
    """
    exact(plan, {"datasets", "joins", "select", "filters", "groupBy", "orderBy", "limit"})
    require(isinstance(plan["datasets"], list) and 1 <= len(plan["datasets"]) <= 8)
    require(isinstance(plan["joins"], list) and len(plan["joins"]) == len(plan["datasets"]) - 1)
    require(isinstance(metadata, list) and len(metadata) <= 8, "query_metadata_invalid")
    snapshots = {m["urn"]: m for m in metadata}
    tables, by_name = {}, {}
    for dataset in plan["datasets"]:
        exact(dataset, {"urn", "alias"})
        alias = output_name(dataset["alias"])
        require(alias.lower() not in {s.lower() for s in tables})
        require(dataset["urn"] in snapshots, "query_metadata_mismatch")
        snapshot = snapshots[dataset["urn"]]
        target = physical_table(snapshot, binding)
        fields = snapshot.get("fields")
        if not isinstance(fields, list) or not 1 <= len(fields) <= 4096:
            raise QueryError("query_schema_unavailable")
        by_name[alias] = {}
        for field in fields:
            path = identifier(field.get("path"))
            require(path not in by_name[alias], "query_metadata_invalid")
            by_name[alias][path] = field
            target.append_column(column(quoted_name(path, True)))
        tables[alias] = target.alias(quoted_name(alias, True))
    require(type(plan["limit"]) is int and 1 <= plan["limit"] <= 1000)
    require(isinstance(plan["select"], list) and 1 <= len(plan["select"]) <= 32)
    for key, maximum in (("filters", 32), ("groupBy", 16), ("orderBy", 16)):
        require(isinstance(plan[key], list) and len(plan[key]) <= maximum)
    def field_ref(ref: Any) -> Any:
        exact(ref, {"dataset", "field"})
        alias, path = ref["dataset"], ref["field"]
        require(isinstance(alias, str) and isinstance(path, str) and alias in tables
                and path in by_name[alias], "query_field_unavailable")
        require(not path.startswith("[version="), "query_field_unresolved")
        return tables[alias].c[path]

    target = tables[plan["datasets"][0]["alias"]]
    joined = {plan["datasets"][0]["alias"]}
    for join in plan["joins"]:
        exact(join, {"dataset", "type", "on"})
        alias = join["dataset"]
        require(isinstance(alias, str) and alias in tables and alias not in joined)
        require(join["type"] in {"inner", "left", "full"})
        require(binding["platform"] != "mysql" or join["type"] != "full", "query_join_unsupported")
        require(isinstance(join["on"], list) and 1 <= len(join["on"]) <= 16)
        clauses = []
        for predicate in join["on"]:
            exact(predicate, {"left", "op", "right"})
            left, right = field_ref(predicate["left"]), field_ref(predicate["right"])
            require(predicate["left"]["dataset"] in joined and predicate["right"]["dataset"] == alias,
                    "query_join_disconnected")
            require(predicate["op"] in {"eq", "ne", "gt", "gte", "lt", "lte"})
            clauses.append({"eq": left.__eq__, "ne": left.__ne__, "gt": left.__gt__,
                            "gte": left.__ge__, "lt": left.__lt__, "lte": left.__le__}[predicate["op"]](right))
        target = target.join(tables[alias], and_(*clauses), isouter=join["type"] == "left",
                             full=join["type"] == "full")
        joined.add(alias)
    projections, columns, names, plain = [], [], set(), []
    has_aggregate = False
    for item in plan["select"]:
        exact(item, {"field", "as"}, {"aggregate", "bucket"})
        alias = output_name(item["as"])
        require(alias.lower() not in names)
        names.add(alias.lower())
        aggregate, path = item.get("aggregate"), item["field"]
        if aggregate is not None:
            require(aggregate in AGGREGATES and "bucket" not in item)
            has_aggregate = True
            expr = field_ref(path) if path is not None else None
            require(expr is not None or aggregate == "count")
            if aggregate == "count_distinct":
                expr = func.count(distinct(expr))
            elif aggregate == "count" and expr is None:
                expr = func.count()
            else:
                # Exact enum above: arbitrary/user-defined SQL functions cannot
                # be reached by this dispatch.
                expr = {"sum": func.sum, "avg": func.avg, "min": func.min,
                        "max": func.max, "count": func.count}[aggregate](expr)
            kind = "number"
            if aggregate in {"min", "max"}:
                if not isinstance(path, dict):
                    raise QueryError("query_field_unavailable")
                kind = column_type(by_name[path["dataset"]][path["field"]].get("nativeType"))
        else:
            expr = field_ref(path)
            plain.append(alias)
            kind = column_type(by_name[path["dataset"]][path["field"]].get("nativeType"))
            if "bucket" in item:
                require(kind == "time" and item["bucket"] in {"day", "month", "year"}, "query_bucket_invalid")
                bucket, dialect = item["bucket"], binding["platform"]
                if dialect == "mssql":
                    expr = func.datefromparts(func.year(expr), func.month(expr) if bucket != "year" else 1,
                                              func.day(expr) if bucket == "day" else 1)
                elif dialect == "postgres":
                    expr = func.date_trunc(bucket, expr)
                elif dialect == "oracle":
                    expr = func.trunc(expr, {"year": "YYYY", "month": "MM", "day": "DD"}[bucket])
                else:
                    expr = func.date_format(expr, {"year": "%Y-01-01", "month": "%Y-%m-01", "day": "%Y-%m-%d"}[bucket])
        projections.append(expr.label(quoted_name(alias, True)))
        columns.append({"name": alias, "type": kind})
    require(all(isinstance(x, str) for x in plan["groupBy"]))
    require(len(set(plan["groupBy"])) == len(plan["groupBy"]))
    if has_aggregate or plan["groupBy"]:
        require(set(plain) == set(plan["groupBy"]), "query_grouping_invalid")
    groups = [p for p in projections if p.name in plan["groupBy"]]
    parameters, predicates = {}, []

    def bind(value: Any) -> Any:
        name = f"p{len(parameters)}"
        parameters[name] = scalar(value)
        return bindparam(name, value=value)

    for condition in plan["filters"]:
        exact(condition, {"field", "op"}, {"value"})
        expr, op = field_ref(condition["field"]), condition["op"]
        require(isinstance(op, str))
        if op in {"is_null", "not_null"}:
            require("value" not in condition)
            predicates.append(expr.is_(None) if op == "is_null" else expr.is_not(None))
            continue
        require("value" in condition and condition["value"] is not None)
        value = condition["value"]
        if op in {"in", "between"}:
            require(isinstance(value, list) and 1 <= len(value) <= 100)
            require(op != "between" or len(value) == 2)
            require(all(v is not None for v in value))
            args = [bind(v) for v in value]
            predicates.append(expr.in_(args) if op == "in" else expr.between(*args))
        else:
            require(op in {"eq", "ne", "gt", "gte", "lt", "lte", "like"})
            if op == "like":
                require(isinstance(value, str))
            parameter = bind(value)
            predicates.append({"eq": expr.__eq__, "ne": expr.__ne__, "gt": expr.__gt__,
                               "gte": expr.__ge__, "lt": expr.__lt__, "lte": expr.__le__,
                               "like": expr.like}[op](parameter))
    statement = select(*projections).select_from(target)
    if predicates:
        statement = statement.where(and_(*predicates))
    if groups:
        statement = statement.group_by(*groups)
    for order in plan["orderBy"]:
        exact(order, {"field", "direction"})
        require(order["field"] in {c["name"] for c in columns})
        require(order["direction"] in {"asc", "desc"})
        expr = next(p for p in projections if p.name == order["field"])
        statement = statement.order_by(expr.asc() if order["direction"] == "asc" else expr.desc())
    # Fetch one extra row to report truncation, never claim complete coverage
    # just because a row limit was reached.
    statement = statement.limit(plan["limit"] + 1)
    return CompiledQuery(statement, parameters, columns, binding["platform"], plan["limit"])


def main() -> None:
    import sys
    raw = sys.stdin.buffer.read(262145)
    require(len(raw) <= 262144)
    try:
        request = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise QueryError("query_invalid_request") from error
    exact(request, {"plan", "metadata", "binding"})
    result = compile_query(**request).wire()
    # SQL and bind values stay inside the trusted Host transport, not tool output.
    result["sqlSha256"] = sha256(result["sql"].encode()).hexdigest()
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        import sys
        code = str(error) if isinstance(error, QueryError) else "query_compile_failed"
        print(json.dumps({"error": code}))
        sys.exit(1)
