"""Call-site evidence tests: no captured code, factory or engine is executed."""
import hashlib
import json
from pathlib import Path
import unittest

from dataflow_discovery.python_calls import analyze_factory_calls
from dataflow_discovery.snapshot import SourceFile

HEADER = "from sqlalchemy import create_engine\nfrom sqlalchemy.engine import URL\nfrom config_api import connection as config\ndef build(settings):\n    return create_engine(URL.create('mssql', database=settings.database))\n"


def analyze(text):
    data = text.encode("utf-8")
    return analyze_factory_calls(SourceFile("pipeline.py", text, hashlib.sha256(data).hexdigest(), len(data)))


class CallTests(unittest.TestCase):
    def test_or_and_conditional_remain_unevaluated_alternatives(self):
        result = analyze(HEADER + "def run(override, dry):\n    src = override or build(config())\n    dst = None if dry else (override or build(settings=config()))\n")
        self.assertEqual(len(result["calls"]), 2)
        for call in result["calls"]:
            self.assertEqual(call["argument_binding"], "SYNTAX_ONLY")
            self.assertEqual(call["arguments"]["settings"]["qualified_name"], "config_api.connection")
            self.assertFalse(call["execution_verified"])
        source, target = result["assignments"]
        self.assertEqual(source["value"]["operator"], "or")
        self.assertEqual(source["value"]["operands"][0], {"kind": "parameter", "name": "override"})
        self.assertEqual(target["value"]["if_true"], {"kind": "literal", "value": None})
        self.assertFalse(target["value"]["selection_verified"])
        self.assertFalse(result["publication_authorized"])

    def test_local_factory_and_config_callable_aliases(self):
        result = analyze(HEADER + "def run():\n    make = build\n    load = config\n    settings = load()\n    engine = make(settings)\n")
        call = result["calls"][0]
        self.assertEqual(call["factory"], "build")
        self.assertEqual(call["arguments"]["settings"], {"kind": "assignment_reference", "assignment_id": result["assignments"][2]["id"]})
        self.assertEqual(result["assignments"][2]["value"]["qualified_name"], "config_api.connection")

    def test_duplicate_missing_starred_and_unknown_arguments_not_bound(self):
        for expression in ["build()", "build(config(), settings=config())", "build(*items)", "build(**items)", "build(extra=config())"]:
            with self.subTest(expression=expression):
                result = analyze(HEADER + "def run():\n    engine = " + expression + "\n")
                self.assertEqual(result["calls"][0]["argument_binding"], "UNRESOLVED")
                self.assertEqual(result["calls"][0]["arguments"], {})

    def test_positional_only_and_omitted_defaults(self):
        header = HEADER.replace("def build(settings):", "def build(settings=None, /):")
        result = analyze(header + "def run():\n    engine = build()\n")
        self.assertEqual(result["calls"][0]["omitted_parameters"], ["settings"])
        self.assertEqual(result["calls"][0]["arguments"], {})
        result = analyze(header + "def run():\n    engine = build(settings=config())\n")
        self.assertEqual(result["calls"][0]["argument_binding"], "UNRESOLVED")

    def test_module_and_local_shadowing_do_not_select_old_definition(self):
        for tail in ["build = external\n", "def build(settings):\n    return external(settings)\n"]:
            result = analyze(HEADER + tail + "def run():\n    engine = build(config())\n")
            self.assertEqual(result["calls"], [])
            self.assertIn("module_factory_binding_ambiguous", [item["reason"] for item in result["unresolved"]])
        result = analyze(HEADER + "def run(build):\n    engine = build(config())\n")
        self.assertEqual(result["calls"], [])
        result = analyze(HEADER + "def run():\n    engine = build(config())\n    build = external\n")
        self.assertEqual(result["calls"], [])

    def test_control_flow_boundary_stops_without_guessing_post_branch_bindings(self):
        result = analyze(HEADER + "def run(flag):\n    if flag:\n        build = external\n    engine = build(config())\n")
        self.assertEqual(result["calls"], [])
        self.assertEqual(result["unresolved"][0]["reason"], "control_flow_or_mutation_not_traced")

    def test_literal_secrets_not_exported_and_references_not_expanded(self):
        result = analyze(HEADER + "def run():\n    engine = build('CANARY_PRIVATE_ARGUMENT')\n")
        self.assertNotIn("CANARY_PRIVATE_ARGUMENT", json.dumps(result))
        lines = ["def run(value):", "    v0 = value"]
        lines.extend(f"    v{i} = v{i-1} or v{i-1}" for i in range(1, 60))
        lines.append("    engine = build(v59)")
        result = analyze(HEADER + "\n".join(lines) + "\n")
        self.assertLess(len(json.dumps(result)), 40000)
        self.assertEqual(result["calls"][0]["arguments"]["settings"]["kind"], "assignment_reference")

    def test_real_case_has_distinct_config_calls_and_no_selected_database(self):
        path = Path(__file__).resolve().parents[1] / "extensions/sales-datamart/src/sales_datamart/etl.py"
        result = analyze(path.read_text())
        self.assertEqual(len(result["calls"]), 2)
        origins = {call["arguments"]["config"]["qualified_name"] for call in result["calls"]}
        self.assertEqual(origins, {"sales_datamart.config.source_connection", "sales_datamart.config.target_connection"})
        assignments = {item["name"]: item["value"] for item in result["assignments"] if item["function"] == "run_etl"}
        self.assertEqual(assignments["source"]["operator"], "or")
        self.assertEqual(assignments["source"]["operands"][0]["name"], "source_engine")
        self.assertEqual(assignments["target"]["kind"], "conditional_choice")
        self.assertEqual(assignments["target"]["condition"]["name"], "dry_run")
        self.assertEqual(assignments["target"]["if_false"]["operands"][0]["name"], "target_engine")
        self.assertNotIn("AdventureWorks2019", json.dumps(result))
        self.assertNotIn("SalesDatamart", json.dumps(result))
        self.assertFalse(result["runtime_identity_verified"])


if __name__ == "__main__":
    unittest.main()
