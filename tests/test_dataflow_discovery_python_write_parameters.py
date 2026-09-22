"""Bind-slot syntax is not upstream lineage, values, generated keys or execution."""
import json
from pathlib import Path
import tempfile
import unittest

from datahub.metadata.schema_classes import SchemaMetadataClass
from dataflow_discovery.host import capture_and_analyze
from dataflow_discovery.python_catalog import bind_python_sql_dependencies
from dataflow_discovery.python_write_parameters import bind_python_sql_write_parameters
from tests.test_dataflow_discovery_catalog import Reader, schema, scope, urn


class WriteParameterTests(unittest.TestCase):
    def report(self, sql, reader=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / "case.py").write_text('def run(engine):\n    with engine.begin() as conn:\n        conn.execute(' + repr(sql) + ')\n')
        captured = capture_and_analyze(str(root), ["case.py"], source_id="write-case")
        reader = reader or Reader()
        described = bind_python_sql_dependencies(captured.analysis, captured.snapshot, path="case.py", entrypoint="run", scopes_by_context={}, reader=reader)
        scopes = {context["context_id"]: scope() for context in described["contexts"]}
        result = bind_python_sql_write_parameters(captured.analysis, captured.snapshot, path="case.py", entrypoint="run", scopes_by_context=scopes, reader=reader)
        return result, result["contexts"][0]

    def test_explicit_insert_positions_and_omitted_column_are_not_guessed(self):
        reader = Reader()
        reader.aspects[urn(), SchemaMetadataClass] = schema(("generated_key", "orderid", "amount"))
        result, context = self.report("INSERT INTO dbo.Orders (Amount, OrderID) VALUES (:price, :identifier)", reader)
        write = context["write_statements"][0]
        self.assertEqual(context["write_status"], "DESCRIBED")
        self.assertEqual([(slot["position"], slot["field_path"], slot["parameter_names"]) for slot in write["slots"]], [(0, "amount", ["price"]), (1, "orderid", ["identifier"])])
        self.assertEqual(write["unassigned_catalog_fields"], ["generated_key"])
        self.assertFalse(result["publication_authorized"])
        self.assertTrue(all(not slot["parameter_values_verified"] for slot in write["slots"]))

    def test_update_predicate_is_not_an_assignment(self):
        _, context = self.report("UPDATE dbo.Orders SET Amount=:price WHERE OrderID=:lookup")
        write = context["write_statements"][0]
        self.assertEqual(write["predicate_parameter_names"], ["lookup"])
        self.assertEqual([(s["field_path"], s["parameter_names"]) for s in write["slots"]], [("amount", ["price"])])
        self.assertEqual(write["unassigned_catalog_fields"], ["orderid"])

    def test_insert_select_keeps_value_slots_separate_from_not_exists(self):
        _, context = self.report("INSERT INTO dbo.Orders (OrderID, Amount) SELECT :id, :price WHERE NOT EXISTS (SELECT 1 FROM dbo.Orders WHERE OrderID=:lookup)")
        write = context["write_statements"][0]
        self.assertEqual([s["parameter_names"] for s in write["slots"]], [["id"], ["price"]])
        self.assertEqual(write["predicate_parameter_names"], ["lookup"])

    def test_multiple_value_rows_default_and_literal_do_not_leak_or_collapse(self):
        result, context = self.report("INSERT INTO dbo.Orders (OrderID, Amount) VALUES (:id, :v), ('PRIVATE_VALUE_NOT_EXPORTED', DEFAULT)")
        slots = context["write_statements"][0]["slots"]
        self.assertEqual([(s["row_index"], s["position"]) for s in slots], [(0, 0), (0, 1), (1, 0), (1, 1)])
        self.assertEqual([s["value_kind"] for s in slots], ["DIRECT_PARAMETER", "DIRECT_PARAMETER", "NO_BIND_PARAMETER", "DEFAULT_VALUE"])
        self.assertNotIn("PRIVATE_VALUE_NOT_EXPORTED", json.dumps(result))

    def test_expression_dependencies_are_not_direct_copy_or_lossless_claims(self):
        _, context = self.report("UPDATE dbo.Orders SET Amount=CAST(:price AS DECIMAL(19,4)) + Amount + :delta WHERE OrderID=:id")
        slot = context["write_statements"][0]["slots"][0]
        self.assertEqual(slot["value_kind"], "EXPRESSION")
        self.assertEqual(slot["parameter_names"], ["delta", "price"])
        self.assertEqual(slot["target_read_fields"], ["amount"])
        self.assertFalse(slot["transformation_semantics_verified"])

    def test_implicit_duplicate_missing_and_mismatched_columns_fail_closed(self):
        for sql in ("INSERT INTO dbo.Orders VALUES (:id,:v)",
                    "INSERT INTO dbo.Orders (OrderID,Amount) VALUES (:id)",
                    "INSERT INTO dbo.Orders (OrderID,OrderID) VALUES (:id,:other)",
                    "INSERT INTO dbo.Orders (Missing) VALUES (:x)",
                    "UPDATE dbo.Orders SET Missing=:x",
                    "UPDATE dbo.Orders SET Amount=:x, Amount=:y"):
            with self.subTest(sql=sql):
                result, context = self.report(sql)
                self.assertEqual(context["write_status"], "UNRESOLVED")
                self.assertEqual(context["write_statements"], [])
                self.assertEqual(result["status"], "INCONCLUSIVE")

    def test_sql_variables_unnamed_parameters_queries_and_foreign_columns_stay_unresolved(self):
        for sql in ("UPDATE dbo.Orders SET Amount=@value", "UPDATE dbo.Orders SET Amount=?",
                    "INSERT INTO dbo.Orders (Amount) SELECT Amount FROM dbo.Orders",
                    "UPDATE dbo.Orders SET Amount=(SELECT MAX(Amount) FROM dbo.Orders)",
                    "UPDATE dbo.Orders SET Amount=other.Amount+:x"):
            with self.subTest(sql=sql):
                _, context = self.report(sql)
                self.assertIn(context["write_status"], {"UNRESOLVED", "CATALOG_CONTEXT_UNRESOLVED"})
                self.assertEqual(context["write_statements"], [])

    def test_reused_parameter_has_two_slots_but_select_is_not_a_write(self):
        _, context = self.report("INSERT INTO dbo.Orders (OrderID,Amount) VALUES (:value,:value)")
        slots = context["write_statements"][0]["slots"]
        self.assertEqual(len(slots), 2)
        self.assertTrue(all(s["parameter_names"] == ["value"] for s in slots))
        _, query = self.report("SELECT OrderID FROM dbo.Orders")
        self.assertEqual(query["write_status"], "PARTIAL")
        self.assertEqual(query["write_statements"][0]["status"], "NOT_SUPPORTED_WRITE_STATEMENT")


if __name__ == "__main__":
    unittest.main()
