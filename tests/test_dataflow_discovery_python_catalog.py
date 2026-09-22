"""Per-call Catalog binding, with actual AST/SDK and a read-only fake Catalog."""
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest

from datahub.metadata.schema_classes import SchemaMetadataClass
from dataflow_discovery.catalog import CatalogBindingError, bind_sql_dependencies
from dataflow_discovery.host import capture_and_analyze
from dataflow_discovery.python_catalog import bind_python_sql_dependencies
from tests.test_dataflow_discovery_catalog import Reader, schema, scope, urn

PROGRAM = '''from sqlalchemy import text
SQL = text("SELECT OrderID FROM dbo.Orders")
def fetch(conn, statement):
    conn.execute(statement)
def run(left, right):
    with left.connect() as conn:
        fetch(conn, SQL)
    with right.begin() as conn:
        fetch(conn, SQL)
'''


class PythonCatalogTests(unittest.TestCase):
    def capture(self, text=PROGRAM, source_id="case", extra=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / "case.py").write_text(text)
        paths = ["case.py"]
        if extra is not None:
            (root / "config.py").write_text(extra)
            paths.append("config.py")
        receipt = capture_and_analyze(str(root), paths, source_id=source_id)
        return receipt.snapshot, receipt.analysis, receipt.revision

    def bind(self, snapshot, analysis, scopes=None, reader=None, entrypoint="run"):
        return bind_python_sql_dependencies(analysis, snapshot, path="case.py", entrypoint=entrypoint,
                                            scopes_by_context=scopes or {}, reader=reader or Reader())

    def test_same_process_two_connections_cannot_be_represented_by_legacy_map(self):
        snapshot, analysis, _ = self.capture()
        described = self.bind(snapshot, analysis)
        contexts = described["contexts"]
        self.assertEqual(len(contexts), 2)
        self.assertEqual(contexts[0]["processes"], contexts[1]["processes"])
        self.assertNotEqual(contexts[0]["context_id"], contexts[1]["context_id"])
        self.assertNotEqual(contexts[0]["use"]["call_path"], contexts[1]["use"]["call_path"])
        reader = Reader([urn("left"), urn("right")])
        process = contexts[0]["processes"][0]
        legacy_scopes = {process: scope("Left")}
        legacy_scopes[process] = scope("Right")  # Demonstrated lossy responsibility boundary.
        legacy = bind_sql_dependencies(analysis, snapshot, scopes_by_process=legacy_scopes, reader=reader)
        self.assertEqual([item["dataset"]["urn"] for item in legacy["bindings"]], [urn("right")])
        reader.calls.clear()
        scoped = {contexts[0]["context_id"]: scope("Left"), contexts[1]["context_id"]: scope("Right")}
        result = self.bind(snapshot, analysis, scoped, reader)
        self.assertEqual([item["bindings"][0]["dataset"]["urn"] for item in result["contexts"]], [urn("left"), urn("right")])
        self.assertEqual(len(reader.calls), 6)
        self.assertEqual(result["status"], "CATALOG_BOUND")
        self.assertFalse(result["runtime_identity_verified"])
        self.assertFalse(result["publication_authorized"])

    def test_description_and_missing_scope_never_search_or_guess_catalog(self):
        snapshot, analysis, _ = self.capture()
        reader = Reader()
        result = self.bind(snapshot, analysis, reader=reader)
        self.assertEqual(reader.calls, [])
        self.assertTrue(all(item["reason"] == "connection_scope_unresolved" for item in result["contexts"]))
        first = result["contexts"][0]["context_id"]
        partial = self.bind(snapshot, analysis, {first: scope()}, reader)
        self.assertEqual(partial["status"], "INCONCLUSIVE")
        self.assertEqual(partial["contexts"][1]["reason"], "connection_scope_unresolved")
        self.assertEqual(len(reader.calls), 3)

    def test_unknown_or_stale_context_and_forged_analysis_reject_before_io(self):
        snapshot, analysis, _ = self.capture()
        ids = self.bind(snapshot, analysis)["contexts"]
        reader = Reader()
        with self.assertRaisesRegex(CatalogBindingError, "invalid_host_sql_context_scope"):
            self.bind(snapshot, analysis, {"made-up": scope()}, reader)
        modified, fresh, _ = self.capture(PROGRAM.replace("left.connect()", "left.begin()"))
        with self.assertRaisesRegex(CatalogBindingError, "invalid_host_sql_context_scope"):
            self.bind(modified, fresh, {ids[0]["context_id"]: scope()}, reader)
        with self.assertRaisesRegex(CatalogBindingError, "catalog_analysis_not_source_bound"):
            self.bind(snapshot, replace(analysis, digest="0" * 64), reader=reader)
        self.assertEqual(reader.calls, [])

    def test_context_scope_cannot_cross_source_or_other_snapshot_file_changes(self):
        original, analysis, _ = self.capture(extra='DB = "One"\n')
        context_id = self.bind(original, analysis)["contexts"][0]["context_id"]
        reader = Reader()
        for options in ({"source_id": "other-source", "extra": 'DB = "One"\n'}, {"extra": 'DB = "Two"\n'}):
            changed, fresh, _ = self.capture(**options)
            with self.subTest(options=options), self.assertRaisesRegex(CatalogBindingError, "invalid_host_sql_context_scope"):
                self.bind(changed, fresh, {context_id: scope()}, reader)
        self.assertEqual(reader.calls, [])

    def test_same_line_literal_collision_is_not_joined_by_legacy_process_label(self):
        text = '''def run(engine):
    with engine.connect() as conn:
        conn.execute("SELECT * FROM dbo.Orders"); conn.execute("SELECT * FROM dbo.Other")
'''
        snapshot, analysis, _ = self.capture(text)
        contexts = self.bind(snapshot, analysis)["contexts"]
        reader = Reader()
        result = self.bind(snapshot, analysis, {item["context_id"]: scope() for item in contexts}, reader)
        self.assertEqual(len(contexts), 2)
        self.assertTrue(all(item["reason"] == "ambiguous_python_sql_line" for item in result["contexts"]))
        self.assertEqual(reader.calls, [])

    def test_multiple_statements_keep_their_processes_in_each_context(self):
        snapshot, analysis, _ = self.capture(PROGRAM.replace("SELECT OrderID FROM dbo.Orders", "SELECT OrderID FROM dbo.Orders; SELECT amount FROM dbo.Orders"))
        contexts = self.bind(snapshot, analysis)["contexts"]
        reader = Reader()
        result = self.bind(snapshot, analysis, {item["context_id"]: scope() for item in contexts}, reader)
        self.assertTrue(all(len(item["processes"]) == 2 and len(item["bindings"]) == 2 for item in result["contexts"]))
        self.assertEqual(len(reader.calls), 3)  # Cache is scoped, but only within this call.
        reader.aspects[urn(), SchemaMetadataClass] = schema(("new_column",))
        fresh = self.bind(snapshot, analysis, {item["context_id"]: scope() for item in contexts}, reader)
        self.assertEqual(len(reader.calls), 6)
        self.assertNotEqual(result["contexts"][0]["bindings"][0]["dataset"]["schema_sha256"], fresh["contexts"][0]["bindings"][0]["dataset"]["schema_sha256"])

    def test_unsupported_statement_cannot_hide_behind_one_supported_statement(self):
        snapshot, analysis, _ = self.capture(PROGRAM.replace("SELECT OrderID FROM dbo.Orders", "SELECT * FROM dbo.Orders; EXEC dbo.proc"))
        contexts = self.bind(snapshot, analysis)["contexts"]
        reader = Reader()
        result = self.bind(snapshot, analysis, {item["context_id"]: scope() for item in contexts}, reader)
        self.assertTrue(all(item["reason"] == "sql_structure_unresolved" for item in result["contexts"]))
        self.assertEqual(reader.calls, [])

    def test_dynamic_sql_and_dead_connection_remain_unresolved_even_with_scope(self):
        text = '''def run(engine, statement):
    with engine.connect() as conn:
        conn.execute(statement)
    conn.execute("SELECT * FROM dbo.Orders")
'''
        snapshot, analysis, _ = self.capture(text)
        contexts = self.bind(snapshot, analysis)["contexts"]
        reader = Reader()
        result = self.bind(snapshot, analysis, {item["context_id"]: scope() for item in contexts}, reader)
        self.assertTrue(all(item["reason"] == "sql_execution_binding_unresolved" for item in result["contexts"]))
        self.assertEqual(reader.calls, [])

    def test_dataset_outside_one_context_scope_does_not_borrow_another_scope(self):
        snapshot, analysis, _ = self.capture(PROGRAM.replace("dbo.Orders", "Left.dbo.Orders"))
        contexts = self.bind(snapshot, analysis)["contexts"]
        reader = Reader([urn("left"), urn("right")])
        result = self.bind(snapshot, analysis, {contexts[0]["context_id"]: scope("Left"), contexts[1]["context_id"]: scope("Right")}, reader)
        self.assertEqual(result["contexts"][0]["status"], "CATALOG_BOUND")
        self.assertEqual(result["contexts"][1]["bindings"][0]["reason"], "database_outside_host_scope")
        self.assertEqual(len(reader.calls), 3)

    def test_trace_gaps_and_empty_trace_do_not_claim_complete_catalog_binding(self):
        # A reached deferred helper is a gap, unlike merely uncalled code.
        text = PROGRAM.replace("        fetch(conn, SQL)", "        fetch(conn, SQL)\n        deferred(conn)") + "def deferred(conn):\n    yield conn.execute(SQL)\n"
        snapshot, analysis, _ = self.capture(text)
        contexts = self.bind(snapshot, analysis)["contexts"]
        result = self.bind(snapshot, analysis, {item["context_id"]: scope() for item in contexts})
        self.assertTrue(result["trace_findings"])
        self.assertEqual(result["status"], "INCONCLUSIVE")
        empty, empty_analysis, _ = self.capture("def run():\n    pass\n")
        self.assertEqual(self.bind(empty, empty_analysis)["status"], "INCONCLUSIVE")


if __name__ == "__main__":
    unittest.main()
