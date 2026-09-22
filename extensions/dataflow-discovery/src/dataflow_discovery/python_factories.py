"""Offline parameterized SQLAlchemy factory syntax; never runtime identity or ACL.

Only module-level, linear helper bodies are supported. Credentials, URL strings,
source expressions and environment values are never copied to the report.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
import re

from .python_imports import _assigned_names, resolve_python_imports
from .snapshot import SourceFile


_ENGINE_FACTORIES = frozenset({'sqlalchemy.create_engine', 'sqlalchemy.future.create_engine'})


@dataclass(frozen=True)
class _Parameter:
    name: str
    attributes: tuple[str, ...] = ()


def _qualified(node: ast.AST, names: dict[str, str]) -> str | None:
    parts = []
    while isinstance(node, ast.Attribute) and len(parts) < 32:
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name) or node.id not in names:
        return None
    return ".".join([names[node.id], *reversed(parts)])


def _parameter(node: ast.AST, parameters: dict[str, _Parameter]) -> _Parameter | None:
    parts = []
    while isinstance(node, ast.Attribute) and len(parts) < 32:
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name) or node.id not in parameters:
        return None
    original = parameters[node.id]
    return _Parameter(original.name, (*original.attributes, *reversed(parts)))


def _coordinate(node: ast.AST | None, parameters: dict[str, _Parameter], *, driver: bool = False) -> dict:
    if node is None:
        return {"kind": "unresolved", "reason": "not_explicitly_supplied"}
    reference = _parameter(node, parameters)
    if reference:
        return {"kind": "parameter", "name": reference.name, "attributes": list(reference.attributes)}
    if isinstance(node, ast.Constant):
        value = node.value
        if driver:
            if isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_]*(?:\+[a-z][a-z0-9_]*)?", value):
                return {"kind": "literal", "value": value}
        elif type(value) in (str, int) and len(str(value)) <= 512:
            return {"kind": "literal", "value": value}
    return {"kind": "unresolved", "reason": "unsupported_expression"}


def _engine_call(call: ast.Call, names: dict[str, str], parameters: dict[str, _Parameter]) -> dict | None:
    if _qualified(call.func, names) not in _ENGINE_FACTORIES:
        return None
    if len(call.args) != 1:
        return {"reason": "unsupported_engine_arguments"}
    url = call.args[0]
    if not isinstance(url, ast.Call) or _qualified(url.func, names) not in {
        "sqlalchemy.engine.URL.create", "sqlalchemy.URL.create",
    }:
        return {"reason": "structured_url_required"}
    keys = [item.arg for item in url.keywords]
    if None in keys or len(set(keys)) != len(keys) or len(url.args) > 1 or (url.args and "drivername" in keys):
        return {"reason": "dynamic_or_duplicate_url_arguments"}
    keywords = {item.arg: item.value for item in url.keywords}
    # Never visit or serialize username/password/query expressions or values.
    coordinates = {key: _coordinate(keywords.get(key), parameters) for key in ("database", "host", "port")}
    coordinates["driver"] = _coordinate(url.args[0] if url.args else keywords.get("drivername"), parameters, driver=True)
    return {
        "line": call.lineno,
        "end_line": call.end_lineno,
        "url_line": url.lineno,
        "coordinates": coordinates,
        "engine_option_names": sorted(item.arg for item in call.keywords if item.arg is not None),
        "opaque_engine_options": bool(call.keywords),
        "runtime_identity_verified": False,
    }


def _function(node: ast.FunctionDef, imported: dict[str, str]) -> tuple[dict | None, str | None]:
    args = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
    parameter_names = {arg.arg for arg in args}
    if node.args.vararg:
        parameter_names.add(node.args.vararg.arg)
    if node.args.kwarg:
        parameter_names.add(node.args.kwarg.arg)
    # Python assigns locals for the whole body, including assignments after return.
    locals_ = parameter_names | {name for statement in node.body for name in _assigned_names(statement)}
    names = {name: value for name, value in imported.items() if name not in locals_}
    parameters = {arg.arg: _Parameter(arg.arg) for arg in args}
    engines: dict[str, dict] = {}
    if node.decorator_list:
        return None, "decorated_factory_unresolved"
    if any(isinstance(child, (ast.Yield, ast.YieldFrom)) for child in ast.walk(node)):
        return None, "generator_factory_unresolved"
    for statement in node.body:
        if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str):
            continue
        if isinstance(statement, ast.Pass):
            continue
        if isinstance(statement, ast.Return):
            value = statement.value
            result = _engine_call(value, names, parameters) if isinstance(value, ast.Call) else engines.get(value.id) if isinstance(value, ast.Name) else None
            if result and "reason" in result:
                return None, result["reason"]
            return result, None if result else "factory_return_unresolved"
        if isinstance(statement, (ast.Assign, ast.AnnAssign)):
            value = statement.value
            if value is None:
                continue
            targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
            if len(targets) != 1 or not isinstance(targets[0], ast.Name):
                return None, "nonlinear_or_mutating_factory"
            qualified = _qualified(value, names)
            parameter = _parameter(value, parameters)
            engine = _engine_call(value, names, parameters) if isinstance(value, ast.Call) else engines.get(value.id) if isinstance(value, ast.Name) else None
            name = targets[0].id
            names.pop(name, None)
            parameters.pop(name, None)
            engines.pop(name, None)
            if qualified:
                names[name] = qualified
            if parameter:
                parameters[name] = parameter
            if engine:
                engines[name] = engine
            continue
        return None, "nonlinear_or_mutating_factory"
    return None, "factory_return_unresolved"


def analyze_engine_factories(source: SourceFile) -> dict:
    imports = resolve_python_imports(source)  # Includes source bytes/digest validation.
    tree = ast.parse(source.text)
    names = {name: value.qualified_name for name, value in imports.bindings.items()}
    factories, unresolved = [], []
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        # A syntax candidate only. The scoped pass must still reject local shadowing.
        if not any(isinstance(item, (ast.Name, ast.Attribute)) and _qualified(item, names) in _ENGINE_FACTORIES for item in ast.walk(node)):
            continue
        factory, reason = _function(node, names)
        if factory:
            factories.append({"function": node.name, "definition_line": node.lineno, **factory})
        else:
            unresolved.append({"function": node.name, "line": node.lineno, "reason": reason})
    return {
        "format": "dataflow-discovery.python-factories/1",
        "path": source.path,
        "file_sha256": source.sha256,
        "factories": factories,
        "unresolved": unresolved,
        "import_limitations": [{"line": line, "reason": reason} for line, reason in imports.unresolved],
        "runtime_identity_verified": False,
        "publication_authorized": False,
    }
