"""Symbolic connection/SQL propagation, not actual SQL execution acceptance."""
import ast
import hashlib
import json
from pathlib import Path
import unittest

from dataflow_discovery.python_sql import analyze_sql_execution
from dataflow_discovery.snapshot import SourceFile

HEADER = "from sqlalchemy import create_engine, text\nfrom sqlalchemy.engine import URL\nfrom config_api import source, target\nA = text('SELECT id FROM sales.orders')\nB = text('SELECT id FROM dm.orders')\ndef engine(config):\n    return create_engine(URL.create('mssql', database=config.database))\ndef fetch(conn, sql, params=None):\n    return conn.execute(sql, params)\n"


def analyze(text, entrypoint="run"):
    data = text.encode()
    return analyze_sql_execution(SourceFile("pipeline.py", text, hashlib.sha256(data).hexdigest(), len(data)), entrypoint=entrypoint)


class SqlTraceTests(unittest.TestCase):
    def test_same_wrapper_keeps_two_distinct_connection_origins(self):
        result = analyze(HEADER + "def run(override=None):\n    left = override or engine(source())\n    right = engine(target())\n    with left.connect() as one:\n        fetch(one, A)\n    with right.begin() as two:\n        fetch(two, B)\n")
        self.assertEqual(len(result["uses"]), 2)
        self.assertTrue(all(use["binding_status"] == "SYNTAX_BOUND" for use in result["uses"]))
        self.assertNotEqual(result["uses"][0]["connection"]["engine_origin"], result["uses"][1]["connection"]["engine_origin"])
        self.assertEqual([use["connection"]["method"] for use in result["uses"]], ["connect", "begin"])
        self.assertNotIn("SELECT id", json.dumps(result))
        self.assertFalse(result["publication_authorized"])

    def test_multiple_wrapper_layers_and_keyword_arguments(self):
        result = analyze(HEADER + "def layer(resource, query):\n    fetch(sql=query, conn=resource)\ndef run():\n    db = engine(source())\n    with db.connect() as conn:\n        alias = layer\n        alias(conn, A)\n")
        self.assertEqual(len(result["uses"]), 1)
        self.assertEqual(result["uses"][0]["binding_status"], "SYNTAX_BOUND")
        self.assertEqual(len(result["uses"][0]["call_path"]), 3)

    def test_branch_merge_does_not_reuse_an_arbitrary_connection(self):
        result = analyze(HEADER + "def run(flag, unknown):\n    db = engine(source())\n    with db.connect() as conn:\n        if flag:\n            selected = conn\n        else:\n            selected = unknown\n        fetch(selected, A)\n")
        self.assertEqual(result["uses"][0]["binding_status"], "UNRESOLVED")
        self.assertIsNone(result["uses"][0]["connection"])

    def test_guard_and_context_lifetime_preserved(self):
        result = analyze(HEADER + "def run(flag):\n    db = engine(source())\n    with db.connect() as conn:\n        if flag:\n            fetch(conn, A)\n        saved = conn\n    fetch(saved, B)\n")
        self.assertEqual(len(result["uses"]), 2)
        self.assertTrue(any(guard.get("branch") is True for guard in result["uses"][0]["guards"]))
        self.assertEqual(result["uses"][1]["binding_status"], "UNRESOLVED")

    def test_connection_begin_transaction_is_not_another_connection(self):
        result = analyze(HEADER + "def run():\n    db = engine(source())\n    with db.connect() as conn:\n        with conn.begin() as transaction:\n            fetch(transaction, A)\n            fetch(conn, B)\n")
        self.assertEqual([use["binding_status"] for use in result["uses"]], ["UNRESOLVED", "SYNTAX_BOUND"])

    def test_shadowing_and_dynamic_statement_not_invented(self):
        result = analyze(HEADER + "def run(statement):\n    db = engine(source())\n    with db.connect() as conn:\n        fetch(conn, statement)\n")
        self.assertEqual(result["uses"][0]["binding_status"], "UNRESOLVED")
        self.assertIsNone(result["uses"][0]["sql"])
        result = analyze(HEADER + "def run(fetch):\n    db = engine(source())\n    with db.connect() as conn:\n        fetch(conn, A)\n")
        self.assertEqual(result["uses"], [])

    def test_comprehension_iteration_traced_but_deferred_body_not_executed(self):
        result = analyze(HEADER + "def run():\n    db = engine(source())\n    with db.connect() as conn:\n        rows = {row: row for row in fetch(conn, A)}\n        unused = (fetch(conn, B) for item in [])\n")
        self.assertEqual(len(result["uses"]), 1)
        self.assertIn("deferred_generator_body_not_traced", [item["reason"] for item in result["unresolved"]])

    def test_unconditional_return_inside_with_does_not_trace_dead_tail(self):
        result = analyze(HEADER + "def run():\n    db = engine(source())\n    with db.connect() as conn:\n        fetch(conn, A)\n        return\n    fetch(conn, B)\n")
        self.assertEqual(len(result["uses"]), 1)

    def test_receiver_expression_is_not_visited_twice(self):
        result = analyze(HEADER + "def prepare(conn):\n    fetch(conn, A)\n    return conn\ndef run():\n    db = engine(source())\n    with db.connect() as conn:\n        prepare(conn).execute(B)\n")
        self.assertEqual(len(result["uses"]), 2)
        self.assertEqual([use["binding_status"] for use in result["uses"]], ["SYNTAX_BOUND", "UNRESOLVED"])

    def test_recursive_helpers_stop_and_report_gap(self):
        result = analyze(HEADER + "def again(conn):\n    fetch(conn, A)\n    again(conn)\ndef run():\n    db = engine(source())\n    with db.connect() as conn:\n        again(conn)\n")
        self.assertEqual(len(result["uses"]), 1)
        self.assertIn("recursive_or_deep_call_not_traced", [item["reason"] for item in result["unresolved"]])

    def test_same_sql_literal_is_not_collapsed_across_two_connections(self):
        result = analyze(HEADER + "def run():\n    left = engine(source())\n    right = engine(target())\n    with left.connect() as one:\n        fetch(one, A)\n    with right.connect() as two:\n        fetch(two, A)\n")
        self.assertEqual(len(result["uses"]), 2)
        self.assertEqual(result["uses"][0]["sql"], result["uses"][1]["sql"])
        self.assertNotEqual(result["uses"][0]["connection"], result["uses"][1]["connection"])

    def test_try_finally_return_and_exception_state_are_not_optimistic(self):
        result = analyze(HEADER + "def run():\n    db = engine(source())\n    with db.connect() as conn:\n        try:\n            fetch(conn, A)\n            return\n        finally:\n            fetch(conn, B)\n        fetch(conn, A)\n")
        self.assertEqual(len(result["uses"]), 2)
        self.assertTrue(any(guard["kind"] == "finally" for guard in result["uses"][1]["guards"]))
        result = analyze(HEADER + "def run():\n    db = engine(source())\n    with db.connect() as conn:\n        try:\n            conn = opaque()\n        except Exception:\n            fetch(conn, A)\n")
        self.assertEqual(result["uses"][0]["binding_status"], "UNRESOLVED")

    def test_comprehension_shadowing_does_not_escape_into_outer_connection(self):
        result = analyze(HEADER + "def run():\n    db = engine(source())\n    with db.connect() as conn:\n        rows = [fetch(conn, B) for conn in fetch(conn, A)]\n        fetch(conn, B)\n")
        self.assertEqual([use["binding_status"] for use in result["uses"]], ["SYNTAX_BOUND", "UNRESOLVED", "SYNTAX_BOUND"])

    def test_expansion_budget_reports_partial_evidence(self):
        body = "def run():\n    db = engine(source())\n    with db.connect() as conn:\n" + "        fetch(conn, A)\n" * 520
        result = analyze(HEADER + body)
        self.assertLessEqual(len(result["uses"]), 512)
        self.assertIn("sql_trace_limit", [item["reason"] for item in result["unresolved"]])
        self.assertFalse(result["runtime_identity_verified"])

    def test_decorated_helper_gap_visible_through_an_intermediate_wrapper(self):
        source = HEADER + "@unknown\ndef decorated(conn):\n    conn.execute(A)\ndef middle(conn):\n    decorated(conn)\ndef run():\n    db = engine(source())\n    with db.connect() as conn:\n        middle(conn)\n"
        result = analyze(source)
        self.assertEqual(result["uses"], [])
        self.assertIn("helper_callable_unresolved", [item["reason"] for item in result["unresolved"]])

    def test_real_source_named_statements_follow_source_or_target_selection(self):
        path = Path(__file__).resolve().parents[1] / "extensions/sales-datamart/src/sales_datamart/etl.py"
        text = path.read_text()
        result = analyze(text, "run_etl")
        definitions = {node.targets[0].id: node.value.args[0].lineno for node in ast.parse(text).body
                       if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                       and isinstance(node.value, ast.Call) and node.value.args and isinstance(node.value.args[0], ast.Constant)
                       and isinstance(node.value.args[0].value, str)}
        origins = {item["id"]: item["name"] for item in result["factory_calls"]["assignments"]}
        bound = {use["sql"]["line"]: origins[use["connection"]["engine_origin"]["assignment_id"]]
                 for use in result["uses"] if use["binding_status"] == "SYNTAX_BOUND"}
        source_names = ["_PRODUCT_SQL", "_CUSTOMER_SQL", "_TERRITORY_SQL", "_FACT_SQL"]
        target_names = ["_INSERT_DATE_SQL", "_UPDATE_TERRITORY_SQL", "_INSERT_TERRITORY_SQL", "_UPDATE_PRODUCT_SQL", "_INSERT_PRODUCT_SQL", "_UPDATE_CUSTOMER_SQL", "_INSERT_CUSTOMER_SQL", "_UPDATE_FACT_SQL", "_INSERT_FACT_SQL", "_TARGET_METRICS_SQL", "_VIEW_COUNT_SQL"]
        for name in source_names:
            self.assertEqual(bound[definitions[name]], "source", name)
        for name in target_names:
            self.assertEqual(bound[definitions[name]], "target", name)
        self.assertTrue(all(use["execution_verified"] is False for use in result["uses"]))
        self.assertFalse(result["runtime_identity_verified"])


if __name__ == "__main__":
    unittest.main()
