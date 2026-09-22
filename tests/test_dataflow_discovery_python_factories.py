"""Offline tests; source strings and the real ETL are parsed, never executed."""
import hashlib
import json
from pathlib import Path
import unittest

from dataflow_discovery.python_factories import analyze_engine_factories
from dataflow_discovery.snapshot import SourceFile


HEADER = "from sqlalchemy import create_engine\nfrom sqlalchemy.engine import URL\n"


def analyze(text):
    data = text.encode("utf-8")
    return analyze_engine_factories(SourceFile("pipeline.py", text, hashlib.sha256(data).hexdigest(), len(data)))


class FactoryTests(unittest.TestCase):
    def test_parameterized_factory_omits_credentials_and_option_values(self):
        result = analyze(HEADER + "def factory(cfg):\n    return create_engine(URL.create('mssql+pytds', database=cfg.database, host=cfg.host, port=cfg.port, username='CANARY_USER', password='CANARY_PASSWORD'), connect_args={'password': 'CANARY_OPTION'})\n")
        self.assertEqual(len(result["factories"]), 1)
        factory = result["factories"][0]
        self.assertEqual(factory["coordinates"]["database"], {"kind": "parameter", "name": "cfg", "attributes": ["database"]})
        self.assertEqual(factory["coordinates"]["driver"], {"kind": "literal", "value": "mssql+pytds"})
        self.assertEqual(factory["engine_option_names"], ["connect_args"])
        self.assertTrue(factory["opaque_engine_options"])
        self.assertNotIn("CANARY_", json.dumps(result))
        self.assertFalse(result["runtime_identity_verified"])
        self.assertFalse(result["publication_authorized"])

    def test_linear_aliases_preserve_the_original_parameter(self):
        result = analyze(HEADER + "def factory(cfg):\n    make = create_engine\n    url = URL.create\n    nested = cfg.reader\n    engine = make(url('mssql', database=nested.database))\n    return engine\n")
        self.assertEqual(result["factories"][0]["coordinates"]["database"], {"kind": "parameter", "name": "cfg", "attributes": ["reader", "database"]})
        self.assertEqual(result["factories"][0]["coordinates"]["host"]["kind"], "unresolved")

    def test_reassigned_parameter_is_not_bound_to_its_original_argument(self):
        result = analyze(HEADER + "def factory(cfg, other):\n    cfg = other\n    return create_engine(URL.create('mssql', database=cfg.database))\n")
        self.assertEqual(result["factories"][0]["coordinates"]["database"]["name"], "other")
        result = analyze(HEADER + "def factory(cfg):\n    cfg = opaque()\n    return create_engine(URL.create('mssql', database=cfg.database))\n")
        self.assertEqual(result["factories"][0]["coordinates"]["database"]["kind"], "unresolved")

    def test_parameter_and_late_local_shadowing_cannot_create_factory(self):
        for text in ["def factory(cfg, create_engine):\n    return create_engine(URL.create('mssql', database=cfg.database))\n", "def factory(cfg):\n    return create_engine(URL.create('mssql', database=cfg.database))\n    create_engine = opaque\n"]:
            with self.subTest(text=text):
                result = analyze(HEADER + text)
                self.assertEqual(result["factories"], [])
                self.assertTrue(result["unresolved"])

    def test_late_import_definition_and_generator_are_not_ordinary_factories(self):
        for tail in ["    from other import create_engine\n", "    def create_engine(): pass\n", "    class create_engine: pass\n", "    yield None\n"]:
            with self.subTest(tail=tail):
                result = analyze(HEADER + "def factory(cfg):\n    return create_engine(URL.create('mssql'))\n" + tail)
                self.assertEqual(result["factories"], [])
                self.assertTrue(result["unresolved"])

    def test_branch_decorator_and_attribute_mutation_stay_unresolved(self):
        bodies = ["    if flag:\n        return create_engine(URL.create('mssql'))\n", "    URL.create = opaque\n    return create_engine(URL.create('mssql'))\n"]
        for body in bodies:
            result = analyze(HEADER + "def factory(cfg):\n" + body)
            self.assertEqual(result["factories"], [])
        result = analyze(HEADER + "@unknown_decorator\ndef factory(cfg):\n    return create_engine(URL.create('mssql'))\n")
        self.assertEqual(result["factories"], [])
        self.assertEqual(result["unresolved"][0]["reason"], "decorated_factory_unresolved")

    def test_url_strings_dynamic_arguments_and_duplicate_driver_not_promoted(self):
        for url in ["'mssql://CANARY_SECRET@host/db'", "URL.create('mssql', **options)", "URL.create('mssql', drivername='postgresql')"]:
            with self.subTest(url=url):
                result = analyze(HEADER + "def factory(cfg):\n    return create_engine(" + url + ")\n")
                self.assertEqual(result["factories"], [])
                self.assertNotIn("CANARY_SECRET", json.dumps(result))
        result = analyze(HEADER + "def factory(cfg):\n    return create_engine(URL.create('mssql', database=cfg.database), creator=custom_connection)\n")
        self.assertTrue(result["factories"][0]["opaque_engine_options"])
        self.assertFalse(result["runtime_identity_verified"])

    def test_real_case_factory_is_parameterized_not_a_source_or_target_identity(self):
        path = Path(__file__).resolve().parents[1] / "extensions/sales-datamart/src/sales_datamart/etl.py"
        result = analyze(path.read_text())
        self.assertEqual(len(result["factories"]), 1)
        factory = result["factories"][0]
        self.assertEqual(factory["function"], "_engine")
        for field in ("database", "host", "port"):
            self.assertEqual(factory["coordinates"][field], {"kind": "parameter", "name": "config", "attributes": [field]})
        self.assertNotIn("AdventureWorks", json.dumps(result))
        self.assertNotIn("SalesDatamart", json.dumps(result))
        self.assertFalse(result["publication_authorized"])


if __name__ == "__main__":
    unittest.main()
