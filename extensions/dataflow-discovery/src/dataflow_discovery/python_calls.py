"""Offline factory call-site syntax and unevaluated engine selection alternatives.

Only each module-level function's straight-line prefix is traced. References to
assignments are flat, not recursively expanded, and literal argument values are
not exported. No connection, module identity, runtime branch or ACL is verified.
"""
from __future__ import annotations

import ast
from collections import Counter

from .python_factories import _ENGINE_FACTORIES, _engine_call, _qualified, analyze_engine_factories
from .python_imports import _assigned_names, resolve_python_imports
from .snapshot import SourceFile


def _arguments(call: ast.Call, definition: ast.FunctionDef) -> tuple[dict[str, ast.expr] | None, str | None]:
    signature = definition.args
    positional = [*signature.posonlyargs, *signature.args]
    if signature.vararg or signature.kwarg or any(isinstance(arg, ast.Starred) for arg in call.args) or any(kw.arg is None for kw in call.keywords):
        return None, "dynamic_factory_arguments"
    if len(call.args) > len(positional):
        return None, "factory_argument_mismatch"
    values = {param.arg: value for param, value in zip(positional, call.args)}
    keyword_names = {param.arg for param in [*signature.args, *signature.kwonlyargs]}
    for keyword in call.keywords:
        if keyword.arg not in keyword_names or keyword.arg in values:
            return None, "factory_argument_mismatch"
        values[keyword.arg] = keyword.value
    required = {arg.arg for arg in positional[:len(positional) - len(signature.defaults)]}
    required.update(arg.arg for arg, default in zip(signature.kwonlyargs, signature.kw_defaults) if default is None)
    if not required.issubset(values):
        return None, "factory_argument_mismatch"
    # Omitted defaults are intentionally not evaluated or substituted.
    return values, None


def _stable_factories(tree: ast.Module, templates: list[dict]) -> dict[str, ast.FunctionDef]:
    writes = Counter(name for statement in tree.body for name in _assigned_names(statement))
    globals_ = {name for node in ast.walk(tree) if isinstance(node, ast.Global) for name in node.names}
    locations = {(template["function"], template["definition_line"]) for template in templates}
    return {node.name: node for node in tree.body
            if isinstance(node, ast.FunctionDef) and (node.name, node.lineno) in locations
            and writes[node.name] == 1 and node.name not in globals_}


class _Calls:
    def __init__(self, function: ast.FunctionDef, imported: dict[str, str], factories: dict[str, ast.FunctionDef]):
        args = function.args
        parameters = {arg.arg for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs]}
        parameters.update(arg.arg for arg in [args.vararg, args.kwarg] if arg is not None)
        locals_ = parameters | {name for statement in function.body for name in _assigned_names(statement)}
        self.names = {name: qualified for name, qualified in imported.items() if name not in locals_}
        self.factories = {name: definition for name, definition in factories.items() if name not in locals_}
        self.references = {name: {"kind": "parameter", "name": name} for name in parameters}
        self.function = function
        self.calls: list[dict] = []
        self.assignments: list[dict] = []
        self.unresolved: list[dict] = []

    def expression(self, node: ast.expr, depth: int = 0) -> dict:
        if depth > 32:
            return {"kind": "unresolved", "reason": "expression_depth_limit"}
        if isinstance(node, ast.Name):
            if node.id in self.references:
                return dict(self.references[node.id])
            if node.id in self.factories:
                return {"kind": "factory_symbol", "definition_line": self.factories[node.id].lineno}
            return {"kind": "unresolved", "reason": "name_value_unverified", "name": node.id}
        if isinstance(node, ast.Constant) and (node.value is None or type(node.value) is bool):
            return {"kind": "literal", "value": node.value}
        if isinstance(node, ast.BoolOp):
            return {"kind": "boolean_choice", "operator": "or" if isinstance(node.op, ast.Or) else "and",
                    "operands": [self.expression(value, depth + 1) for value in node.values], "selection_verified": False}
        if isinstance(node, ast.IfExp):
            return {"kind": "conditional_choice", "condition": self.expression(node.test, depth + 1),
                    "if_true": self.expression(node.body, depth + 1), "if_false": self.expression(node.orelse, depth + 1),
                    "selection_verified": False}
        if isinstance(node, ast.Attribute):
            return {"kind": "attribute", "owner": self.expression(node.value, depth + 1), "attribute": node.attr}
        if isinstance(node, ast.Call):
            definition = self.factories.get(node.func.id) if isinstance(node.func, ast.Name) else None
            if definition:
                return self.factory_call(node, definition, depth)
            qualified = _qualified(node.func, self.names)
            if qualified == 'typing.cast' and len(node.args) == 2 and not node.keywords:
                # The documented cast returns its value unchanged. This pass
                # records syntax, not evaluation of the type/value arguments.
                return self.expression(node.args[1], depth + 1)
            engine = _engine_call(node, self.names, {})
            if engine is not None:
                if 'reason' in engine:
                    return {'kind': 'unresolved', **engine}
                identifier = f'call:{node.lineno}:{node.col_offset}'
                self.calls.append({'id': identifier, 'caller': self.function.name,
                    'caller_definition_line': self.function.lineno,
                    'line': node.lineno, 'column': node.col_offset, 'factory': qualified,
                    'factory_kind': 'public_inline', 'engine_declaration': engine,
                    'argument_binding': 'SYNTAX_ONLY', 'execution_verified': False})
                return {'kind': 'factory_call', 'call_id': identifier}
            if qualified:
                return {"kind": "imported_call", "qualified_name": qualified, "line": node.lineno,
                        "column": node.col_offset, "positional_count": len(node.args),
                        "keyword_names": [keyword.arg for keyword in node.keywords], "result_verified": False}
        return {"kind": "unresolved", "reason": "expression_not_traced", "line": node.lineno}

    def factory_call(self, node: ast.Call, definition: ast.FunctionDef, depth: int) -> dict:
        values, reason = _arguments(node, definition)
        identifier = f"call:{node.lineno}:{node.col_offset}"
        self.calls.append({"id": identifier, "caller": self.function.name, "caller_definition_line": self.function.lineno,
                           "line": node.lineno, "column": node.col_offset, "factory": definition.name,
                           "factory_definition_line": definition.lineno, "argument_binding": "UNRESOLVED" if reason else "SYNTAX_ONLY",
                           "reason": reason, "arguments": {name: self.expression(value, depth + 1) for name, value in (values or {}).items()},
                           "omitted_parameters": [arg.arg for arg in [*definition.args.posonlyargs, *definition.args.args, *definition.args.kwonlyargs] if arg.arg not in (values or {})],
                           "execution_verified": False})
        return {"kind": "factory_call", "call_id": identifier}

    def assignment(self, statement: ast.Assign | ast.AnnAssign) -> bool:
        if statement.value is None:
            return True
        targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
        if len(targets) != 1 or not isinstance(targets[0], ast.Name):
            return False
        # Walrus/comprehension bindings are not modeled by this linear pass.
        if any(isinstance(node, (ast.NamedExpr, ast.comprehension)) for node in ast.walk(statement.value)):
            return False
        value = self.expression(statement.value)
        qualified = _qualified(statement.value, self.names)
        factory = self.factories.get(statement.value.id) if isinstance(statement.value, ast.Name) else None
        name = targets[0].id
        identifier = f"assignment:{statement.lineno}:{statement.col_offset}"
        self.assignments.append({"id": identifier, "function": self.function.name, "name": name, "line": statement.lineno, "value": value})
        self.references[name] = {"kind": "assignment_reference", "assignment_id": identifier}
        self.names.pop(name, None)
        self.factories.pop(name, None)
        if qualified:
            self.names[name] = qualified
        if factory:
            self.factories[name] = factory
        return True

    def run(self) -> None:
        if self.function.decorator_list:
            self.unresolved.append({"line": self.function.lineno, "reason": "decorated_caller_unresolved"})
            return
        for statement in self.function.body:
            if isinstance(statement, (ast.Assign, ast.AnnAssign)) and self.assignment(statement):
                continue
            if isinstance(statement, ast.Expr):
                if isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str):
                    continue
                self.expression(statement.value)
                self.unresolved.append({"line": statement.lineno, "reason": "statement_runtime_effects_unverified"})
                continue
            if isinstance(statement, ast.Return):
                if statement.value is not None:
                    self.expression(statement.value)
                break
            if isinstance(statement, ast.Pass):
                continue
            self.unresolved.append({"line": statement.lineno, "reason": "control_flow_or_mutation_not_traced"})
            break


def analyze_factory_calls(source: SourceFile) -> dict:
    templates = analyze_engine_factories(source)
    imports = resolve_python_imports(source)
    tree = ast.parse(source.text)
    factories = _stable_factories(tree, templates["factories"])
    candidate_names = {template["function"] for template in templates["factories"]}
    imported = {name: binding.qualified_name for name, binding in imports.bindings.items()}
    calls, assignments, unresolved = [], [], []
    for function in tree.body:
        if not isinstance(function, ast.FunctionDef):
            continue
        if not any((isinstance(node, ast.Name) and node.id in candidate_names)
                   or (isinstance(node, ast.Call) and _qualified(node.func, imported) in _ENGINE_FACTORIES)
                   for node in ast.walk(function)):
            continue
        visitor = _Calls(function, imported, factories)
        visitor.run()
        calls.extend(visitor.calls)
        assignments.extend(visitor.assignments)
        unresolved.extend({"function": function.name, **finding} for finding in visitor.unresolved)
    unresolved.extend({"function": name, "reason": "module_factory_binding_ambiguous"} for name in sorted(candidate_names - factories.keys()))
    return {"format": "dataflow-discovery.python-factory-calls/1", "path": source.path, "file_sha256": source.sha256,
            "calls": calls, "assignments": assignments, "unresolved": unresolved,
            "factory_templates": templates, "runtime_identity_verified": False, "publication_authorized": False}
