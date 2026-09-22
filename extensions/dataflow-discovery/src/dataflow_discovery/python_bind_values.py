"""Source-bound Python expression transport to SQL parameters; no evaluation.

This graph preserves unresolved calls, branches and mutations. It is not a
Python interpreter, complete points-to analysis or permission to publish edges.
"""
from __future__ import annotations

import ast
from collections import Counter
import hashlib
from typing import Any

from .catalog import CatalogBindingError, _digest
from .python_calls import _arguments
from .python_imports import _assigned_names, resolve_python_imports
from .python_sql import analyze_sql_execution
from .python_write_parameters import bind_python_sql_write_parameters


def _record_types(tree, imports, writes, globals_):
    """Only plain, required-field dataclasses; do not emulate custom constructors."""
    records = {}
    for node in tree.body:
        if not isinstance(node, ast.ClassDef) or writes[node.name] != 1 or node.name in globals_ or node.bases or node.keywords or len(node.decorator_list) != 1:
            continue
        decorator = node.decorator_list[0]
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        parts = []
        while isinstance(target, ast.Attribute):
            parts.insert(0, target.attr)
            target = target.value
        if not isinstance(target, ast.Name) or target.id not in imports:
            continue
        qualified = '.'.join([imports[target.id].qualified_name, *parts])
        if qualified != 'dataclasses.dataclass':
            continue
        if isinstance(decorator, ast.Call) and (decorator.args or any(
                item.arg != 'frozen' or not isinstance(item.value, ast.Constant) or type(item.value.value) is not bool
                for item in decorator.keywords) or len(decorator.keywords) > 1):
            continue
        fields = []
        properties = []
        for statement in node.body:
            if isinstance(statement, ast.Pass) or isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str):
                continue
            if isinstance(statement, ast.FunctionDef) and not statement.name.startswith('__') and len(statement.decorator_list) == 1 and isinstance(statement.decorator_list[0], ast.Name) and statement.decorator_list[0].id == 'property' and not writes['property'] and 'property' not in globals_ and 'property' not in imports:
                properties.append(statement.name)
                continue
            if not isinstance(statement, ast.AnnAssign) or not isinstance(statement.target, ast.Name) or statement.value is not None:
                break
            annotation_names = [item.id for item in ast.walk(statement.annotation) if isinstance(item, ast.Name)]
            excluded = {'ClassVar', 'InitVar', 'KW_ONLY'}
            if (any(name in excluded or name in imports and imports[name].qualified_name.rsplit('.', 1)[-1] in excluded for name in annotation_names)
                    or any(isinstance(item, ast.Attribute) and item.attr in excluded or isinstance(item, ast.Constant) and isinstance(item.value, str) for item in ast.walk(statement.annotation))):
                break
            fields.append(statement.target.id)
        else:
            if fields and len(set(fields)) == len(fields) and not set(fields).intersection(properties) and len(set(properties)) == len(properties):
                records[node.name] = {'name': node.name, 'definition_line': node.lineno, 'fields': fields}
    return records


def _loaded_names(node: ast.AST, bound: set[str] | frozenset[str] = frozenset()) -> set[str]:
    """Lexical loads: a comprehension target is not its surrounding namesake."""
    if isinstance(node, ast.Name):
        return {node.id} if isinstance(node.ctx, ast.Load) and node.id not in bound else set()
    if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
        result, local = set(), set(bound)
        for generator in node.generators:
            result.update(_loaded_names(generator.iter, local))
            local.update(_assigned_names(generator.target))
            for condition in generator.ifs:
                result.update(_loaded_names(condition, local))
        for value in ([node.key, node.value] if isinstance(node, ast.DictComp) else [node.elt]):
            result.update(_loaded_names(value, local))
        return result
    return set().union(*(_loaded_names(child, bound) for child in ast.iter_child_nodes(node)))


def _parameter_return(function):
    """A body-only syntactic fact, not runtime callable identity or general purity."""
    body = function.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:]
    if function.decorator_list or len(body) != 1 or not isinstance(body[0], ast.Return) or not isinstance(body[0].value, ast.Name):
        return None
    args = function.args
    names = {arg.arg for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs,
                                *([args.vararg] if args.vararg else []), *([args.kwarg] if args.kwarg else [])]}
    return body[0].value.id if body[0].value.id in names else None


def _terminates(block):
    """All normal continuations exit explicitly; no evaluation of predicates."""
    for statement in block:
        if isinstance(statement, (ast.Return, ast.Raise)):
            return True
        if isinstance(statement, ast.If) and _terminates(statement.body) and _terminates(statement.orelse):
            return True
        if (isinstance(statement, ast.Try) and not statement.finalbody and not statement.orelse
                and _terminates(statement.body) and all(_terminates(handler.body) for handler in statement.handlers)):
            return True
    return False


class _Graph:
    def __init__(self, source, *, sql_uses=(), companions=()):
        self.source = source
        self.imports = resolve_python_imports(source).bindings
        self.tree = ast.parse(source.text)
        self.date_parameter_types = self.date_parameter_definitions(companions)
        self.parents = {id(child): parent for parent in ast.walk(self.tree) for child in ast.iter_child_nodes(parent)}
        writes = Counter(name for statement in self.tree.body for name in _assigned_names(statement))
        globals_ = {name for node in ast.walk(self.tree) if isinstance(node, ast.Global) for name in node.names}
        self.functions = {node.name: node for node in self.tree.body if isinstance(node, ast.FunctionDef)
                          and writes[node.name] == 1 and node.name not in globals_ and not node.decorator_list}
        self.records = _record_types(self.tree, self.imports, writes, globals_)
        self.properties: dict[str, list[ast.FunctionDef]] = {}
        for node in self.tree.body:
            if isinstance(node, ast.ClassDef) and node.name in self.records:
                for member in node.body:
                    if isinstance(member, ast.FunctionDef):
                        self.properties.setdefault(member.name, []).append(member)
        self.module_bindings = set(writes) | globals_ | set(self.imports)
        self.module_constants = {}
        for statement in self.tree.body:
            targets = (statement.targets if isinstance(statement, ast.Assign) else
                       [statement.target] if isinstance(statement, ast.AnnAssign) else [])
            if len(targets) == 1 and isinstance(targets[0], ast.Name):
                name = targets[0].id
                if (writes[name] == 1 and name not in globals_
                        and self.constant_initializer(statement.value)):
                    self.module_constants[name] = statement.value
        sites = {(use['line'], use['column']) for use in sql_uses}
        self.sql_parameter_reads = {site for site in sites if all(
            use['binding_status'] == 'SYNTAX_BOUND'
            and use.get('connection', {}).get('engine_origin', {}).get('kind') == 'factory_selection'
            for use in sql_uses
            if (use['line'], use['column']) == site)}
        self.nodes: list[dict] = []
        self.memo: dict[tuple, str] = {}
        self.active: set[tuple] = set()
        self.findings: list[dict] = []
        self.frame_paths: dict[str, list[str]] = {}

    def date_parameter_definitions(self, companions):
        """Date fields declared in captured frozen dataclasses, not imported code.

        This describes the entrypoint's parameter contract. It is not a runtime
        parameter value, proof of an import resolution, or a database column.
        """
        result = {}
        for alias, binding in self.imports.items():
            module, _, name = binding.qualified_name.rpartition('.')
            suffix = module.replace('.', '/') + '.py'
            matches = [file for file in companions if file.path == suffix or file.path.endswith('/' + suffix)]
            if len(matches) != 1:
                continue
            file = matches[0]
            try:
                tree = ast.parse(file.text)
            except SyntaxError:
                continue
            imports = resolve_python_imports(file).bindings
            definitions = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name]
            writes = Counter(bound for statement in tree.body for bound in _assigned_names(statement))
            globals_ = {bound for node in ast.walk(tree) if isinstance(node, ast.Global) for bound in node.names}
            if len(definitions) != 1 or writes[name] != 1 or name in globals_:
                continue
            definition = definitions[0]
            if definition.bases or definition.keywords or len(definition.decorator_list) != 1:
                continue
            decorator = definition.decorator_list[0]
            if (not isinstance(decorator, ast.Call) or decorator.args or not isinstance(decorator.func, ast.Name)
                    or decorator.func.id not in imports or imports[decorator.func.id].qualified_name != 'dataclasses.dataclass'
                    or len(decorator.keywords) != 1 or decorator.keywords[0].arg != 'frozen'
                    or not isinstance(decorator.keywords[0].value, ast.Constant)
                    # pi-lens-ignore: no-identity-operator-on-literals -- True is the exact bool singleton; integer 1 is not accepted.
                    or decorator.keywords[0].value.value is not True):
                continue
            members = [node for node in definition.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
            if any(member.name.startswith('__') for member in members):
                continue
            class_bindings = Counter(bound for member in definition.body for bound in _assigned_names(member))
            fields = {}
            for node in definition.body:
                if (isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
                        and isinstance(node.annotation, ast.Name) and node.annotation.id in imports
                        and not class_bindings[node.annotation.id] and class_bindings[node.target.id] == 1
                        and imports[node.annotation.id].qualified_name == 'datetime.date'
                        and not any(member.name == node.target.id for member in members)):
                    fields[node.target.id] = {'path': file.path, 'file_sha256': file.sha256,
                        'line': node.lineno, 'qualified_type': binding.qualified_name,
                        'default_declared': node.value is not None}
            if fields:
                result[alias] = fields
        return result

    def date_parameter_field(self, node, function):
        if not isinstance(node.value, ast.Name) or function is self.tree:
            return None
        args = [*function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs]
        argument = next((arg for arg in args if arg.arg == node.value.id), None)
        if argument is None or not isinstance(argument.annotation, ast.Name):
            return None
        fields = self.date_parameter_types.get(argument.annotation.id, {})
        if node.attr not in fields:
            return None
        # Rebinding the parameter or altering its members invalidates the contract.
        if any(argument.arg in _assigned_names(statement) for statement in function.body):
            return None
        if any(isinstance(item, (ast.Attribute, ast.Subscript)) and isinstance(item.ctx, (ast.Store, ast.Del))
               and isinstance(item.value, ast.Name) and item.value.id == argument.arg
               for item in self.local_nodes(function)):
            return None
        return {'parameter': argument.arg, 'field': node.attr, 'function': function.name,
                'definition': fields[node.attr], 'runtime_parameter_verified': False}

    def date_series(self, node, function, parameters, local, frame, depth, writes):
        if len(writes) != 2:
            return None
        owners = [self.parents[id(write)] for write in writes]
        initial = next((item for item in owners if isinstance(item, ast.Assign)), None)
        update = next((item for item in owners if isinstance(item, ast.AugAssign)), None)
        if initial is None or update is None or len(initial.targets) != 1 or initial not in function.body:
            return None
        loop = self.parents.get(id(update))
        if (not isinstance(loop, ast.While) or loop not in function.body or loop.orelse
                or loop not in self.ancestors(node) or function.body.index(initial) >= function.body.index(loop)
                or len(loop.body) != 2 or loop.body[-1] is not update or not isinstance(update.op, ast.Add)):
            return None
        test = loop.test
        if (not isinstance(test, ast.Compare) or len(test.ops) != 1 or not isinstance(test.ops[0], (ast.Lt, ast.LtE))
                or not isinstance(test.left, ast.Name) or test.left.id != node.id
                or not isinstance(initial.value, ast.Attribute) or not isinstance(test.comparators[0], ast.Attribute)):
            return None
        start = self.date_parameter_field(initial.value, function)
        end = self.date_parameter_field(test.comparators[0], function)
        step = update.value
        if (start is None or end is None or not isinstance(step, ast.Call) or step.args
                or not isinstance(step.func, ast.Name) or len(step.keywords) != 1
                or step.keywords[0].arg != 'days' or not isinstance(step.keywords[0].value, ast.Constant)
                or type(step.keywords[0].value.value) is not int or step.keywords[0].value.value <= 0):
            return None
        callee = self.resolve(step.func, function, parameters, local, frame, depth + 1)
        target = next(item for item in self.nodes if item['id'] == callee)
        if target['kind'] != 'import_syntax' or target['qualified_name'] != 'datetime.timedelta':
            return None
        return self.add(node, 'generated_date_series', start=start, end=end,
                        step_days=step.keywords[0].value.value, inclusive=isinstance(test.ops[0], ast.LtE),
                        loop_line=loop.lineno, runtime_parameter_verified=False, iteration_verified=False)

    def constant_initializer(self, node):
        """Only immutable literal/stdlib constructor initializers, not globals in general."""
        if isinstance(node, ast.Constant):
            return True
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            return self.constant_initializer(node.operand)
        if isinstance(node, ast.Tuple):
            return all(self.constant_initializer(item) for item in node.elts)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            imported = self.imports.get(node.func.id)
            return (imported is not None and imported.qualified_name in {
                'decimal.Decimal', 'datetime.date', 'datetime.timedelta'}
                and all(self.constant_initializer(item) for item in node.args)
                and all(item.arg is not None and self.constant_initializer(item.value) for item in node.keywords))
        return False

    def bind_defaults(self, function, arguments):
        """Bind only immutable source defaults in definition (module) scope."""
        result = dict(arguments)
        args = function.args
        positional = [*args.posonlyargs, *args.args]
        defaults = [*zip(positional[len(positional) - len(args.defaults):], args.defaults),
                    *zip(args.kwonlyargs, args.kw_defaults)]
        for parameter, default in defaults:
            if parameter.arg not in result and default is not None and self.constant_initializer(default):
                result[parameter.arg] = self.resolve(default, self.tree, {}, {}, 'module-default')
        return result

    def guarded_type(self, node, function):
        """Recognize a dominating, unshadowed isinstance branch in this source."""
        if not isinstance(node, ast.Name) or function is self.tree:
            return None
        bound = set(self.module_bindings)
        bound.update(arg.arg for arg in [*function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs])
        bound.update(name for statement in function.body for name in _assigned_names(statement))
        if 'isinstance' in bound:
            return None
        for parent in self.ancestors(node):
            if parent is function:
                break
            if not isinstance(parent, ast.If) or not any(node in ast.walk(item) for item in parent.body):
                continue
            test = parent.test
            if (isinstance(test, ast.Call) and isinstance(test.func, ast.Name) and test.func.id == 'isinstance'
                    and len(test.args) == 2 and not test.keywords and isinstance(test.args[0], ast.Name)
                    and test.args[0].id == node.id and isinstance(test.args[1], ast.Name)):
                symbol = self.imports.get(test.args[1].id)
                if symbol and symbol.qualified_name in {'datetime.date', 'datetime.datetime', 'decimal.Decimal'}:
                    return symbol.qualified_name
        return None

    def scalar_type(self, reference, seen=frozenset(), known_types=None):
        """Small immutable-type summary; never run a constructor or a helper."""
        if known_types and known_types.get(reference):
            return known_types[reference]
        if reference in seen or len(seen) >= 64:
            return None
        seen = seen | {reference}
        node = self.nodes[int(reference.split(':')[1])]
        kind = node['kind']
        if kind == 'literal':
            return node['literal_type']
        if kind == 'generated_date_series':
            return 'datetime.date'
        if kind in {'assignment', 'parameter'}:
            if kind == 'parameter' and node.get('guard_type'):
                return node['guard_type']
            return self.scalar_type(node['value_ref'] if kind == 'assignment' else node['argument_ref'], seen, known_types)
        if kind == 'return_alternatives' and node['explicit_exit_coverage']:
            types = {self.scalar_type(item['value_ref'], seen, known_types) for item in node['alternatives']}
            return next(iter(types)) if len(types) == 1 else None
        if kind == 'attribute' and node['attribute'] in {'year', 'month', 'day'}:
            if self.scalar_type(node['owner_ref'], seen, known_types) in {'datetime.date', 'datetime.datetime'}:
                return 'int'
        if kind == 'binary_expression':
            types = {self.scalar_type(node[key], seen, known_types) for key in ('left_ref', 'right_ref')}
            operator = node['operator']
            if operator in {'Add', 'Sub', 'Mult', 'Div', 'FloorDiv', 'Mod'}:
                if types <= {'int', 'decimal.Decimal'} and 'decimal.Decimal' in types:
                    return 'decimal.Decimal'
                if types <= {'int', 'float'}:
                    return 'float' if 'float' in types or operator == 'Div' else 'int'
                if types == {'str'} and operator == 'Add':
                    return 'str'
        if kind == 'unary_expression' and node['operator'] in {'UAdd', 'USub', 'Invert'}:
            operand_type = self.scalar_type(node['operand_ref'], seen, known_types)
            if operand_type == 'int' or node['operator'] != 'Invert' and operand_type in {'float', 'decimal.Decimal'}:
                return operand_type
        if kind == 'call':
            callee = self.nodes[int(node['callee_ref'].split(':')[1])]
            if callee['kind'] == 'builtin_syntax' and callee['name'] in {'int', 'str', 'float', 'bool'}:
                return callee['name']
            if callee['kind'] == 'import_syntax' and callee['qualified_name'] in {
                    'decimal.Decimal', 'datetime.date', 'datetime.datetime', 'datetime.timedelta'}:
                return callee['qualified_name']
            if (callee['kind'] == 'attribute'
                    and self.scalar_type(callee['owner_ref'], seen, known_types) == 'decimal.Decimal'
                    and callee['attribute'] in {'quantize', 'copy_abs', 'copy_negate', 'normalize'}):
                return 'decimal.Decimal'
            if (callee['kind'] == 'attribute' and callee['attribute'] == 'date'
                    and self.scalar_type(callee['owner_ref'], seen, known_types) == 'datetime.datetime'):
                return 'datetime.date'
            if node.get('declared_return_ref') and node.get('return_paths_explicit'):
                return self.scalar_type(node['declared_return_ref'], seen, known_types)
        return None

    def add(self, node, kind, **values):
        if len(self.nodes) >= 10000:
            raise ValueError("python_bind_graph_limit")
        identifier = f"value:{len(self.nodes)}"
        self.nodes.append({"id": identifier, "kind": kind, "line": node.lineno,
                           "column": node.col_offset, **values})
        return identifier

    def ancestors(self, node):
        result = []
        while id(node) in self.parents:
            node = self.parents[id(node)]
            result.append(node)
        return result

    def local_nodes(self, function):
        # Nested lexical scopes do not bind this function's local names.
        pending = list(reversed(function.body))
        while pending:
            node = pending.pop()
            yield node
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            pending.extend(reversed(list(ast.iter_child_nodes(node))))

    def guards(self, node, function):
        guards = []
        while id(node) in self.parents:
            parent = self.parents[id(node)]
            if parent is function:
                break
            if isinstance(parent, (ast.If, ast.For, ast.While, ast.Try, ast.TryStar, ast.With, ast.ExceptHandler)):
                branch = next((field for field, value in ast.iter_fields(parent)
                               if value is node or isinstance(value, list) and node in value), 'unknown')
                guards.append({'kind': type(parent).__name__, 'line': parent.lineno, 'branch': branch})
            node = parent
        return guards

    def decimal_expression(self, node, local_bindings):
        """Only the existing Decimal constructor / Decimal-seeded sum shape.

        This identifies the declared immutable receiver, not rounding, input
        validity, successful arithmetic or runtime replacement of imported APIs.
        """
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            return False
        name = node.func.id
        if name in local_bindings:
            return False
        imported = self.imports.get(name)
        if imported and imported.qualified_name == 'decimal.Decimal':
            return True
        return (name == 'sum' and name not in self.module_bindings and len(node.args) == 2
                and not node.keywords and self.decimal_expression(node.args[1], local_bindings))

    def terminated_before(self, item, use):
        """A returning earlier if-branch cannot reach a later sibling use."""
        for branch in self.ancestors(item):
            if not isinstance(branch, ast.If) or branch in self.ancestors(use):
                continue
            clause = next((part for part in (branch.body, branch.orelse)
                           if any(item in ast.walk(statement) for statement in part)), [])
            if not clause or not isinstance(clause[-1], (ast.Return, ast.Raise)):
                continue
            parent = self.parents.get(id(branch))
            if parent is None:
                continue
            for _, siblings in ast.iter_fields(parent):
                if isinstance(siblings, list) and branch in siblings:
                    if any(isinstance(sibling, ast.AST) and use in ast.walk(sibling)
                           for sibling in siblings[siblings.index(branch) + 1:]):
                        return True
        return False

    def exposure_before(self, name, function, body, after, use, checking=()):
        """Conservative local alias/escape evidence, not general purity inference.

        Retain aliases across rebinding rather than guessing branch/lifetime
        effects. Recognized constructors/value operations, source-bound native
        consumers and inspected helper bodies avoid a blanket escape marker.
        Opaque consumers remain barriers; runtime identity and values are unverified.
        """
        key = (function.lineno, name)
        if key in checking or len(checking) >= 32:
            return 'recursive_helper_effects_unverified'
        checking = (*checking, key)
        aliases = {name}
        local_bindings = {bound for statement in function.body for bound in _assigned_names(statement)}
        args = function.args
        local_bindings.update(arg.arg for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs,
                                                   *([args.vararg] if args.vararg else []), *([args.kwarg] if args.kwarg else [])])
        before = (use.lineno, use.col_offset)
        earlier = sorted((item for item in body if hasattr(item, 'lineno') and after <= (item.lineno, item.col_offset)
                          and (item.end_lineno or item.lineno, item.end_col_offset or 0) <= before),
                         key=lambda item:(item.lineno, item.col_offset))
        for item in earlier:
            if self.terminated_before(item, use):
                continue
            visible_aliases = set(aliases)
            for parent in reversed(self.ancestors(item)):
                if isinstance(parent, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                    for generator in parent.generators:
                        if item in ast.walk(generator.iter):
                            break  # iterable uses the enclosing scope before binding its target
                        targets = set(_assigned_names(generator.target))
                        derived = bool(_loaded_names(generator.iter) & visible_aliases)
                        visible_aliases.difference_update(targets)
                        if derived:
                            visible_aliases.update(targets)
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                if (getattr(item, 'name', None) in visible_aliases or
                        any(isinstance(child, ast.Name) and child.id in aliases for child in ast.walk(item))):
                    return 'captured_object_effects_unverified'
            if isinstance(item, (ast.Import, ast.ImportFrom, ast.Match)):
                return 'dynamic_binding_effects_unverified'
            if isinstance(item, ast.ExceptHandler) and item.name in visible_aliases:
                return 'exception_binding_effects_unverified'
            if (isinstance(item, ast.Attribute) and isinstance(item.ctx, ast.Load)
                    and item.attr in self.properties and _loaded_names(item.value) & visible_aliases):
                # A same-named field is not automatically an effectful property.
                # Check every supported record getter with this name; never pick
                # an arbitrary class or trust an annotation. Cyclic getter reads
                # do not mutate by themselves; all other body effects are still
                # checked. This does not establish termination or getter values.
                for getter in self.properties[item.attr]:
                    args = getter.args
                    if len(args.posonlyargs) + len(args.args) != 1 or args.kwonlyargs or args.vararg or args.kwarg:
                        return 'property_effects_unverified'
                    parameter = (args.posonlyargs + args.args)[0].arg
                    if (getter.lineno, parameter) in checking:
                        continue
                    end = ast.Name(id=parameter, ctx=ast.Load())
                    end.lineno, end.col_offset = (getter.end_lineno or getter.lineno) + 1, 0
                    if self.exposure_before(parameter, getter, list(self.local_nodes(getter)),
                                            (getter.lineno, getter.col_offset), end, checking):
                        return 'property_effects_unverified'
            if isinstance(item, (ast.Global, ast.Nonlocal)):
                return 'nonlocal_helper_effects_unverified'
            if isinstance(item, ast.AugAssign) and any(
                    isinstance(child, ast.Name) and child.id in visible_aliases for child in ast.walk(item.target)):
                return 'alias_inplace_mutation'
            if isinstance(item, (ast.With, ast.AsyncWith)) and any(
                    _loaded_names(context.context_expr) & visible_aliases for context in item.items):
                return 'context_manager_effects_unverified'
            if isinstance(item, ast.For) and _loaded_names(item.iter) & visible_aliases:
                aliases.update(child.id for child in ast.walk(item.target) if isinstance(child, ast.Name))
            if isinstance(item, (ast.Assign, ast.AnnAssign, ast.NamedExpr)) and item.value is not None:
                referenced = _loaded_names(item.value)
                if referenced & visible_aliases:
                    targets = item.targets if isinstance(item, ast.Assign) else [item.target]
                    aliases.update(child.id for target in targets for child in ast.walk(target)
                                   if isinstance(child, ast.Name))
            if isinstance(item, (ast.Attribute, ast.Subscript)) and isinstance(item.ctx, (ast.Store, ast.Del)):
                roots = _loaded_names(item.value)
                if roots & visible_aliases:
                    return 'alias_item_mutation'
            if not isinstance(item, ast.Call):
                continue
            # Appending into a freshly allocated local list does not mutate the
            # appended object. Track the containing list as an alias thereafter,
            # so a later opaque consumer or item mutation is still rejected.
            if (isinstance(item.func, ast.Attribute) and item.func.attr == 'append'
                    and isinstance(item.func.value, ast.Name) and len(item.args) == 1 and not item.keywords):
                destination = item.func.value.id
                assignments = [entry for entry in body if isinstance(entry, ast.Name)
                               and entry.id == destination and isinstance(entry.ctx, (ast.Store, ast.Del))]
                if len(assignments) == 1:
                    assignment = self.parents.get(id(assignments[0]))
                    if (isinstance(assignment, (ast.Assign, ast.AnnAssign))
                            and isinstance(assignment.value, ast.List) and not assignment.value.elts
                            and assignment.lineno < item.lineno and destination != name):
                        if _loaded_names(item.args[0]) & visible_aliases:
                            aliases.add(destination)
                        continue
            if (isinstance(item.func, ast.Attribute) and item.func.attr == 'quantize'
                    and self.decimal_expression(item.func.value, local_bindings)):
                continue  # Decimal.quantize returns a value; it does not mutate its source records.
            if isinstance(item.func, ast.Attribute):
                roots = _loaded_names(item.func.value)
                if roots & visible_aliases and (len(checking) > 1 or not (
                        isinstance(item.func.value, ast.Name) and item.func.value.id == name)):
                    return 'alias_method_effects_unverified'
            arguments = [*item.args, *(keyword.value for keyword in item.keywords)]
            passed = any(_loaded_names(value) & visible_aliases for value in arguments)
            plain_record = (isinstance(item.func, ast.Name) and item.func.id in self.records
                            and item.func.id not in local_bindings)
            forwarding = (isinstance(item.func, ast.Name) and item.func.id in self.functions
                          and item.func.id not in local_bindings
                          and _parameter_return(self.functions[item.func.id]) is not None
                          and _arguments(item, self.functions[item.func.id])[1] is None)
            if passed and not plain_record and not forwarding:
                # Reuse the already-bound SQL invocation: execute consumes its
                # parameters, not a declaration that it mutates their container.
                # Any unbound invocation at the same site disables this fact.
                if (item.lineno, item.col_offset) in self.sql_parameter_reads:
                    continue
                if isinstance(item.func, ast.Name):
                    callee = item.func.id
                    if (callee in {'len', 'set', 'list', 'tuple', 'abs', 'sum', 'isinstance', 'int', 'str', 'float', 'bool'}
                            and callee not in local_bindings and callee not in self.module_bindings):
                        continue
                    if callee in self.functions and callee not in local_bindings:
                        called = self.functions[callee]
                        bound, reason = _arguments(item, called)
                        if reason is None:
                            end = ast.Name(id=name, ctx=ast.Load())
                            end.lineno, end.col_offset = (called.end_lineno or called.lineno) + 1, 0
                            effects = [self.exposure_before(parameter, called, list(self.local_nodes(called)),
                                        (called.lineno, called.col_offset), end, checking)
                                       for parameter, argument in (bound or {}).items()
                                       if _loaded_names(argument) & visible_aliases]
                            if effects and not any(effects):
                                continue
                return 'object_escape_effects_unverified'
        return None

    def parameter_reference(self, node, function, parameters, body, frame):
        name = node.id
        changed_calls = [item for item in body if isinstance(item, ast.Call) and isinstance(item.func, ast.Attribute)
                         and isinstance(item.func.value, ast.Name) and item.func.value.id == name
                         and (item.end_lineno or item.lineno, item.end_col_offset or 0) <= (node.lineno, node.col_offset)
                         and not self.terminated_before(item, node)]
        if changed_calls:
            return self.add(node, "unresolved", reason="parameter_object_method_effects", name=name)
        reference = self.add(node, "parameter", name=name, argument_ref=parameters[name], frame=frame,
                             guard_type=self.guarded_type(node, function))
        exposure = self.exposure_before(name, function, body, (function.lineno, function.col_offset), node)
        if exposure:
            return self.add(node, 'unresolved', reason=exposure, name=name, initial_declaration_ref=reference)
        return reference

    def name(self, node, function, parameters, local, frame, depth):
        name = node.id
        if name in local:
            return local[name]
        body = [] if function is self.tree else list(self.local_nodes(function))
        writes = [item for item in body if isinstance(item, ast.Name) and item.id == name
                  and isinstance(item.ctx, (ast.Store, ast.Del))
                  and not any(isinstance(parent, ast.comprehension) and item in ast.walk(parent.target) for parent in self.ancestors(item))]
        # Imports/definitions also make a name local, including later ones.
        named = [item for item in body if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and item.name == name]
        imported = [item for item in body if isinstance(item, (ast.Import, ast.ImportFrom))
                    for alias in item.names if (alias.asname or alias.name.split('.')[0]) == name or alias.name == '*']
        captured = [item for item in body if isinstance(item, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar, ast.MatchMapping)) and name in _assigned_names(item)]
        if named or imported or captured or any(isinstance(item, (ast.Global, ast.Nonlocal)) and name in item.names for item in body):
            return self.add(node, "unresolved", reason="local_binding_unresolved", name=name)
        changed_items = [item for item in body if isinstance(item, (ast.Subscript, ast.Attribute))
                         and isinstance(item.ctx, (ast.Store, ast.Del))
                         and isinstance(item.value, ast.Name) and item.value.id == name
                         and (item.lineno, item.col_offset) < (node.lineno, node.col_offset)]
        if changed_items:
            return self.add(node, "unresolved", reason="container_item_mutation", name=name)
        if name in parameters and not writes:
            return self.parameter_reference(node, function, parameters, body, frame)
        if len(writes) == 1:
            write = writes[0]
            owner = self.parents[id(write)]
            if isinstance(owner, ast.Tuple):
                assignment = self.parents.get(id(owner))
                if isinstance(assignment, ast.Assign) and len(assignment.targets) == 1 and assignment.targets[0] is owner and all(isinstance(item, ast.Name) for item in owner.elts) and len({item.id for item in owner.elts if isinstance(item, ast.Name)}) == len(owner.elts) and (assignment.end_lineno or assignment.lineno, assignment.end_col_offset or 0) <= (node.lineno, node.col_offset):
                    value = self.resolve(assignment.value, function, parameters, local, frame, depth + 1)
                    return self.add(node, 'tuple_item', sequence_ref=value, index=owner.elts.index(write),
                                    arity=len(owner.elts), guards=self.guards(assignment, function),
                                    has_incoming_definition=name in parameters, selection_verified=False)
            before = (getattr(owner, "end_lineno", None) or write.lineno, getattr(owner, "end_col_offset", None) or 0) <= (node.lineno, node.col_offset)
            if name in parameters and not before and owner not in self.ancestors(node):
                return self.parameter_reference(node, function, parameters, body, frame)
            if name in parameters and isinstance(owner, (ast.Assign, ast.AnnAssign)) and owner.value is not None and node in ast.walk(owner.value):
                return self.parameter_reference(node, function, parameters, body, frame)
            if isinstance(owner, (ast.For, ast.comprehension)) and owner in self.ancestors(node):
                return self.add(node, "iteration_element", iterable_ref=self.resolve(owner.iter, function, parameters, local, frame, depth + 1), frame=frame)
            if isinstance(owner, (ast.Assign, ast.AnnAssign)) and before and owner.value is not None:
                # A conditional assignment must dominate this exact use path.
                scopes = self.guards(owner, function)
                value = self.resolve(owner.value, function, parameters, local, frame, depth + 1)
                container = self.parents.get(id(owner))
                # A direct assignment in a top-level try reaches later code only
                # through its body when every handler aborts. Deliberately exclude
                # nested scopes, handler uses, else/finally and swallowing handlers;
                # this is normal-continuation dominance, not successful execution.
                aborting_try = (
                    isinstance(container, ast.Try) and container in function.body and owner in container.body
                    and (container.end_lineno or container.lineno, container.end_col_offset or 0) <= (node.lineno, node.col_offset)
                    and not container.orelse and not container.finalbody and bool(container.handlers)
                    and all(len(handler.body) == 1 and isinstance(handler.body[0], ast.Raise)
                            for handler in container.handlers))
                # A sole local definition inside `with` is required by a later
                # successful local read. Suppressed failure before assignment
                # produces UnboundLocalError, not a different resource origin.
                # Parameters retain an alternative incoming definition, so exclude them.
                with_local = (name not in parameters and isinstance(container, ast.With)
                              and container in function.body and owner in container.body
                              and (container.end_lineno or container.lineno, container.end_col_offset or 0)
                              <= (node.lineno, node.col_offset))
                if not all(guard in self.guards(node, function) for guard in scopes) and not aborting_try and not with_local:
                    return self.add(node, "unresolved", reason="assignment_not_dominating", name=name,
                                    initial_declaration_ref=value, guards=scopes)
                scalar_type = self.scalar_type(value)
                immutable = scalar_type in {'int', 'str', 'float', 'bool', 'NoneType', 'decimal.Decimal',
                                            'datetime.date', 'datetime.datetime', 'datetime.timedelta'}
                exposure = None if immutable else self.exposure_before(name, function, body,
                    (owner.end_lineno or owner.lineno, owner.end_col_offset or 0), node)
                mutations = [item for item in body if isinstance(item, ast.Call) and isinstance(item.func, ast.Attribute)
                             and isinstance(item.func.value, ast.Name) and item.func.value.id == name
                             and (owner.lineno, owner.col_offset) < (item.lineno, item.col_offset) < (node.lineno, node.col_offset)
                             and not (scalar_type == 'decimal.Decimal' and item.func.attr in {
                                 'quantize', 'copy_abs', 'copy_negate', 'normalize'})]
                if mutations:
                    if not isinstance(owner.value, ast.List) or owner.value.elts or any(not isinstance(item.func, ast.Attribute) or item.func.attr != 'append' or len(item.args) != 1 or item.keywords for item in mutations):
                        return self.add(node, "unresolved", reason="mutation_unresolved", name=name,
                                        initial_declaration_ref=value)
                    additions = [{"value_ref": self.resolve(item.args[0], function, parameters, local, frame, depth + 1),
                                  "guards": self.guards(item, function)} for item in mutations]
                    reference = self.add(node, "declared_append_collection", initial_ref=value, appends=additions,
                                         contents_verified=False, frame=frame)
                else:
                    reference = value if exposure else self.add(node, "assignment", name=name, value_ref=value, frame=frame,
                                                              guards=scopes, successful_use_only=with_local)
                if exposure:
                    return self.add(node, 'unresolved', reason=exposure, name=name, initial_declaration_ref=reference)
                return reference
        if writes:
            series = self.date_series(node, function, parameters, local, frame, depth, writes)
            if series is not None:
                return series
            return self.add(node, "unresolved", reason="rebound_or_unsupported_local", name=name)
        if name in self.imports:
            return self.add(node, "import_syntax", qualified_name=self.imports[name].qualified_name, identity_verified=False)
        if name in self.functions:
            return self.add(node, "function_syntax", name=name, definition_line=self.functions[name].lineno, identity_verified=False)
        if name in self.records:
            return self.add(node, "record_type_syntax", **self.records[name], identity_verified=False)
        if name in self.module_constants:
            value = self.resolve(self.module_constants[name], self.tree, {}, {}, 'module', depth + 1)
            return self.add(node, 'assignment', name=name, value_ref=value, frame='module', guards=[])
        if name in {'list', 'tuple', 'dict', 'int', 'str', 'float', 'bool', 'abs', 'sum', 'len', 'set', 'isinstance'}:
            module_writes = [item for item in ast.walk(self.tree) if isinstance(item, ast.Name) and item.id == name and isinstance(item.ctx, (ast.Store, ast.Del))]
            if not module_writes:
                return self.add(node, "builtin_syntax", name=name, identity_verified=False)
        return self.add(node, "unresolved", reason="name_value_unresolved", name=name)

    def resolve(self, node, function, parameters, local, frame, depth=0):
        key = (id(node), frame, tuple(sorted(local.items())))
        if key in self.memo:
            return self.memo[key]
        if depth >= 32 or key in self.active:
            return self.add(node, "unresolved", reason="recursive_or_deep_value")
        self.active.add(key)
        try:
            result = self.expression(node, function, parameters, local, frame, depth)
            self.memo[key] = result
            return result
        finally:
            self.active.remove(key)

    def literal_field(self, reference):
        seen = set()
        while reference not in seen:
            seen.add(reference)
            node = self.nodes[int(reference.split(':')[1])]
            if node['kind'] in {'parameter', 'assignment'}:
                reference = node['argument_ref'] if node['kind'] == 'parameter' else node['value_ref']
                continue
            if node['kind'] == 'literal' and node['literal_type'] == 'str':
                for literal in ast.walk(self.tree):
                    if isinstance(literal, ast.Constant) and isinstance(literal.value, str) and (literal.lineno, literal.col_offset) == (node['line'], node['column']):
                        if hashlib.sha256(repr(literal.value).encode()).hexdigest() == node['literal_sha256']:
                            return literal.value
            break
        return None

    def expression(self, node, function, parameters, local, frame, depth):
        def ref(value):
            return self.resolve(value, function, parameters, local, frame, depth + 1)
        if isinstance(node, ast.Name):
            return self.name(node, function, parameters, local, frame, depth)
        if isinstance(node, ast.Constant):
            return self.add(node, "literal", literal_type=type(node.value).__name__,
                            literal_sha256=hashlib.sha256(repr(node.value).encode()).hexdigest())
        if isinstance(node, ast.Attribute):
            return self.add(node, "attribute", owner_ref=ref(node.value), attribute=node.attr)
        if isinstance(node, ast.Subscript):
            key = node.slice
            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                return self.add(node, "mapping_field", owner_ref=ref(node.value), field_name=key.value)
            return self.add(node, "lookup", owner_ref=ref(node.value), key_ref=ref(key), lookup_verified=False)
        if isinstance(node, ast.Dict):
            names = [key.value for key in node.keys if isinstance(key, ast.Constant) and isinstance(key.value, str)]
            if len(names) != len(node.keys) or len(set(names)) != len(names):
                return self.add(node, "unresolved", reason="dynamic_or_duplicate_mapping_keys")
            return self.add(node, "mapping_literal", fields=[{"name": name, "value_ref": ref(value)} for name, value in zip(names, node.values)])
        if isinstance(node, (ast.List, ast.Tuple)):
            return self.add(node, "sequence_literal", sequence_type=type(node).__name__, items=[ref(item) for item in node.elts])
        if isinstance(node, (ast.GeneratorExp, ast.ListComp, ast.DictComp)):
            nested = dict(local)
            iterators = []
            for generator in node.generators:
                if generator.is_async or not isinstance(generator.target, ast.Name):
                    return self.add(node, "unresolved", reason="iterator_binding_unresolved")
                iterator = self.resolve(generator.iter, function, parameters, nested, frame, depth + 1)
                element = self.add(generator.target, "iteration_element", iterable_ref=iterator, frame=frame)
                nested[generator.target.id] = element
                iterators.append({"element_ref": element, "condition_refs": [self.resolve(condition, function, parameters, nested, frame, depth + 1) for condition in generator.ifs]})
            if isinstance(node, ast.DictComp):
                return self.add(node, 'dictionary_comprehension', iterators=iterators,
                                key_ref=self.resolve(node.key, function, parameters, nested, frame, depth + 1),
                                value_ref=self.resolve(node.value, function, parameters, nested, frame, depth + 1),
                                duplicate_keys_verified=False, contents_verified=False)
            return self.add(node, "declared_comprehension", iterators=iterators,
                            value_ref=self.resolve(node.elt, function, parameters, nested, frame, depth + 1),
                            deferred=isinstance(node, ast.GeneratorExp), consumed_verified=False)
        if isinstance(node, ast.Call):
            callee = ref(node.func)
            args = [ref(value) for value in node.args]
            keywords = [{"name": item.arg, "value_ref": ref(item.value)} for item in node.keywords]
            callee_node = self.nodes[int(callee.split(':')[1])]
            if isinstance(node.func, ast.Attribute) and node.func.attr == 'get' and len(args) == 1 and not keywords:
                key = self.literal_field(args[0])
                if key is not None:
                    return self.add(node, 'mapping_get', owner_ref=ref(node.func.value), field_name=key,
                                    mapping_protocol='get(key)', missing_key_behavior_verified=False, semantics_verified=False)
            if callee_node['kind'] == 'record_type_syntax':
                names = callee_node['fields']
                supplied = dict(zip(names, args))
                invalid = len(args) > len(names) or any(isinstance(item, ast.Starred) for item in node.args)
                for item in keywords:
                    if item['name'] not in names or item['name'] in supplied:
                        invalid = True
                    supplied[item['name']] = item['value_ref']
                if invalid or set(supplied) != set(names):
                    return self.add(node, 'unresolved', reason='record_constructor_arguments_unresolved', callee_ref=callee)
                return self.add(node, 'record_construction', callee_ref=callee,
                                fields=[{'name': name, 'value_ref': supplied[name]} for name in names], construction_verified=False)
            declared_return = None
            declared_parameter_return = None
            return_paths_explicit = False
            return_guards = []
            # Describe a single explicit return using the same expression graph,
            # including parameter forwarding and directly returned containers.
            # Do not require one incidental local-initializer/getter coding style.
            # Effects, guards and actual return success remain unverified.
            if isinstance(node.func, ast.Name) and node.func.id in self.functions and callee_node['kind'] == 'function_syntax':
                called = self.functions[node.func.id]
                body_nodes = list(self.local_nodes(called))
                returns = [item for item in body_nodes if isinstance(item, ast.Return)]
                # A generator call returns an iterator; its Return value is a
                # StopIteration payload, not the collection delivered to caller.
                generator = any(isinstance(item, (ast.Yield, ast.YieldFrom)) for item in body_nodes)
                return_paths_explicit = _terminates(called.body) and not any(
                    isinstance(item, ast.Try) and item.finalbody for item in body_nodes)
                if not generator and returns and all(item.value is not None for item in returns):
                    bound, reason = _arguments(node, called)
                    if not reason:
                        arguments = self.bind_defaults(called, {name: ref(value) for name, value in (bound or {}).items()})
                        returned_frame = f"{frame}/return:{node.lineno}:{node.col_offset}"
                        if frame in self.frame_paths:
                            self.frame_paths[returned_frame] = [*self.frame_paths[frame], f'{node.lineno}:{node.col_offset}->{called.name}']
                        alternatives = []
                        for returned in returns:
                            # all(value is not None) above excludes bare returns.
                            assert returned.value is not None
                            value = self.resolve(returned.value, called, arguments, {}, returned_frame, depth + 1)
                            conditions = [self.resolve(parent.test, called, arguments, {}, returned_frame, depth + 1)
                                          for parent in self.ancestors(returned)
                                          if isinstance(parent, ast.If) and parent in body_nodes]
                            alternatives.append({'value_ref': value, 'guards': self.guards(returned, called),
                                                 'condition_refs': conditions})
                        if len(alternatives) == 1:
                            declared_return = alternatives[0]['value_ref']
                            return_guards = alternatives[0]['guards']
                        else:
                            declared_return = self.add(node, 'return_alternatives', alternatives=alternatives,
                                explicit_exit_coverage=_terminates(called.body), selection_verified=False)
                        forwarded = _parameter_return(called)
                        if forwarded in arguments:
                            declared_parameter_return = forwarded
            return self.add(node, "call", callee_ref=callee, arguments=args, keywords=keywords,
                            caller_path=self.frame_paths.get(frame),
                            declared_return_ref=declared_return, declared_return_guards=return_guards,
                            declared_parameter_return=declared_parameter_return,
                            return_paths_explicit=return_paths_explicit, result_verified=False)
        if isinstance(node, ast.BoolOp):
            return self.add(node, "boolean_choice", operator=type(node.op).__name__, operands=[ref(value) for value in node.values], selection_verified=False)
        if isinstance(node, ast.IfExp):
            return self.add(node, "conditional_choice", condition_ref=ref(node.test), if_true_ref=ref(node.body), if_false_ref=ref(node.orelse), selection_verified=False)
        if isinstance(node, ast.UnaryOp):
            return self.add(node, 'unary_expression', operator=type(node.op).__name__, operand_ref=ref(node.operand), semantics_verified=False)
        if isinstance(node, ast.BinOp):
            return self.add(node, "binary_expression", operator=type(node.op).__name__, left_ref=ref(node.left), right_ref=ref(node.right), semantics_verified=False)
        if isinstance(node, ast.Compare):
            return self.add(node, "comparison", operators=[type(op).__name__ for op in node.ops], left_ref=ref(node.left), right_refs=[ref(value) for value in node.comparators])
        return self.add(node, "unresolved", reason="expression_not_supported", expression_type=type(node).__name__)


def analyze_python_bind_arguments(source, *, entrypoint: str, companions=()) -> dict[str, Any]:
    trace = analyze_sql_execution(source, entrypoint=entrypoint)
    graph = _Graph(source, sql_uses=trace['uses'], companions=companions)
    uses = []
    try:
        for index, use in enumerate(trace['uses']):
            function = graph.functions[entrypoint]
            parameters = {}
            # Reuse the existing graph memo for identical source invocations,
            # not per SQL-use index. This shares declarations, not runtime values.
            frame = f"entry:{entrypoint}"
            graph.frame_paths[frame] = use['call_path'][:1]
            for hop, step in enumerate(use['call_path'][1:], 1):
                position, name = step.split('->', 1)
                line, column = map(int, position.split(':'))
                call = next(node for node in graph.local_nodes(function) if isinstance(node, ast.Call) and (node.lineno, node.col_offset) == (line, column))
                called = graph.functions[name]
                arguments, reason = _arguments(call, called)
                if reason:
                    raise ValueError('bind_call_arguments_unresolved')
                parameters = graph.bind_defaults(called, {name: graph.resolve(value, function, parameters, {}, frame)
                                                         for name, value in (arguments or {}).items()})
                function = called
                frame = 'call:' + _digest({'path': use['call_path'][:hop + 1], 'parameters': parameters})
                graph.frame_paths[frame] = use['call_path'][:hop + 1]
            call = next(node for node in graph.local_nodes(function) if isinstance(node, ast.Call) and (node.lineno, node.col_offset) == (use['line'], use['column']))
            keywords = [item.value for item in call.keywords if item.arg == 'parameters']
            if len(call.args) == 2 and not keywords and not any(item.arg is None for item in call.keywords):
                value = call.args[1]
            elif len(call.args) == 1 and len(keywords) == 1 and not any(item.arg is None for item in call.keywords):
                value = keywords[0]
            else:
                uses.append({'use_index': index, 'call_path': use['call_path'], 'parameter_ref': None, 'reason': 'parameter_argument_absent_or_unsupported'})
                continue
            uses.append({'use_index': index, 'call_path': use['call_path'], 'parameter_ref': graph.resolve(value, function, parameters, {}, frame), 'binding_verified': False})
    except (ValueError, KeyError, StopIteration, RecursionError):
        graph.findings.append({'reason': 'bind_transport_incomplete'})
    return {'format': 'dataflow-discovery.python-bind-arguments/1', 'path': source.path,
            'file_sha256': source.sha256, 'trace_sha256': _digest(trace), 'entrypoint': entrypoint,
            'uses': uses, 'nodes': graph.nodes, 'findings': graph.findings,
            'source_executed': False, 'python_values_verified': False, 'publication_authorized': False,
            'limitations': ['Declared expressions and append sites, not verified runtime collection contents',
                            'Call results, alias mutation/escape, branches and transformations require further evidence',
                            'Same field names are not upstream lineage; generator body discovery is not execution']}


def _collection_declarations(reference, nodes, terminal_kind='mapping_literal', seen=None, findings=()):
    """Return declarations with their transport uncertainty, never current values.

    A prior declaration remains inspectable after an escape. Keep its findings
    on the whole collection so extracting a field cannot erase that uncertainty.
    """
    visited = set() if seen is None else seen
    findings = tuple(sorted(set(findings)))
    key = (reference, findings)
    if reference is None or key in visited:
        return []
    visited.add(key)
    node = nodes[reference]
    kind = node['kind']
    if kind == terminal_kind:
        return [(node, findings)]
    if kind == 'unresolved' and node.get('initial_declaration_ref'):
        return _collection_declarations(node['initial_declaration_ref'], nodes, terminal_kind, visited,
                                        (*findings, node['reason']))
    if kind in {'assignment', 'parameter', 'declared_comprehension'}:
        return _collection_declarations(node.get('argument_ref') if kind == 'parameter' else node.get('value_ref'), nodes, terminal_kind, visited, findings)
    if kind == 'declared_append_collection':
        references = [item['value_ref'] for item in node['appends']]
    elif kind == 'boolean_choice':
        references = node['operands']
    elif kind == 'conditional_choice':
        references = [node['if_true_ref'], node['if_false_ref']]
    elif kind == 'sequence_literal':
        references = node['items']
    elif kind == 'call':
        if node.get('declared_return_ref'):
            references = [node['declared_return_ref']]
        else:
            callee = nodes[node['callee_ref']]
            references = node['arguments'] if callee['kind'] == 'builtin_syntax' and callee['name'] in {'list', 'tuple'} and len(node['arguments']) == 1 and not node['keywords'] else []
    else:
        references = []
    return [mapping for value in references for mapping in _collection_declarations(value, nodes, terminal_kind, visited, findings)]


def bind_python_parameter_declarations(analysis, snapshot, *, path, entrypoint, scopes_by_context, reader):
    """Link SQL bind slots to declarations transported on that same call path.

    Multiple/conditional declarations are retained, not merged into one runtime
    value. No output alias to target-column edges or publication claims are made.
    """
    result = bind_python_sql_write_parameters(analysis, snapshot, path=path, entrypoint=entrypoint,
                                              scopes_by_context=scopes_by_context, reader=reader)
    source = next(file for file in snapshot.files if file.path == path)
    transport = analyze_python_bind_arguments(source, entrypoint=entrypoint, companions=snapshot.files)
    if transport['trace_sha256'] != result['trace_sha256']:
        raise CatalogBindingError('parameter_transport_trace_mismatch')
    nodes = {node['id']: node for node in transport['nodes']}
    uses = {use['use_index']: use for use in transport['uses']}
    for index, context in enumerate(result['contexts']):
        use = uses.get(index)
        if use is not None and use['call_path'] != context['use']['call_path']:
            raise CatalogBindingError('parameter_transport_context_mismatch')
        reference = use.get('parameter_ref') if use else None
        mappings = _collection_declarations(reference, nodes)
        context['parameter_ref'] = reference
        for statement in context['write_statements']:
            for slot in statement['slots']:
                slot['python_declarations'] = [
                    {'parameter_name': name, 'mapping_ref': mapping['id'], 'value_ref': field['value_ref'],
                     'collection_findings': list(findings)}
                    for name in slot['parameter_names'] for mapping, findings in mappings for field in mapping['fields'] if field['name'] == name]
                names = {item['parameter_name'] for item in slot['python_declarations']}
                slot['parameter_declaration_status'] = 'DECLARATIONS_FOUND' if slot['parameter_names'] and names == set(slot['parameter_names']) else 'UNRESOLVED_OR_NO_PARAMETER'
                if slot['parameter_declaration_status'] == 'DECLARATIONS_FOUND' and all(item['collection_findings'] for item in slot['python_declarations']):
                    slot['parameter_declaration_status'] = 'PRIOR_DECLARATIONS_ONLY'
    result['format'] = 'dataflow-discovery.python-parameter-declarations/1'
    result['transport'] = transport
    result['python_values_verified'] = False
    result['status'] = 'INCONCLUSIVE'
    result['limitations'].extend(['Linked mapping declarations do not prove iteration, branch or final mutable contents',
                                  'Opaque call results and decoder/dataclass field semantics still require evidence'])
    return result
