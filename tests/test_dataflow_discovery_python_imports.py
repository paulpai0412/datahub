"""Import syntax/provenance tests; no captured source is imported or executed."""
import hashlib
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest

from dataflow_discovery.python_imports import resolve_python_imports
from dataflow_discovery.snapshot import SourceFile


def source(text):
    data = text.encode("utf-8")
    return SourceFile("pipeline.py", text, hashlib.sha256(data).hexdigest(), len(data))


class PythonImportTests(unittest.TestCase):
    def test_direct_and_attribute_aliases_keep_provenance(self):
        r = resolve_python_imports(source("import sqlalchemy.engine\nimport sqlalchemy as sa\nfrom sqlalchemy import text as sql\nfactory = sa.create_engine\n"))
        self.assertEqual(r.bindings["sqlalchemy"].qualified_name, "sqlalchemy")
        self.assertEqual(r.bindings["sql"].qualified_name, "sqlalchemy.text")
        self.assertEqual(r.bindings["factory"].qualified_name, "sqlalchemy.create_engine")
        self.assertEqual(r.bindings["factory"].lines, (2, 4))
        self.assertFalse(r.to_dict()["runtime_identity_verified"])
        self.assertFalse(r.to_dict()["publication_authorized"])

    def test_literal_importlib_alias_is_syntax_not_execution(self):
        r = resolve_python_imports(source("from importlib import import_module as load\nmod = load('sqlalchemy.engine')\nurl = mod.URL\n"))
        self.assertEqual(r.bindings["url"].qualified_name, "sqlalchemy.engine.URL")
        self.assertEqual(r.bindings["url"].lines, (1, 2, 3))
        with tempfile.TemporaryDirectory() as directory:
            sentinel = Path(directory) / "must-not-exist"
            resolve_python_imports(source(f"from pathlib import Path\nPath({str(sentinel)!r}).write_text('executed')\n"))
            self.assertFalse(sentinel.exists())

    def test_computed_relative_and_shadowed_importlib_are_unknown(self):
        for call in ["load(name)", "load('sql' + 'alchemy')", "load('.engine', package='sqlalchemy')"]:
            with self.subTest(call=call):
                r = resolve_python_imports(source("from importlib import import_module as load\nmod = " + call + "\n"))
                self.assertNotIn("mod", r.bindings)
                self.assertIn((2, "dynamic_or_relative_module"), r.unresolved)
        r = resolve_python_imports(source("import importlib\nimportlib = other\nmod = importlib.import_module('sqlalchemy')\n"))
        self.assertNotIn("mod", r.bindings)

    def test_named_relative_import_does_not_erase_unrelated_imports(self):
        r = resolve_python_imports(source("import sqlalchemy as sa\nfrom . import version\nfactory = sa.create_engine\n"))
        self.assertEqual(r.bindings["factory"].qualified_name, "sqlalchemy.create_engine")
        self.assertNotIn("version", r.bindings)

    def test_reassignment_definition_and_star_do_not_keep_stale_alias(self):
        for change in ["sa = unknown", "del sa", "def sa(): pass", "from unverified import *", "if condition:\n    sa = other"]:
            with self.subTest(change=change):
                r = resolve_python_imports(source("import sqlalchemy as sa\n" + change + "\nfactory = sa.create_engine\n"))
                self.assertNotIn("factory", r.bindings)

    def test_attribute_and_conditional_mutation_do_not_certify_callable(self):
        for change in ["sa.create_engine = other", "if condition:\n    sa.create_engine = other", "del sa.create_engine"]:
            with self.subTest(change=change):
                r = resolve_python_imports(source("import sqlalchemy as sa\n" + change + "\nfactory = sa.create_engine\n"))
                self.assertNotIn("factory", r.bindings)

    def test_global_rebinding_remains_unknown_even_if_import_is_later(self):
        r = resolve_python_imports(source("def change():\n    global sa\n    sa = other\nimport sqlalchemy as sa\n"))
        self.assertNotIn("sa", r.bindings)

    def test_annotation_does_not_rebind_but_assignment_expression_does(self):
        r = resolve_python_imports(source("import sqlalchemy as sa\nsa: object\nfactory = sa.create_engine\n"))
        self.assertEqual(r.bindings["factory"].qualified_name, "sqlalchemy.create_engine")
        r = resolve_python_imports(source("import sqlalchemy as sa\nunused = (sa := other)\nfactory = sa.create_engine\n"))
        self.assertNotIn("factory", r.bindings)
        self.assertIn((2, "assignment_expression_unresolved"), r.unresolved)

    def test_factory_result_is_not_itself_an_imported_callable(self):
        r = resolve_python_imports(source("from sqlalchemy import create_engine\nengine = create_engine(url)\n"))
        self.assertNotIn("engine", r.bindings)
        self.assertIn((2, "opaque_call_result"), r.unresolved)

    def test_exception_and_pattern_capture_names_invalidate_aliases(self):
        for binding in ["try:\n    unknown()\nexcept Exception as sa:\n    pass", "try:\n    unknown()\nexcept* Exception as sa:\n    pass", "match unknown:\n    case sa:\n        pass", "match unknown:\n    case {'key': value, **sa}:\n        pass"]:
            with self.subTest(binding=binding):
                r = resolve_python_imports(source("import sqlalchemy as sa\n" + binding + "\nfactory = sa.create_engine\n"))
                self.assertNotIn("factory", r.bindings)

    def test_integrity_and_parse_failures_are_bounded(self):
        with self.assertRaisesRegex(ValueError, "python_import_source_mismatch"):
            resolve_python_imports(replace(source("import sqlalchemy"), sha256="0" * 64))
        with self.assertRaisesRegex(ValueError, "^python_import_parse_failed$"):
            resolve_python_imports(source("invalid syntax PRIVATE_SENTINEL"))

    def test_real_case_literal_module_aliases_without_loading_etl(self):
        path = Path(__file__).resolve().parents[1] / "extensions/sales-datamart/src/sales_datamart/etl.py"
        r = resolve_python_imports(source(path.read_text()))
        expected = {"create_engine": "sqlalchemy.create_engine", "text": "sqlalchemy.text", "URL": "sqlalchemy.engine.URL", "source_connection": "sales_datamart.config.source_connection", "target_connection": "sales_datamart.config.target_connection"}
        for name, qualified in expected.items():
            self.assertEqual(r.bindings[name].qualified_name, qualified)
        self.assertEqual(r.bindings["Engine"].qualified_name, "typing.Any")
        self.assertNotEqual(r.bindings["Engine"].qualified_name, "sqlalchemy.engine.Engine")


if __name__ == "__main__":
    unittest.main()
