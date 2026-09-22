from __future__ import annotations

from dataclasses import replace
import importlib
import json
from pathlib import Path
import tempfile
import unittest

snapshot_module = importlib.import_module("dataflow_discovery.snapshot")
analyzer = importlib.import_module("dataflow_discovery.analyzer")
candidate_module = importlib.import_module("dataflow_discovery.candidate")
validator = importlib.import_module("dataflow_discovery.validator")
SnapshotError = snapshot_module.SnapshotError
capture_snapshot = snapshot_module.capture_snapshot
analyze_snapshot = analyzer.analyze_snapshot
publication_preview = validator.publication_preview
validate_analysis = validator.validate_analysis


class DiscoveryAnalysisTests(unittest.TestCase):
    def capture(self, root: Path, sql_name: str = "analytics.input"):
        (root / "etl").mkdir()
        (root / "etl/job.py").write_text(
            "def extract(rows):\n"
            "    return rows\n\n"
            "def load(rows):\n"
            "    result = {}\n"
            "    result['amount'] = rows['amount']\n"
            "    return result\n",
            encoding="utf-8",
        )
        (root / "sql").mkdir()
        (root / "sql/query.sql").write_text(
            f"SELECT src.value AS amount FROM {sql_name} AS src;\n",
            encoding="utf-8",
        )
        (root / "bi").mkdir()
        (root / "bi/dashboard.json").write_text(
            json.dumps(
                {
                    "uid": "dash-a",
                    "panels": [
                        {
                            "id": 1,
                            "title": "Amount",
                            "targets": [{"rawSql": "SELECT value AS amount FROM analytics.[output]"}],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        paths = ["etl/job.py", "sql/query.sql", "bi/dashboard.json"]
        return capture_snapshot(root, paths, source_id="approved-analysis")

    def test_static_analysis_emits_neutral_assets_processes_and_consumers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            snapshot = self.capture(Path(directory))
            result = analyze_snapshot(snapshot)
            subjects = {candidate.subject for candidate in result.candidates}
            self.assertIn("dataset:analytics.input", subjects)
            self.assertIn("dataset:analytics.output", subjects)
            self.assertIn("bi:dashboard:dash-a", subjects)
            self.assertTrue(any(candidate.kind == "process" for candidate in result.candidates))
            self.assertTrue(
                any(
                    candidate.kind == "relationship"
                    and dict(candidate.attributes).get("relation_type") == "contains"
                    for candidate in result.candidates
                )
            )
            report = validate_analysis(result, snapshot)
            self.assertNotEqual(report.status, "FAIL")
            preview = publication_preview(result, snapshot)
            self.assertEqual(preview["snapshot_sha256"], snapshot.sha256)
            self.assertGreater(len(preview["candidates"]), 0)

    def test_source_rename_changes_snapshot_and_candidate_digest(self) -> None:
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as second_dir:
            first = self.capture(Path(first_dir), "analytics.input")
            second = self.capture(Path(second_dir), "analytics.renamed")
            first_result = analyze_snapshot(first)
            second_result = analyze_snapshot(second)
            self.assertNotEqual(first.sha256, second.sha256)
            self.assertNotEqual(first_result.digest, second_result.digest)
            first_datasets = {c.subject for c in first_result.candidates if c.subject.startswith("dataset:")}
            second_datasets = {c.subject for c in second_result.candidates if c.subject.startswith("dataset:")}
            self.assertIn("dataset:analytics.input", first_datasets)
            self.assertIn("dataset:analytics.renamed", second_datasets)

    def test_dynamic_dispatch_is_unresolved_not_guessed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "dynamic.py").write_text(
                "def run(value):\n    return getattr(value, 'unknown_target')\n",
                encoding="utf-8",
            )
            snapshot = capture_snapshot(root, ["dynamic.py"], source_id="approved-dynamic")
            result = analyze_snapshot(snapshot)
            unresolved = [c for c in result.candidates if c.kind == "unresolved"]
            self.assertTrue(unresolved)
            self.assertTrue(any(dict(c.attributes).get("construct") == "getattr" for c in unresolved))

    def test_tampered_current_file_digest_fails_independent_validation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            snapshot = self.capture(Path(directory))
            result = analyze_snapshot(snapshot)
            changed_file = replace(snapshot.files[0], text=snapshot.files[0].text + "changed\n")
            tampered = replace(snapshot, files=(changed_file, *snapshot.files[1:]))
            report = validate_analysis(result, tampered)
            self.assertEqual(report.status, "FAIL")
            self.assertTrue(any("digest" in item for item in report.findings))

    def test_tampered_candidate_digest_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            snapshot = self.capture(Path(directory))
            result = analyze_snapshot(snapshot)
            payload = result.to_dict()
            payload["candidate_digest"] = "0" * 64
            report = validator.validate_payload(payload, snapshot)
            self.assertEqual(report.status, "FAIL")
            self.assertIn("analysis_digest_mismatch", report.findings)

    def test_direct_validation_rejects_forged_digests_and_candidate_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            snapshot = self.capture(Path(directory))
            result = analyze_snapshot(snapshot)
            cases = [
                (replace(result, digest="0" * 64), snapshot),
                (replace(result, snapshot_sha256="0" * 64), replace(snapshot, sha256="0" * 64)),
                (replace(result, candidates=(replace(result.candidates[0], candidate_id="cand_" + "0" * 24), *result.candidates[1:])), snapshot),
            ]
            for analysis, source in cases:
                with self.subTest(digest=analysis.digest, snapshot=source.sha256):
                    report = validate_analysis(analysis, source)
                    self.assertEqual(report.status, "FAIL")
                    self.assertEqual(report.publishable_candidate_ids, ())
                    with self.assertRaises(validator.ValidationError):
                        publication_preview(analysis, source)

    def test_all_snapshot_files_are_validated_even_without_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            snapshot = self.capture(Path(directory))
            result = analyze_snapshot(snapshot)
            result = replace(result, candidates=(), digest=analyzer.analysis_digest(snapshot.sha256, result.analysis_version, ()))
            for changed_file in (
                replace(snapshot.files[0], text=snapshot.files[0].text + "changed"),
                replace(snapshot.files[0], size_bytes=snapshot.files[0].size_bytes + 1),
            ):
                altered = replace(snapshot, files=(changed_file, *snapshot.files[1:]))
                self.assertEqual(validate_analysis(result, altered).status, "FAIL")
            duplicated = replace(snapshot, files=(*snapshot.files, snapshot.files[0]))
            self.assertEqual(validate_analysis(result, duplicated).status, "FAIL")

    def sql_analysis(self, sql: str):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "query.sql").write_text(sql, encoding="utf-8")
            source = capture_snapshot(root, ["query.sql"], source_id="sql-review")
            return source, analyze_snapshot(source)

    def test_sql_literals_and_comments_do_not_invent_datasets(self) -> None:
        source, result = self.sql_analysis(
            "SELECT 'FROM dbo.fake_literal' AS note FROM dbo.actual; -- JOIN dbo.fake_comment\n"
        )
        self.assertEqual(
            {c.subject for c in result.candidates if c.subject.startswith("dataset:")},
            {"dataset:dbo.actual"},
        )
        self.assertFalse(any(c.kind == "field_mapping" for c in result.candidates))
        self.assertFalse(validate_analysis(result, source).findings)

    def test_sqlcmd_batches_keep_evidence_lines_and_ignore_quoted_go(self) -> None:
        source, result = self.sql_analysis(
            "\nSELECT a.id AS ident FROM dbo.first AS a;\nGO\n\n"
            "SELECT b.id AS ident FROM dbo.second AS b;\nGO -- batch end\n"
        )
        processes = [c for c in result.candidates if c.kind == "process"]
        self.assertEqual(len(processes), 2)
        self.assertEqual(sorted(c.evidence[0].start_line for c in processes), [1, 4])
        self.assertFalse(validate_analysis(result, source).findings)
        _source, quoted = self.sql_analysis("SELECT 'before\nGO\nafter' AS note FROM dbo.actual;\n")
        self.assertEqual(sum(c.kind == "process" for c in quoted.candidates), 1)

    def test_unparsed_sql_does_not_emit_publishable_dependencies(self) -> None:
        _source, result = self.sql_analysis("SELECT ( FROM dbo.actual\n")
        self.assertTrue(any(c.kind == "unresolved" for c in result.candidates))
        self.assertFalse(any(c.kind in {"relationship", "field_mapping"} and c.status == "resolved" for c in result.candidates))

    def test_omitted_schema_is_not_reinterpreted_as_another_database_schema(self) -> None:
        _source, result = self.sql_analysis("SELECT id FROM ReportingDb..Orders;")
        self.assertTrue(any(c.kind == "unresolved" for c in result.candidates))
        self.assertFalse(any(c.subject.startswith("dataset:") for c in result.candidates))
        self.assertFalse(any(c.method == "sql_ast_dependency" for c in result.candidates))

    def test_select_into_preserves_read_and_write_roles(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "query.sql").write_text("SELECT id INTO dm.new_table FROM dbo.source_table;", encoding="utf-8")
            source = capture_snapshot(root, ["query.sql"], source_id="sql-review")
            result = analyze_snapshot(source)
            relations = {(c.object, dict(c.attributes).get("relation_type")) for c in result.candidates if c.kind == "relationship"}
            self.assertEqual(relations, {("dataset:dm.new_table", "writes"), ("dataset:dbo.source_table", "reads")})

    def test_old_analysis_version_requires_reanalysis(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.capture(root)
            result = analyze_snapshot(source)
            old = replace(result, analysis_version="1.0.1")
            old = replace(old, digest=candidate_module.analysis_digest(
                old.snapshot_sha256, old.analysis_version, old.candidates))
            report = validate_analysis(old, source)
            self.assertIn("unsupported_analysis_version", report.findings)
            self.assertFalse(report.publishable_candidate_ids)

    def test_cte_alias_is_not_a_physical_dataset(self) -> None:
        _source, result = self.sql_analysis(
            "WITH tmp AS (SELECT id FROM dbo.actual) SELECT id AS ident FROM tmp;\n"
        )
        self.assertEqual(
            {c.subject for c in result.candidates if c.subject.startswith("dataset:")},
            {"dataset:dbo.actual"},
        )

    def test_grafana_target_dependencies_keep_the_parent_panel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "dashboard.json").write_text(json.dumps({
                "dashboard": {"uid": "dashboard-a", "panels": [
                    {"id": 1, "targets": [{"rawSql": "SELECT id FROM dbo.first_table"}]},
                    {"id": 2, "targets": [{"rawSql": "SELECT id FROM dbo.second_table"}]},
                ]},
            }), encoding="utf-8")
            source = capture_snapshot(root, ["dashboard.json"], source_id="bi-review")
            result = analyze_snapshot(source)
            consumers = {(c.subject, c.object) for c in result.candidates
                         if c.kind == "relationship" and dict(c.attributes).get("relation_type") == "consumes"}
            self.assertEqual(consumers, {("bi:chart:dashboard-a:1", "dataset:dbo.first_table"),
                                         ("bi:chart:dashboard-a:2", "dataset:dbo.second_table")})
            self.assertFalse(validate_analysis(result, source).findings)

    def test_snapshot_does_not_execute_source_comment_or_program(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / "created-by-source"
            (root / "job.py").write_text(
                f"# Path({str(marker)!r}).touch()\nvalue = 1\n",
                encoding="utf-8",
            )
            snapshot = capture_snapshot(root, ["job.py"], source_id="approved-no-exec")
            analyze_snapshot(snapshot)
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
