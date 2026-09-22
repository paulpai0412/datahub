"""Host/Catalog seam tests, with real parser and SDK types, no network/writes."""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import tempfile
import unittest

from datahub.metadata.schema_classes import DatasetKeyClass, SchemaMetadataClass, StatusClass
from datahub.metadata.urns import DatasetUrn
from dataflow_discovery.candidate import Candidate, analysis_digest
from dataflow_discovery.catalog import (
    CatalogBindingError, MssqlScope, bind_sql_dependencies, resolve_dataset,
)
from dataflow_discovery.host import capture_and_analyze


def urn(database="lab", name="dbo.orders"):
    return str(DatasetUrn(platform="mssql", name=f"{database}.{name}", env="PROD"))


def schema(fields=("orderid", "amount")):
    return SchemaMetadataClass.from_obj({
        "schemaName": "orders", "platform": "urn:li:dataPlatform:mssql", "version": 0,
        "hash": "", "platformSchema": {"com.linkedin.schema.OtherSchema": {"rawSchema": ""}},
        "fields": [{"fieldPath": field, "type": {"type": {"com.linkedin.schema.NumberType": {}}},
                    "nativeDataType": "DECIMAL(19,6)", "nullable": False} for field in fields],
    })


class Reader:
    """Only a read surface exists. Any undeclared call fails the test."""
    def __init__(self, datasets=None):
        self.aspects = {}
        self.calls = []
        self.error: str | None = None
        for dataset in datasets or [urn()]:
            parsed = DatasetUrn.from_string(dataset)
            self.aspects[dataset, DatasetKeyClass] = DatasetKeyClass(str(parsed.platform), parsed.name, parsed.env)
            self.aspects[dataset, StatusClass] = StatusClass(removed=False)
            self.aspects[dataset, SchemaMetadataClass] = schema()

    def get_aspect(self, entity_urn, aspect_type):
        self.calls.append((entity_urn, aspect_type))
        if self.error:
            raise RuntimeError(self.error)
        return self.aspects.get((entity_urn, aspect_type))


def scope(database="Lab", datasets=None, **options):
    return MssqlScope(database=database, default_schema="dbo", env="PROD", lowercase_urns=True,
                      lowercase_fields=True, allowed_dataset_urns=tuple(datasets or [urn(database.lower())]), **options)


class CatalogTests(unittest.TestCase):
    def test_real_parser_and_sdk_resolve_native_key_schema_and_physical_fields(self):
        reader = Reader()
        resolved = resolve_dataset("[Lab].[dbo].[Orders]", scope(), reader)
        self.assertEqual(resolved.urn, urn())
        self.assertEqual(resolved.field("OrderID"), "orderid")
        self.assertEqual(resolved.field_paths, ("orderid", "amount"))
        self.assertEqual(len(resolved.schema_sha256), 64)
        self.assertEqual(len(reader.calls), 3)
        for value in ("o.OrderID", "total", "", "Amount AS total"):
            with self.subTest(value=value), self.assertRaises(CatalogBindingError):
                resolved.field(value)

    def test_default_schema_must_be_explicit_not_guessed(self):
        reader = Reader()
        self.assertEqual(resolve_dataset("Orders", scope(), reader).urn, urn())
        reader.calls.clear()
        with self.assertRaisesRegex(CatalogBindingError, "default_schema_unresolved"):
            resolve_dataset("Orders", replace(scope(), default_schema=None), reader)
        self.assertEqual(reader.calls, [])

    def test_scope_denials_happen_before_catalog_io(self):
        for name in ("Elsewhere.dbo.Orders", "server.Lab.dbo.Orders", "dbo.Other",
                     "dbo.Orders alias", "dbo.Orders JOIN dbo.Other ON 1=1", "dbo.[a.b]", "#Orders",
                     "dbo.Orders; SELECT 1", "dbo.Orders WHERE 1=1"):
            reader = Reader()
            with self.subTest(name=name), self.assertRaises(CatalogBindingError):
                resolve_dataset(name, scope(), reader)
            self.assertEqual(reader.calls, [])

    def test_omitted_schema_cannot_be_retargeted_to_a_different_database(self):
        # Regression: Table.parts omits the empty db qualifier in Lab..Orders.
        reader = Reader([urn("other", "lab.orders")])
        policy = scope("Other", [urn("other", "lab.orders")])
        with self.assertRaisesRegex(CatalogBindingError, "unsupported_sql_identifier"):
            resolve_dataset("Lab..Orders", policy, reader)
        self.assertEqual(reader.calls, [])

    def test_exact_urn_case_and_environment_no_suffix_fallback(self):
        exact = urn("Lab", "dbo.Orders")
        policy = replace(scope(datasets=[exact]), lowercase_urns=False)
        reader = Reader([exact])
        self.assertEqual(resolve_dataset("dbo.Orders", policy, reader).urn, exact)
        with self.assertRaisesRegex(CatalogBindingError, "allowlist"):
            resolve_dataset("dbo.orders", policy, reader)
        with self.assertRaises(CatalogBindingError):
            replace(policy, env="DEV")

    def test_missing_key_removed_status_and_malformed_schema_never_bind(self):
        cases = [
            (DatasetKeyClass, None, "catalog_key_missing"),
            (DatasetKeyClass, DatasetKeyClass("urn:li:dataPlatform:mssql", "wrong.dbo.orders", "PROD"), "catalog_key_mismatch"),
            (StatusClass, StatusClass(removed=True), "catalog_status_missing_or_removed"),
            (StatusClass, None, "catalog_status_missing_or_removed"),
            (SchemaMetadataClass, None, "catalog_schema_missing_or_empty"),
            (SchemaMetadataClass, schema(()), "catalog_schema_missing_or_empty"),
            (SchemaMetadataClass, schema(("orderid", "orderid")), "catalog_schema_fields_invalid"),
        ]
        wrong_platform = schema()
        wrong_platform.platform = "urn:li:dataPlatform:postgres"
        cases.append((SchemaMetadataClass, wrong_platform, "catalog_schema_platform_mismatch"))
        for kind, value, reason in cases:
            with self.subTest(reason=reason):
                reader = Reader()
                reader.aspects[urn(), kind] = value
                with self.assertRaisesRegex(CatalogBindingError, reason):
                    resolve_dataset("dbo.Orders", scope(), reader)

    def test_schema_change_and_column_ambiguity_are_not_hidden_by_cache(self):
        reader = Reader()
        first = resolve_dataset("dbo.Orders", scope(), reader)
        reader.aspects[urn(), SchemaMetadataClass] = schema(("OrderID", "orderid"))
        second = resolve_dataset("dbo.Orders", scope(), reader)
        self.assertNotEqual(first.schema_sha256, second.schema_sha256)
        with self.assertRaisesRegex(CatalogBindingError, "ambiguous"):
            second.field("orderid")
        exact = resolve_dataset("dbo.Orders", replace(scope(), lowercase_fields=False), reader)
        self.assertEqual(exact.field("OrderID"), "OrderID")

    def test_read_failure_does_not_echo_reader_error(self):
        reader = Reader()
        reader.error = "private credential sentinel"
        with self.assertRaisesRegex(CatalogBindingError, "^catalog_read_failed$"):
            resolve_dataset("dbo.Orders", scope(), reader)

    def test_invalid_policy_is_not_an_authorization_shortcut(self):
        for update in ({"lowercase_urns": 1}, {"allowed_dataset_urns": []},
                       {"allowed_dataset_urns": (urn(), urn())}, {"database": ""},
                       {"allowed_dataset_urns": ("urn:li:corpuser:someone",)}):
            with self.subTest(update=update), self.assertRaises(CatalogBindingError):
                replace(scope(), **update)

    def capture(self, root, text):
        (root / "pipeline.py").write_text(text)
        return capture_and_analyze(str(root), ["pipeline.py"], source_id="synthetic-pipeline")

    def test_statement_local_scope_does_not_conflate_same_named_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = self.capture(Path(directory), 'SOURCE = "SELECT OrderID AS id FROM dbo.Orders"\nTARGET = "INSERT INTO dbo.Orders (OrderID) SELECT :id"\n')
            relations = [c for c in receipt.analysis.candidates if c.method == "sql_ast_dependency"]
            by_relation = {dict(c.attributes)["relation_type"]: c for c in relations}
            reader = Reader([urn("source"), urn("target")])
            mapping = {by_relation["reads"].subject: scope("Source"), by_relation["writes"].subject: scope("Target")}
            result = bind_sql_dependencies(receipt.analysis, receipt.snapshot, scopes_by_process=mapping, reader=reader)
            self.assertEqual(result["status"], "CATALOG_BOUND")
            bound = {b["relation_type"]: b["dataset"]["urn"] for b in result["bindings"]}
            self.assertEqual(bound, {"reads": urn("source"), "writes": urn("target")})
            self.assertFalse(result["publication_authorized"])
            aliases = [c for c in receipt.analysis.candidates if c.method == "sql_select_alias"]
            self.assertTrue(aliases)
            self.assertTrue(all(c.status == "inferred" for c in aliases))
            # Unknown connection remains unknown; do not select the only Catalog hit.
            reader.calls.clear()
            unresolved = bind_sql_dependencies(receipt.analysis, receipt.snapshot, scopes_by_process={}, reader=reader)
            self.assertTrue(all(b["reason"] == "connection_scope_unresolved" for b in unresolved["bindings"]))
            self.assertEqual(reader.calls, [])

    def test_unknown_process_and_forged_analysis_fail_before_io(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = self.capture(Path(directory), 'SQL = "SELECT OrderID FROM dbo.Orders"\n')
            reader = Reader()
            with self.assertRaisesRegex(CatalogBindingError, "invalid_host_process_scope"):
                bind_sql_dependencies(receipt.analysis, receipt.snapshot, scopes_by_process={"invented": scope()}, reader=reader)
            original = receipt.analysis.candidates[0]
            forged = Candidate.create(kind=original.kind, subject="invented", method=original.method,
                                       attributes=dict(original.attributes), evidence=original.evidence)
            candidates = (forged, *receipt.analysis.candidates[1:])
            analysis = replace(receipt.analysis, candidates=candidates,
                               digest=analysis_digest(receipt.snapshot.sha256, receipt.analysis.analysis_version, candidates))
            with self.assertRaisesRegex(CatalogBindingError, "not_source_bound"):
                bind_sql_dependencies(analysis, receipt.snapshot, scopes_by_process={}, reader=reader)
            self.assertEqual(reader.calls, [])

    def test_source_drift_rejects_old_analysis_and_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = self.capture(root, 'SQL = "SELECT OrderID FROM dbo.Orders"\n')
            current = self.capture(root, 'SQL = "SELECT OrderID FROM dbo.ArchivedOrders"\n')
            reader = Reader()
            with self.assertRaisesRegex(CatalogBindingError, "not_source_bound"):
                bind_sql_dependencies(first.analysis, current.snapshot, scopes_by_process={}, reader=reader)
            self.assertEqual(reader.calls, [])


if __name__ == "__main__":
    unittest.main()
