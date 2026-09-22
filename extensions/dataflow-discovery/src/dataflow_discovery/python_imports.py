"""Offline module-level import provenance, never import or execute captured code.

This is a prerequisite for SQL-call tracing, not connection or lineage binding.
The result describes syntactic aliases across supported module-level statements,
not runtime object identity or arbitrary execution effects. Function-local imports
and dynamic module names deliberately remain unknown.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
import hashlib

from .snapshot import SourceFile


@dataclass(frozen=True)
class ImportBinding:
    qualified_name: str
    lines: tuple[int, ...]


@dataclass(frozen=True)
class ImportInventory:
    path: str
    file_sha256: str
    bindings: dict[str, ImportBinding]
    unresolved: tuple[tuple[int, str], ...]

    def to_dict(self) -> dict:
        return {
            "format": "dataflow-discovery.python-imports/1",
            "path": self.path,
            "file_sha256": self.file_sha256,
            "bindings": {
                name: {"qualified_name": value.qualified_name, "lines": list(value.lines)}
                for name, value in sorted(self.bindings.items())
            },
            "unresolved": [{"line": line, "reason": reason} for line, reason in self.unresolved],
            "runtime_identity_verified": False,
            "publication_authorized": False,
        }


def _absolute_module(value: str) -> bool:
    return bool(value) and len(value) <= 512 and all(part.isidentifier() for part in value.split("."))


def _assigned_names(node: ast.AST) -> set[str]:
    """Scope-local possible writes; do not mistake nested function locals for globals."""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return {node.name}
    if isinstance(node, ast.Import):
        return {item.asname or item.name.split(".")[0] for item in node.names}
    if isinstance(node, ast.ImportFrom):
        return {item.asname or item.name for item in node.names}
    if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
        return {node.id}
    result: set[str] = set()
    if isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)) and node.name:
        result.add(node.name)
    if isinstance(node, ast.MatchMapping) and node.rest:
        result.add(node.rest)
    for child in ast.iter_child_nodes(node):
        result.update(_assigned_names(child))
    return result


class _Imports:
    def __init__(self) -> None:
        self.names: dict[str, ImportBinding] = {}
        self.blocked: set[str] = set()
        self.global_writes: set[str] = set()
        self.unresolved: list[tuple[int, str]] = []

    def expression(self, node: ast.AST, depth: int = 0) -> ImportBinding | None:
        if depth > 32:
            return None
        value = None
        if isinstance(node, ast.Name):
            value = self.names.get(node.id) if node.id not in self.global_writes else None
        elif isinstance(node, ast.Attribute):
            parent = self.expression(node.value, depth + 1)
            if parent:
                value = ImportBinding(parent.qualified_name + "." + node.attr, parent.lines)
        elif isinstance(node, ast.Call):
            callee = self.expression(node.func, depth + 1)
            if callee and callee.qualified_name == "importlib.import_module":
                if (len(node.args) == 1 and not node.keywords and isinstance(node.args[0], ast.Constant)
                        and isinstance(node.args[0].value, str) and _absolute_module(node.args[0].value)):
                    value = ImportBinding(node.args[0].value, (*callee.lines, node.lineno))
                else:
                    self.unresolved.append((node.lineno, "dynamic_or_relative_module"))
            else:
                self.unresolved.append((node.lineno, "opaque_call_result"))
        if value and any(value.qualified_name == q or value.qualified_name.startswith(q + ".") for q in self.blocked):
            return None
        return value

    def invalidate_attribute(self, target: ast.Attribute) -> None:
        value = self.expression(target)
        if value:
            self.blocked.add(value.qualified_name)
            for name, binding in tuple(self.names.items()):
                if binding.qualified_name == value.qualified_name or binding.qualified_name.startswith(value.qualified_name + "."):
                    del self.names[name]
        self.unresolved.append((target.lineno, "attribute_rebinding"))

    def statement(self, node: ast.stmt) -> None:
        if isinstance(node, ast.Import):
            for item in node.names:
                self.names[item.asname or item.name.split(".")[0]] = ImportBinding(
                    item.name if item.asname else item.name.split(".")[0], (node.lineno,))
        elif isinstance(node, ast.ImportFrom):
            if any(item.name == "*" for item in node.names):
                self.names.clear()
                self.unresolved.append((node.lineno, "star_import"))
            elif node.level or not node.module:
                for item in node.names:
                    self.names.pop(item.asname or item.name, None)
                self.unresolved.append((node.lineno, "relative_import"))
            else:
                for item in node.names:
                    self.names[item.asname or item.name] = ImportBinding(node.module + "." + item.name, (node.lineno,))
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            if node.value is None:
                return  # An annotation alone does not rebind an existing value.
            for child in ast.walk(node.value):
                if isinstance(child, ast.NamedExpr):
                    for name in _assigned_names(child.target):
                        self.names.pop(name, None)
                    self.unresolved.append((child.lineno, "assignment_expression_unresolved"))
            value = self.expression(node.value)
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Attribute):
                    self.invalidate_attribute(target)
                for name in _assigned_names(target):
                    self.names.pop(name, None)
                    if isinstance(target, ast.Name) and value:
                        self.names[name] = ImportBinding(value.qualified_name, tuple(dict.fromkeys((*value.lines, node.lineno))))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            self.names.pop(node.name, None)
            # A global write can occur later; no runtime call-order assumption.
            for child in ast.walk(node):
                if isinstance(child, ast.Global):
                    self.global_writes.update(child.names)
                    for name in child.names:
                        self.names.pop(name, None)
                    self.unresolved.append((child.lineno, "possible_global_rebinding"))
        elif isinstance(node, (ast.If, ast.Try, ast.TryStar, ast.For, ast.While, ast.With, ast.Match, ast.AsyncFor, ast.AsyncWith)):
            for child in ast.walk(node):
                if isinstance(child, ast.Attribute) and isinstance(child.ctx, (ast.Store, ast.Del)):
                    self.invalidate_attribute(child)
            for name in _assigned_names(node):
                self.names.pop(name, None)
            self.unresolved.append((node.lineno, "conditional_or_unsupported_binding"))
        elif isinstance(node, (ast.Delete, ast.AugAssign)):
            for name in _assigned_names(node):
                self.names.pop(name, None)
            targets = node.targets if isinstance(node, ast.Delete) else [node.target]
            for target in targets:
                if isinstance(target, ast.Attribute):
                    self.invalidate_attribute(target)
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            # Do not pretend to understand arbitrary top-level calls/namespace effects.
            self.names.clear()
            self.unresolved.append((node.lineno, "opaque_top_level_call"))


def resolve_python_imports(source: SourceFile) -> ImportInventory:
    data = source.text.encode("utf-8")
    if len(data) != source.size_bytes or hashlib.sha256(data).hexdigest() != source.sha256:
        raise ValueError("python_import_source_mismatch")
    try:
        tree = ast.parse(source.text)
    except (SyntaxError, ValueError, RecursionError):
        raise ValueError("python_import_parse_failed") from None
    visitor = _Imports()
    for node in tree.body:
        visitor.statement(node)
    names = {name: value for name, value in visitor.names.items() if name not in visitor.global_writes}
    return ImportInventory(source.path, source.sha256, names, tuple(sorted(set(visitor.unresolved))))
