"""Offline, bounded connection/SQL argument provenance; never execute source.

Expand only SQL-relevant local helpers. All branches are syntax possibilities,
not executions; connection acquisition is lexical evidence, not runtime identity.
SQL text, bind values, credentials and source expressions are not exported.
"""
from __future__ import annotations

import ast
from collections import Counter
import hashlib

from .python_calls import _arguments, analyze_factory_calls
from .python_factories import _qualified
from .python_imports import _assigned_names, resolve_python_imports
from .snapshot import SourceFile


class _Limit(Exception):
    pass


def _same_merge(left: dict, right: dict) -> dict:
    return {name: value if value == right.get(name) else None for name, value in left.items()}


def _has_factory(value: object, eligible: set[str]) -> bool:
    if isinstance(value, dict):
        if value.get("kind") == "factory_call" or value.get("assignment_id") in eligible:
            return True
        return any(_has_factory(child, eligible) for child in value.values())
    if isinstance(value, list):
        return any(_has_factory(child, eligible) for child in value)
    return False


def _closed_string(node: ast.expr, bindings: dict[str, str], depth: int = 0) -> str | None:
    """Only bounded string literals, immutable names, + and unformatted f-strings.

    No eval, calls, attribute access, conversion or runtime interpolation. The
    caller supplies only earlier, single-assignment module string declarations.
    """
    if depth > 32:
        return None
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return bindings.get(node.id)
    pieces = []
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        children = [node.left, node.right]
    elif isinstance(node, ast.JoinedStr):
        children = []
        for value in node.values:
            if isinstance(value, ast.FormattedValue):
                if value.conversion != -1 or value.format_spec is not None:
                    return None
                children.append(value.value)
            elif isinstance(value, ast.Constant):
                children.append(value)
            else:
                return None
    else:
        return None
    size = 0
    for child in children:
        piece = _closed_string(child, bindings, depth + 1)
        if piece is None:
            return None
        size += len(piece.encode('utf-8'))
        if size > 512 * 1024:
            return None
        pieces.append(piece)
    return ''.join(pieces)


def python_sql_literals(tree: ast.Module) -> dict[tuple[int, int], tuple[ast.expr, str]]:
    """Share source-string declarations across SQL tracing and Catalog binders.

    Preserve ordinary literals. Replace fragments of a proven closed module
    composition with its complete expression; unknown compositions stay unknown.
    Raw text remains internal and is never added to the trace response.
    """
    literals: dict[tuple[int, int], tuple[ast.expr, str]] = {
        (node.lineno, node.col_offset): (node, node.value) for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }
    writes = Counter(name for statement in tree.body for name in _assigned_names(statement))
    global_writes = {name for node in ast.walk(tree) if isinstance(node, ast.Global) for name in node.names}
    bindings: dict[str, str] = {}
    remaining_expansion_bytes = 8 * 1024 * 1024
    for statement in tree.body:
        if not isinstance(statement, (ast.Assign, ast.AnnAssign)):
            continue
        value = statement.value
        targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
        if value is None or len(targets) != 1 or not isinstance(targets[0], ast.Name):
            continue
        name = targets[0].id
        if writes[name] != 1 or name in global_writes:
            continue
        text = _closed_string(value, bindings)
        if text is None:
            continue
        if not isinstance(value, ast.Constant):
            size = len(text.encode('utf-8'))
            if size > remaining_expansion_bytes:
                continue
            remaining_expansion_bytes -= size
        bindings[name] = text
        for fragment in ast.walk(value):
            if isinstance(fragment, ast.Constant) and isinstance(fragment.value, str):
                literals.pop((fragment.lineno, fragment.col_offset), None)
        literals[(value.lineno, value.col_offset)] = (value, text)
    return literals


class _Trace:
    def __init__(self, source: SourceFile):
        self.source = source
        self.tree = ast.parse(source.text)
        self.imports = resolve_python_imports(source)
        self.factory_calls = analyze_factory_calls(source)
        writes = Counter(name for statement in self.tree.body for name in _assigned_names(statement))
        globals_ = {name for node in ast.walk(self.tree) if isinstance(node, ast.Global) for name in node.names}
        self.definitions = {node.name: node for node in self.tree.body if isinstance(node, ast.FunctionDef)
                            and writes[node.name] == 1 and node.name not in globals_ and not node.decorator_list}
        self.globals: dict[str, dict | None] = {name: {"kind": "import", "qualified": value.qualified_name}
                                              for name, value in self.imports.bindings.items()}
        self.globals.update({name: {"kind": "function", "name": name} for name in self.definitions})
        for name in ('list', 'tuple'):
            if not writes[name] and name not in globals_ and name not in self.globals:
                self.globals[name] = {'kind': 'builtin', 'name': name}
        names = {name: value.qualified_name for name, value in self.imports.bindings.items()}
        literals = python_sql_literals(self.tree)
        for statement in self.tree.body:
            if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
                name = statement.targets[0].id
                if writes[name] == 1 and name not in globals_:
                    value = statement.value
                    if isinstance(value, ast.Call) and _qualified(value.func, names) == "sqlalchemy.text" and len(value.args) == 1 and not value.keywords:
                        value = value.args[0]
                    literal = literals.get((value.lineno, value.col_offset))
                    # A concatenation shares its start with its first fragment.
                    # Coordinates alone must not turn an unknown expression into
                    # a successfully bound partial SQL string.
                    if literal is not None and literal[0] is value:
                        self.globals[name] = self.literal(*literal)
        self.eligible: set[str] = set()
        for item in self.factory_calls["assignments"]:
            if _has_factory(item["value"], self.eligible):
                self.eligible.add(item["id"])
        declarations = [node for node in self.tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
        self.relevant = {definition.name for definition in declarations
                         if any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                                and node.func.attr in {"execute", "connect", "begin"} for node in ast.walk(definition))}
        while True:
            more = {definition.name for definition in declarations
                    if any(isinstance(node, ast.Name) and node.id in self.relevant for node in ast.walk(definition))}
            if more <= self.relevant:
                break
            self.relevant.update(more)
        self.uses: list[dict] = []
        self.findings: list[dict] = []
        # Private syntax frames, not Python iterators or evaluated source values.
        self.deferred: list[dict] = []
        self.steps = 20000

    def tick(self) -> None:
        self.steps -= 1
        if self.steps < 0 or len(self.uses) >= 512:
            raise _Limit()

    def literal(self, node: ast.expr, text: str) -> dict:
        return {"kind": "sql_literal", "line": node.lineno, "column": node.col_offset,
                "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "process": f"process:sql:{self.source.path}:python-string-{node.lineno}"}

    def finding(self, node: ast.AST, reason: str) -> None:
        self.findings.append({"line": getattr(node, "lineno", 0), "reason": reason})

    def function(self, definition: ast.FunctionDef, values: dict, path: tuple[str, ...], stack: tuple[str, ...], guards: tuple[dict, ...]) -> None:
        if definition.name in stack or len(stack) >= 12:
            self.finding(definition, "recursive_or_deep_call_not_traced")
            return
        if any(isinstance(node, (ast.Yield, ast.YieldFrom)) for node in ast.walk(definition)):
            self.finding(definition, "generator_helper_not_traced")
            return
        locals_ = {name for statement in definition.body for name in _assigned_names(statement)}
        args = definition.args
        parameters = {arg.arg for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs]}
        parameters.update(arg.arg for arg in [args.vararg, args.kwarg] if arg is not None)
        env = {name: value for name, value in self.globals.items() if name not in locals_ | parameters}
        env.update({name: values.get(name) for name in parameters})
        self.block(definition.body, env, path, (*stack, definition.name), guards)

    def expression(self, node: ast.expr, env: dict, path: tuple[str, ...], stack: tuple[str, ...], guards: tuple[dict, ...]) -> dict | None:
        self.tick()
        if isinstance(node, ast.Name):
            return env.get(node.id)
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return self.literal(node, node.value)
        if isinstance(node, ast.Attribute):
            owner = self.expression(node.value, env, path, stack, guards)
            if owner and owner.get("kind") == "import":
                return {"kind": "import", "qualified": owner["qualified"] + "." + node.attr}
            return None
        if isinstance(node, ast.Call):
            return self.call(node, env, path, stack, guards)
        if isinstance(node, (ast.BoolOp, ast.IfExp)):
            if isinstance(node, ast.IfExp):
                self.expression(node.test, env, path, stack, guards)
                branches = [(node.body, {"kind": "conditional_expression", "line": node.lineno, "branch": True}),
                            (node.orelse, {"kind": "conditional_expression", "line": node.lineno, "branch": False})]
            else:
                branches = [(value, {"kind": "boolean_operand", "line": node.lineno, "index": index,
                                     "operator": "or" if isinstance(node.op, ast.Or) else "and"}) for index, value in enumerate(node.values)]
            for value, guard in branches:
                self.expression(value, dict(env), path, stack, (*guards, guard))
            for name in _assigned_names(node):
                env[name] = None
            return None
        if isinstance(node, ast.GeneratorExp):
            # Only the outer iterable is evaluated at construction. Free names
            # are late-bound in the defining scope when a consumer iterates it.
            first = self.expression(node.generators[0].iter, env, path, stack, guards)
            reference = {'kind': 'deferred_generator', 'index': len(self.deferred)}
            self.deferred.append({'node': node, 'env': env, 'path': path, 'stack': stack,
                                  'guards': guards, 'first': first, 'consumers': []})
            return reference
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp)):
            local = dict(env)
            for generator in node.generators:
                self.expression(generator.iter, local, path, stack, guards)
                for name in _assigned_names(generator.target):
                    local[name] = None
                for condition in generator.ifs:
                    self.expression(condition, local, path, stack, guards)
            body = [node.key, node.value] if isinstance(node, ast.DictComp) else [node.elt]
            for value in body:
                self.expression(value, local, path, stack, (*guards, {"kind": "comprehension", "line": node.lineno}))
            return None
        if isinstance(node, ast.Lambda):
            return None
        if isinstance(node, ast.NamedExpr):
            self.expression(node.value, env, path, stack, guards)
            for name in _assigned_names(node.target):
                env[name] = None
            self.finding(node, "assignment_expression_not_bound")
            return None
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.expr):
                self.expression(child, env, path, stack, guards)
        return None

    def consume_generator(self, value: dict | None, consumer: ast.expr, path: tuple[str, ...], guards: tuple[dict, ...]) -> None:
        if not value or value.get('kind') != 'deferred_generator':
            return
        self.tick()
        frame = self.deferred[value['index']]
        node = frame['node']
        # A second syntactic consumer requires branch/exhaustion analysis. Do
        # not invent a second execution or silently certify a reused iterator.
        if frame['consumers']:
            self.finding(consumer, 'generator_reuse_not_traced')
            return
        observation = {'generator_line': node.lineno, 'generator_column': node.col_offset,
                       'creation_call_path': list(frame['path']), 'consumer_line': consumer.lineno,
                       'consumer_column': consumer.col_offset, 'consumer_call_path': list(path),
                       'body_traced': False, 'execution_verified': False}
        frame['consumers'].append(observation)
        if any(generator.is_async for generator in node.generators):
            self.finding(node, 'async_generator_not_traced')
            return
        local = dict(frame['env'])
        body_guards = (*frame['guards'], *guards, {'kind': 'generator_consumption', 'line': node.lineno,
                                                'consumer_line': consumer.lineno, 'consumer_call_path': list(path)})
        for index, generator in enumerate(node.generators):
            iterable = frame['first'] if index == 0 else self.expression(
                generator.iter, local, frame['path'], frame['stack'], body_guards)
            self.consume_generator(iterable, generator.iter, path, body_guards)
            for name in _assigned_names(generator.target):
                local[name] = None
            for condition in generator.ifs:
                self.expression(condition, local, frame['path'], frame['stack'], body_guards)
        self.expression(node.elt, local, frame['path'], frame['stack'], body_guards)
        observation['body_traced'] = True

    def call(self, node: ast.Call, env: dict, path: tuple[str, ...], stack: tuple[str, ...], guards: tuple[dict, ...]) -> dict | None:
        owner = self.expression(node.func.value, env, path, stack, guards) if isinstance(node.func, ast.Attribute) else None
        if isinstance(node.func, ast.Attribute):
            callee = {"kind": "import", "qualified": owner["qualified"] + "." + node.func.attr} if owner and owner.get("kind") == "import" else None
        else:
            callee = self.expression(node.func, env, path, stack, guards)
        # Evaluate nested argument calls once, even when the outer helper is irrelevant.
        evaluated = {id(value): self.expression(value, env, path, stack, guards)
                     for value in [*node.args, *(keyword.value for keyword in node.keywords)]}
        if callee and callee.get("kind") == "import" and callee["qualified"] == "sqlalchemy.text":
            return evaluated.get(id(node.args[0])) if len(node.args) == 1 and not node.keywords else None
        if callee and callee.get('kind') == 'builtin' and callee['name'] in {'list', 'tuple'} and len(node.args) == 1 and not node.keywords:
            self.consume_generator(evaluated.get(id(node.args[0])), node, path, guards)
            return None
        forwards_generator = callee and callee.get('kind') == 'function' and callee['name'] in self.relevant
        if not forwards_generator and any(value and value.get('kind') == 'deferred_generator' for value in evaluated.values()):
            self.finding(node, 'generator_consumer_unresolved')
        if isinstance(node.func, ast.Attribute) and node.func.attr == "execute":
            statement = evaluated.get(id(node.args[0])) if node.args else None
            connection = owner if owner and owner.get("kind") == "acquisition" else None
            sql = statement if statement and statement.get("kind") == "sql_literal" else None
            self.uses.append({"line": node.lineno, "column": node.col_offset, "function": stack[-1],
                              "call_path": list(path), "guards": list(guards), "connection": connection, "sql": sql,
                              "binding_status": "SYNTAX_BOUND" if connection and sql else "UNRESOLVED",
                              "execution_verified": False})
        if (not callee or callee.get("kind") != "function") and isinstance(node.func, ast.Name) and node.func.id in self.relevant:
            self.finding(node, "helper_callable_unresolved")
        if callee and callee.get("kind") == "function" and callee["name"] in self.relevant:
            definition = self.definitions[callee["name"]]
            arguments, reason = _arguments(node, definition)
            if reason:
                self.finding(node, reason)
            else:
                self.function(definition, {name: evaluated.get(id(value)) for name, value in (arguments or {}).items()},
                              (*path, f"{node.lineno}:{node.col_offset}->{definition.name}"), stack, guards)
        return None

    def block(self, statements: list[ast.stmt], env: dict, path: tuple[str, ...], stack: tuple[str, ...], guards: tuple[dict, ...]) -> bool:
        for statement in statements:
            self.tick()
            if isinstance(statement, (ast.Assign, ast.AnnAssign)):
                value = self.expression(statement.value, env, path, stack, guards) if statement.value else None
                identifier = f"assignment:{statement.lineno}:{statement.col_offset}"
                if identifier in self.eligible:
                    value = {"kind": "factory_selection", "assignment_id": identifier}
                targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
                for target in targets:
                    for name in _assigned_names(target):
                        env[name] = value if isinstance(target, ast.Name) else None
            elif isinstance(statement, ast.Expr):
                self.expression(statement.value, env, path, stack, guards)
            elif isinstance(statement, (ast.Return, ast.Raise)):
                value = statement.value if isinstance(statement, ast.Return) else statement.exc
                if value is not None:
                    self.expression(value, env, path, stack, guards)
                return False
            elif isinstance(statement, ast.If):
                self.expression(statement.test, env, path, stack, guards)
                left, right = dict(env), dict(env)
                alive_left = self.block(statement.body, left, path, stack, (*guards, {"kind": "if", "line": statement.lineno, "branch": True}))
                alive_right = self.block(statement.orelse, right, path, stack, (*guards, {"kind": "if", "line": statement.lineno, "branch": False}))
                env.clear()
                env.update(_same_merge(left, right) if alive_left and alive_right else left if alive_left else right)
                if not alive_left and not alive_right:
                    return False
                if alive_left != alive_right:
                    guards = (*guards, {"kind": "if", "line": statement.lineno, "branch": alive_left})
            elif isinstance(statement, (ast.For, ast.While)):
                self.expression(statement.iter if isinstance(statement, ast.For) else statement.test, env, path, stack, guards)
                local = dict(env)
                for name in _assigned_names(statement):
                    local[name] = None
                self.block(statement.body, local, path, stack, (*guards, {"kind": "loop", "line": statement.lineno}))
                self.block(statement.orelse, local, path, stack, (*guards, {"kind": "loop_else", "line": statement.lineno}))
                for name in _assigned_names(statement):
                    env[name] = None
            elif isinstance(statement, ast.With):
                if not self.with_block(statement, env, path, stack, guards):
                    return False
            elif isinstance(statement, (ast.Try, ast.TryStar)):
                initial = dict(env)
                normal = dict(env)
                alive = self.block(statement.body, normal, path, stack, (*guards, {"kind": "try", "line": statement.lineno}))
                if alive:
                    alive = self.block(statement.orelse, normal, path, stack, guards)
                surviving = alive
                for handler in statement.handlers:
                    exceptional = dict(initial)
                    for name in _assigned_names(statement):
                        exceptional[name] = None
                    handler_alive = self.block(handler.body, exceptional, path, stack, (*guards, {"kind": "except", "line": handler.lineno}))
                    surviving = surviving or handler_alive
                env.update(normal)
                for name in _assigned_names(statement):
                    env[name] = None  # No optimistic state merge across exceptions.
                finally_alive = self.block(statement.finalbody, env, path, stack, (*guards, {"kind": "finally", "line": statement.lineno}))
                if not surviving or not finally_alive:
                    return False
            elif isinstance(statement, ast.Pass):
                continue
            else:
                for name in _assigned_names(statement):
                    env[name] = None
                self.finding(statement, "statement_not_traced")
                if isinstance(statement, (ast.Break, ast.Continue)):
                    return False
        return True

    def with_block(self, node: ast.With, env: dict, path: tuple[str, ...], stack: tuple[str, ...], guards: tuple[dict, ...]) -> bool:
        local = dict(env)
        acquisitions = []
        for item in node.items:
            expression = item.context_expr
            value = None
            if isinstance(expression, ast.Call) and isinstance(expression.func, ast.Attribute) and expression.func.attr in {"connect", "begin"} and not expression.args and not expression.keywords:
                engine = self.expression(expression.func.value, local, path, stack, guards)
                if engine and engine.get("kind") in {"factory_selection", "parameter"}:
                    value = {"kind": "acquisition", "line": expression.lineno, "method": expression.func.attr,
                             "engine_origin": engine, "call_path": list(path), "runtime_identity_verified": False}
                    acquisitions.append(value)
            else:
                self.expression(expression, local, path, stack, guards)
            if item.optional_vars:
                for name in _assigned_names(item.optional_vars):
                    local[name] = value if isinstance(item.optional_vars, ast.Name) else None
        alive = self.block(node.body, local, path, stack, (*guards, {"kind": "with", "line": node.lineno}))
        env.update({name: None if value in acquisitions else value for name, value in local.items()})
        return alive


def analyze_sql_execution(source: SourceFile, *, entrypoint: str) -> dict:
    # Validate before parsing; entrypoint selects syntax only, never executes it.
    try:
        resolve_python_imports(source)
        trace = _Trace(source)
    except RecursionError:
        raise ValueError("sql_trace_limit") from None
    if entrypoint not in trace.definitions:
        raise ValueError("sql_trace_entrypoint_unresolved")
    definition = trace.definitions[entrypoint]
    parameters = [*definition.args.posonlyargs, *definition.args.args, *definition.args.kwonlyargs]
    try:
        trace.function(definition, {arg.arg: {"kind": "parameter", "function": entrypoint, "name": arg.arg} for arg in parameters},
                       (f"entry:{entrypoint}:{definition.lineno}",), (), ())
    except (_Limit, RecursionError):
        trace.findings.append({"line": 0, "reason": "sql_trace_limit"})
    for frame in trace.deferred:
        if not frame['consumers']:
            trace.finding(frame['node'], 'deferred_generator_body_not_traced')
    return {"format": "dataflow-discovery.python-sql/1", "path": source.path, "file_sha256": source.sha256,
            "entrypoint": entrypoint, "uses": trace.uses, "unresolved": trace.findings,
            "generator_consumptions": [item for frame in trace.deferred for item in frame['consumers']],
            "factory_calls": trace.factory_calls, "runtime_identity_verified": False, "publication_authorized": False}
