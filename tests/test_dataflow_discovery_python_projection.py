"""Physical query-value origins through real SQLGlot, no network or source import."""
import json
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest

from datahub.metadata.schema_classes import SchemaMetadataClass
from dataflow_discovery.python_catalog import bind_python_sql_dependencies
from dataflow_discovery.python_projection import bind_python_sql_projections
from tests.test_dataflow_discovery_catalog import Reader, schema, scope, urn
from dataflow_discovery.host import capture_and_analyze


class ProjectionTests(unittest.TestCase):
    def report(self, sql, reader=None, policy=None):
        program = 'def run(engine):\n    with engine.connect() as conn:\n        conn.execute(' + repr(sql) + ')\n'
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / "case.py").write_text(program)
        captured = capture_and_analyze(str(root), ["case.py"], source_id="projection-case")
        snapshot, analysis = captured.snapshot, captured.analysis
        reader = reader or Reader()
        description = bind_python_sql_dependencies(analysis, snapshot, path="case.py", entrypoint="run", scopes_by_context={}, reader=reader)
        scopes = {context["context_id"]: policy or scope() for context in description["contexts"]}
        result = bind_python_sql_projections(analysis, snapshot, path="case.py", entrypoint="run", scopes_by_context=scopes, reader=reader)
        return result, result["contexts"][0]

    def test_alias_and_aggregate_resolve_physical_owner_not_query_alias(self):
        report, context = self.report("SELECT o.OrderID AS identifier, SUM(o.Amount) AS total FROM dbo.Orders o GROUP BY o.OrderID")
        self.assertEqual(context["projection_status"], "DESCRIBED")
        outputs = context["projections"][0]["outputs"]
        self.assertEqual([(o["output_name"], [(s["dataset_urn"], s["field_path"]) for s in o["origins"]]) for o in outputs],
                         [("identifier", [(urn(), "orderid")]), ("total", [(urn(), "amount")])])
        self.assertFalse(report["publication_authorized"])
        self.assertFalse(outputs[1]["transformation_semantics_verified"])

    def test_cte_cast_and_union_reach_their_physical_fields(self):
        _, cte = self.report("WITH q AS (SELECT CAST(Amount AS DECIMAL(20,2)) AS value FROM dbo.Orders) SELECT value AS rounded FROM q")
        self.assertEqual(cte["projection_status"], "DESCRIBED")
        self.assertEqual(cte["projections"][0]["outputs"][0]["origins"][0]["field_path"], "amount")
        _, union = self.report("SELECT OrderID AS value FROM dbo.Orders UNION ALL SELECT Amount AS value FROM dbo.Orders")
        self.assertEqual(union["projection_status"], "DESCRIBED")
        self.assertEqual({s["field_path"] for s in union["projections"][0]["outputs"][0]["origins"]}, {"orderid", "amount"})

    def test_missing_and_ambiguous_columns_are_not_accepted(self):
        for sql in ("SELECT Missing AS value FROM dbo.Orders", "SELECT OrderID FROM dbo.Orders a JOIN dbo.Orders b ON a.OrderID=b.OrderID"):
            with self.subTest(sql=sql):
                _, context = self.report(sql)
                self.assertEqual(context["projection_status"], "UNRESOLVED")
                self.assertEqual(context["projections"], [])

    def test_star_expands_only_catalog_fields_and_duplicate_outputs_reject(self):
        _, context = self.report("SELECT * FROM dbo.Orders")
        self.assertEqual([o["output_name"] for o in context["projections"][0]["outputs"]], ["orderid", "amount"])
        for sql in ("SELECT OrderID AS x, Amount AS x FROM dbo.Orders", "SELECT a.*, b.* FROM dbo.Orders a JOIN dbo.Orders b ON a.OrderID=b.OrderID"):
            with self.subTest(sql=sql):
                _, context = self.report(sql)
                self.assertEqual(context["projection_status"], "UNRESOLVED")
                self.assertEqual(context["projection_reason"], "projection_output_names_ambiguous")

    def test_literal_and_count_star_do_not_invent_physical_columns_or_leak_values(self):
        report, context = self.report("SELECT COUNT(*) AS total, 'PRIVATE_VALUE_NOT_EXPORTED' AS label FROM dbo.Orders")
        outputs = context["projections"][0]["outputs"]
        self.assertTrue(all(output["status"] == "NO_PHYSICAL_COLUMN_ORIGIN" and not output["origins"] for output in outputs))
        self.assertNotIn("PRIVATE_VALUE_NOT_EXPORTED", json.dumps(report))

    def test_two_table_expression_preserves_both_owners(self):
        other = urn(name="dbo.other")
        reader = Reader([urn(), other])
        _, context = self.report("SELECT a.Amount + b.Amount AS total FROM dbo.Orders a JOIN dbo.Other b ON a.OrderID=b.OrderID",
                                 reader, scope(datasets=[urn(), other]))
        origins = context["projections"][0]["outputs"][0]["origins"]
        self.assertEqual({(o["dataset_urn"], o["field_path"]) for o in origins}, {(urn(), "amount"), (other, "amount")})

    def test_quoted_physical_column_uses_actual_catalog_field_path(self):
        reader = Reader()
        reader.aspects[urn(), SchemaMetadataClass] = schema(("Order ID",))
        _, context = self.report('SELECT o.[Order ID] AS id FROM dbo.Orders o', reader)
        self.assertEqual(context["projection_status"], "DESCRIBED")
        self.assertEqual(context["projections"][0]["outputs"][0]["origins"][0]["field_path"], "Order ID")

    def test_case_sensitive_policy_write_and_unbound_context_not_promoted(self):
        _, sensitive = self.report("SELECT OrderID FROM dbo.Orders", policy=replace(scope(), lowercase_fields=False))
        self.assertEqual(sensitive["projection_reason"], "projection_case_policy_unsupported")
        _, write = self.report("UPDATE dbo.Orders SET Amount = 0")
        self.assertEqual(write["projection_status"], "PARTIAL")
        self.assertEqual(write["projections"][0]["status"], "NOT_QUERY_PROJECTION")
        _, missing = self.report("SELECT * FROM dbo.Other")
        self.assertEqual(missing["projection_status"], "CATALOG_CONTEXT_UNRESOLVED")


if __name__ == "__main__":
    unittest.main()
