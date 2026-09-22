"""Bounded control-batch compatibility with pinned SQLGlot 30.12.0.

The compiled distribution does not support Python Parser subclasses. Use its
public tokenizer, expression parser and AST instead. Normalize only a complete
control-only batch containing EXEC return-status / IF THROW syntax missing in
that release. All ordinary SQL follows the unchanged T-SQL parser. This is not
an error fallback, SQL execution permission, or a token-to-dataset heuristic.
"""
from __future__ import annotations

import sqlglot
from sqlglot import exp
from sqlglot.dialects.tsql import TSQL
from sqlglot.errors import ParseError
from sqlglot.tokenizer_core import TokenType


def _scalar(node):
    if isinstance(node, (exp.Literal, exp.Null, exp.Boolean)):
        return True
    if isinstance(node, exp.Placeholder):
        return isinstance(node.this, str) and bool(node.this)
    if isinstance(node, exp.Parameter):
        return isinstance(node.this, (exp.Var, exp.Identifier))
    if isinstance(node, (exp.Neg, exp.Paren)):
        return _scalar(node.this)
    if isinstance(node, (exp.EQ, exp.NEQ, exp.LT, exp.LTE, exp.GT, exp.GTE,
                         exp.And, exp.Or, exp.Add, exp.Sub, exp.Mul, exp.Div)):
        return _scalar(node.this) and _scalar(node.expression)
    return False


def control_statement_kind(statement):
    """An opaque procedure is never assumed to have zero dataset effects."""
    if isinstance(statement, exp.Set) and len(statement.expressions) == 1:
        item = statement.expressions[0]
        value = item.this
        if (isinstance(item, exp.SetItem) and isinstance(value, exp.EQ)
                and isinstance(value.this, exp.Column)
                and not any((value.this.table, value.this.db, value.this.catalog))):
            name = value.this.name.upper()
            if (name in {'NOCOUNT', 'XACT_ABORT'} and isinstance(value.expression, exp.Var)
                    and value.expression.name.upper() in {'ON', 'OFF'}):
                return 'CONTROL_' + name
            timeout = value.expression.this if isinstance(value.expression, exp.Neg) else value.expression
            if (name == 'LOCK_TIMEOUT' and isinstance(timeout, exp.Literal)
                    and not timeout.is_string and str(timeout.this).isdecimal()):
                return 'CONTROL_LOCK_TIMEOUT'
    if isinstance(statement, exp.Declare) and statement.expressions:
        if all(isinstance(item, exp.DeclareItem) and isinstance(item.this, list) and item.this
               and all(isinstance(variable, exp.Parameter) and _scalar(variable) for variable in item.this)
               and isinstance(item.args.get("kind"), exp.DataType)
               and item.args["kind"].this in {exp.DType.INT, exp.DType.BIGINT, exp.DType.SMALLINT}
               # pi-lens-ignore: ast-grep:no-identity-operator-on-literals -- False is SQLGlot's absent-default singleton, not numeric zero.
               and (item.args.get("default") is None or item.args.get("default") is False
                    or _scalar(item.args["default"]))
               for item in statement.expressions):
            return "CONTROL_DECLARE"
    if isinstance(statement, exp.Execute) and isinstance(statement.this, exp.Table):
        parts = [part.name.lower() for part in statement.this.parts]
        if parts in (["sys", "sp_getapplock"], ["sys", "sp_releaseapplock"]):
            if statement.expressions and all(
                    isinstance(arg, exp.EQ) and isinstance(arg.this, exp.Parameter)
                    and _scalar(arg.this) and _scalar(arg.expression)
                    for arg in statement.expressions):
                return "CONTROL_APPLICATION_LOCK"
    if (isinstance(statement, exp.Command) and statement.this == "THROW"
            and isinstance(statement.expression, exp.Tuple)
            and len(statement.expression.expressions) == 3
            and all(_scalar(arg) for arg in statement.expression.expressions)):
        return "CONTROL_THROW"
    if (isinstance(statement, exp.IfBlock) and _scalar(statement.this)
            and statement.args.get("false") is None
            and control_statement_kind(statement.args.get("true")) == "CONTROL_THROW"):
        return "CONTROL_CONDITIONAL"
    return None


def _chunks(tokens, separator):
    result, current = [], []
    for token in tokens:
        if token.token_type == separator:
            if current:
                result.append(current)
            elif separator != TokenType.SEMICOLON:
                raise ParseError("Empty control operand")
            current = []
        else:
            current.append(token)
    if current:
        result.append(current)
    elif tokens and separator != TokenType.SEMICOLON:
        raise ParseError("Trailing control operand separator")
    return result


def _condition(tokens, text):
    # Original tokens retain source positions, quoting, comments and literals.
    parsed = TSQL().parser().parse_into(exp.Condition, tokens, text)
    if len(parsed) != 1 or not _scalar(parsed[0]):
        raise ParseError("Unsupported control operand")
    return parsed[0]


def parse_sql(text: str):
    tokens = TSQL().tokenize(text)
    chunks = _chunks(tokens, TokenType.SEMICOLON) if tokens else []
    normalizing = any(
        chunk[0].token_type == TokenType.EXECUTE and len(chunk) > 3
        and chunk[1].token_type == TokenType.PARAMETER
        or (chunk[0].token_type == TokenType.VAR and chunk[0].text.upper() == "IF"
            and any(token.token_type == TokenType.VAR and token.text.upper() == "THROW"
                    for token in chunk[1:]))
        for chunk in chunks)
    if not normalizing:
        return sqlglot.parse(text, read="tsql")
    statements = []
    for chunk in chunks:
        if (chunk[0].token_type == TokenType.EXECUTE and len(chunk) > 1
                and chunk[1].token_type == TokenType.PARAMETER):
            if (len(chunk) < 5 or chunk[2].token_type != TokenType.VAR
                    or chunk[3].token_type != TokenType.EQ):
                raise ParseError("Unsupported EXEC return status")
            parsed = TSQL().parser().parse([chunk[0], *chunk[4:]], text)
            if len(parsed) != 1 or not isinstance(parsed[0], exp.Execute):
                raise ParseError("Unsupported control procedure")
            statement = parsed[0]
            statement.meta["discovery_return_status"] = chunk[2].text
        elif chunk[0].token_type == TokenType.VAR and chunk[0].text.upper() == "IF":
            markers = [i for i, token in enumerate(chunk)
                       if token.token_type == TokenType.VAR and token.text.upper() == "THROW"
                       and i > 1 and chunk[i - 1].token_type not in {TokenType.PARAMETER, TokenType.DOT}]
            if len(markers) != 1:
                raise ParseError("Only IF predicate THROW control syntax is supported")
            index = markers[0]
            predicate = _condition(chunk[1:index], text)
            arguments = [_condition(part, text) for part in _chunks(chunk[index + 1:], TokenType.COMMA)]
            statement = exp.IfBlock(this=predicate, true=exp.Command(this="THROW", expression=exp.Tuple(expressions=arguments)))
        else:
            parsed = TSQL().parser().parse(chunk, text)
            if len(parsed) != 1:
                raise ParseError("Unsupported control statement")
            statement = parsed[0]
        # No mixed data/control rewrite: unknown statements, procedures, column
        # operands, nested queries, dynamic EXEC and non-THROW branches fail.
        if control_statement_kind(statement) is None:
            raise ParseError("Unsupported control batch")
        statements.append(statement)
    return statements
