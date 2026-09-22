from __future__ import annotations

from dataclasses import replace
import importlib
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock, patch

candidate = importlib.import_module("dataflow_discovery.candidate")
analyzer = importlib.import_module("dataflow_discovery.analyzer")
publisher = importlib.import_module("dataflow_discovery.publisher")
snapshot_module = importlib.import_module("dataflow_discovery.snapshot")


class PublisherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "job.py").write_text(
            'QUERY = "INSERT INTO dm.target_table (id) SELECT id FROM dbo.source_table;"\n'
            'def load():\n    return QUERY\n', encoding="utf-8",
        )
        self.snapshot = snapshot_module.capture_snapshot(self.root, ["job.py"], source_id="approved-publisher")
        self.analysis = analyzer.analyze_snapshot(self.snapshot)
        items = self.analysis.candidates
        module = next(c for c in items if c.method == "python_ast_module")
        sql = next(c for c in items if c.kind == "process" and c.subject.startswith("process:sql:"))
        source = next(c for c in items if c.kind == "asset" and c.subject == "dataset:dbo.source_table")
        target = next(c for c in items if c.kind == "asset" and c.subject == "dataset:dm.target_table")
        self.reads = next(c for c in items if c.kind == "relationship" and dict(c.attributes).get("relation_type") == "reads")
        self.writes = next(c for c in items if c.kind == "relationship" and dict(c.attributes).get("relation_type") == "writes")
        self.flow = publisher.EntitySpec.create(
            kind="dataFlow", urn="urn:li:dataFlow:(python,approved-etl,DEV)",
            platform="python", name="approved-etl", candidate_id=module.candidate_id,
        )
        self.job = publisher.EntitySpec.create(
            kind="dataJob", urn="urn:li:dataJob:(urn:li:dataFlow:(python,approved-etl,DEV),load)",
            name="load", flow_urn=self.flow.urn, candidate_id=sql.candidate_id,
        )
        self.source = publisher.EntitySpec.create(
            kind="dataset", urn="urn:li:dataset:(urn:li:dataPlatform:mssql,dbo.source_table,DEV)",
            platform="mssql", name="dbo.source_table", create_if_missing=False, candidate_id=source.candidate_id,
        )
        self.target = publisher.EntitySpec.create(
            kind="dataset", urn="urn:li:dataset:(urn:li:dataPlatform:mssql,dm.target_table,DEV)",
            platform="mssql", name="dm.target_table", candidate_id=target.candidate_id,
        )
        self.entities = (self.flow, self.job, self.source, self.target)
        self.lineages = (
            publisher.LineageSpec.create(upstream=self.source.urn, downstream=self.job.urn,
                                        relation_type="reads", candidate_ids=(self.reads.candidate_id,)),
            publisher.LineageSpec.create(upstream=self.job.urn, downstream=self.target.urn,
                                        relation_type="writes", candidate_ids=(self.writes.candidate_id,)),
        )
        self.approval = publisher.PublicationApproval(
            actor_urn="urn:li:corpuser:operator", approved_at_ms=1000, expires_at_ms=2000,
            technical_lineage=True,
            candidate_ids=tuple(sorted([entity.candidate_id for entity in self.entities] +
                                       [self.reads.candidate_id, self.writes.candidate_id])),
        )

    def plan(self, **changes: Any) -> Any:
        values = dict(approval=self.approval, entities=self.entities, lineages=self.lineages)
        values.update(changes)
        return publisher.make_publication_plan(self.analysis, self.snapshot, **values)

    def publish(self, plan: Any, client: Any, **changes: Any) -> Any:
        values = dict(root=str(self.root), paths=["job.py"], source_id=self.snapshot.source_id, now_ms=1500, readback=False)
        values.update(changes)
        return publisher.publish_plan(plan, client, **values)

    def test_plan_binds_real_analyzer_candidates_and_round_trips(self) -> None:
        plan = self.plan()
        publisher.validate_publication_plan(plan, now_ms=1500)
        publisher.validate_publication_binding(plan, self.analysis, self.snapshot)
        self.assertEqual(plan.to_dict(), publisher.PublicationPlan.from_dict(plan.to_dict()).to_dict())
        preview = publisher.publication_preview(plan)
        self.assertEqual(preview["plan_digest"], plan.plan_digest)
        self.assertEqual(preview["status"], "PLAN_ONLY_REQUIRES_TRUSTED_AUTHORIZATION")
        self.assertEqual(len(preview["entity_urns"]), 4)

    def test_preparation_digest_is_stable_when_a_later_response_is_attached(self) -> None:
        preview = self.plan(approval=None)
        self.assertIsNone(preview.approval)
        self.assertIsNone(publisher.publication_preview(preview)["approval"])
        self.assertEqual(preview.to_dict(), publisher.PublicationPlan.from_dict(preview.to_dict()).to_dict())
        client = Mock()
        with self.assertRaisesRegex(publisher.PublicationError, "publication_approval_required"):
            self.publish(preview, client)
        self.assertEqual(client.mock_calls, [])
        later = replace(self.approval, actor_urn="urn:li:corpuser:other-reviewer",
                        approved_at_ms=1600, expires_at_ms=2600, plan_digest=preview.plan_digest)
        reviewed = self.plan(approval=later)
        self.assertEqual(preview.plan_digest, reviewed.plan_digest)
        publisher.validate_publication_plan(reviewed, now_ms=1700)
        self.assertNotEqual(preview.to_dict()["approval"], reviewed.to_dict()["approval"])
        altered = replace(reviewed, revision="different-source-revision")
        with self.assertRaisesRegex(publisher.PublicationError, "publication_plan_digest_mismatch"):
            publisher.validate_publication_plan(altered, now_ms=1700)
        # These remain claims in an unaccepted draft, not authenticated consent.
        self.assertEqual(publisher.publication_preview(reviewed)["status"],
                         "PLAN_ONLY_REQUIRES_TRUSTED_AUTHORIZATION")

    def test_source_plan_compiles_native_io_and_all_sdk_aspects_without_approval(self) -> None:
        flow = replace(self.flow, description="Source-declared flow description")
        plan = self.plan(approval=None, entities=(flow, self.job, self.source, self.target))
        args = dict(root=str(self.root), paths=["job.py"], source_id=self.snapshot.source_id)
        records = publisher.compile_publication_mcps(plan, **args)
        by_key = {(m.entityUrn, m.aspectName): m.aspect for m in records}
        self.assertFalse(any(m.entityUrn == self.source.urn for m in records))
        self.assertIn((flow.urn, "editableDataFlowProperties"), by_key)
        self.assertNotIn((self.target.urn, "schemaMetadata"), by_key)
        io = by_key[(self.job.urn, "dataJobInputOutput")]
        self.assertEqual(io.inputDatasets, [self.source.urn])
        self.assertEqual(io.outputDatasets, [self.target.urn])
        self.assertEqual(by_key[(self.job.urn, "dataJobInfo")].flowUrn, flow.urn)
        self.assertEqual([m.to_obj() for m in records],
                         [m.to_obj() for m in publisher.compile_publication_mcps(plan, **args)])
        repeated = self.plan(approval=None, entities=(flow, self.job, self.source, self.target),
                             lineages=(*self.lineages, *self.lineages))
        self.assertEqual([m.to_obj() for m in records],
                         [m.to_obj() for m in publisher.compile_publication_mcps(repeated, **args)])
        # Real official MCP serialization is consumed by the existing Host
        # review builder. No Node/Python server, credential or emitter is used.
        payload = {"sourceId": plan.source_id, "snapshotSha256": plan.snapshot_sha256,
                   "candidateDigest": plan.candidate_digest, "analysisVersion": plan.analysis_version,
                   "candidateIds": list(plan.candidate_ids), "datasets": [self.source.urn, self.target.urn],
                   "mcps": [m.to_obj(simplified_structure=True) for m in records]}
        code = """
import fs from 'node:fs';
import {makePublicationReview,canonicalPublicationJson} from './extensions/datahub-agent/integration/publication-review.mjs';
const {mcps,...binding}=JSON.parse(fs.readFileSync(0,'utf8'));
const review=makePublicationReview({...binding,purpose:'LINEAGE',source:'urn:li:dataHubIngestionSource:fixture',expiresAt:10000,
 changes:mcps.map(m=>({urn:m.entityUrn,aspect:m.aspectName,expectedVersion:'-1',valueJson:canonicalPublicationJson(m.aspect.json)}))});
console.log(JSON.stringify({changes:review.changes.length,planDigest:review.planDigest}));
"""
        result = subprocess.run(["node", "--input-type=module", "-e", code], input=json.dumps(payload),
                                text=True, capture_output=True, timeout=15, check=True,
                                cwd=Path(__file__).resolve().parents[1],
                                env={"PATH": os.environ.get("PATH", os.defpath), "HOME": str(self.root)})
        review = json.loads(result.stdout)
        self.assertEqual(review["changes"], len(records))
        self.assertRegex(review["planDigest"], r"^[a-f0-9]{64}$")

    def test_native_compiler_refuses_unknown_sdk_and_mutating_reference_only_entities(self) -> None:
        args = dict(root=str(self.root), paths=["job.py"], source_id=self.snapshot.source_id)
        with patch("importlib.metadata.version", return_value="future-unverified"):
            with self.assertRaisesRegex(publisher.PublicationError, "publication_sdk_version_unverified"):
                publisher.compile_publication_mcps(self.plan(approval=None), **args)
        plan = self.plan(approval=None, entities=(self.flow, replace(self.job, create_if_missing=False),
                                                 self.source, self.target))
        with self.assertRaisesRegex(publisher.PublicationError, "reference_entity_cannot_receive_aspects"):
            publisher.compile_publication_mcps(plan, **args)

    def test_native_compiler_rejects_source_drift_before_sdk_construction(self) -> None:
        plan = self.plan(approval=None)
        (self.root / "job.py").write_text("# changed source\n", encoding="utf-8")
        with patch.object(publisher, "_entity_object") as construct:
            with self.assertRaises(publisher.PublicationError):
                publisher.compile_publication_mcps(plan, root=str(self.root), paths=["job.py"],
                                                   source_id=self.snapshot.source_id)
            construct.assert_not_called()

    def test_unrelated_asset_id_cannot_authorize_an_edge(self) -> None:
        asset = next(c for c in self.analysis.candidates if c.subject == "file:job.py")
        approval = replace(self.approval, candidate_ids=(*self.approval.candidate_ids, asset.candidate_id))
        forged = replace(self.lineages[1], candidate_ids=(asset.candidate_id,))
        with self.assertRaisesRegex(publisher.PublicationError, "lineage_requires_relationship_candidate"):
            self.plan(approval=approval, lineages=(self.lineages[0], forged))

    def test_relation_cannot_be_retargeted_to_another_approved_entity(self) -> None:
        forged = replace(self.lineages[1], downstream=self.source.urn)
        with self.assertRaisesRegex(publisher.PublicationError, "lineage_candidate_binding_mismatch"):
            self.plan(lineages=(self.lineages[0], forged))

    def test_deserialized_rehashed_forgery_is_rejected_before_client_use(self) -> None:
        plan = self.plan()
        forged = replace(plan, lineages=(self.lineages[0], replace(self.lineages[1], downstream=self.source.urn)))
        forged = replace(forged, plan_digest=publisher._digest(publisher._plan_payload(forged)))
        decoded = publisher.PublicationPlan.from_dict(forged.to_dict())
        client = Mock()
        with self.assertRaisesRegex(publisher.PublicationError, "lineage_candidate_binding_mismatch"):
            self.publish(decoded, client)
        self.assertEqual(client.mock_calls, [])

    def test_rehashed_caller_authored_analysis_is_not_parser_evidence(self) -> None:
        # Rebuild a valid candidate ID as an adversarial client could do.
        forged = candidate.Candidate.create(kind=self.writes.kind, subject=self.writes.subject, object=self.reads.object,
                                             method=self.writes.method, attributes=dict(self.writes.attributes),
                                             evidence=self.writes.evidence, limitations=self.writes.limitations)
        candidates = tuple(forged if c.candidate_id == self.writes.candidate_id else c for c in self.analysis.candidates)
        candidates = tuple(sorted(candidates, key=lambda c: c.candidate_id))
        analysis = replace(self.analysis, candidates=candidates,
                           digest=candidate.analysis_digest(self.snapshot.sha256, candidate.ANALYSIS_VERSION, candidates))
        approval = replace(self.approval, candidate_ids=tuple(forged.candidate_id if cid == self.writes.candidate_id else cid
                                                            for cid in self.approval.candidate_ids))
        edge = replace(self.lineages[1], downstream=self.source.urn, candidate_ids=(forged.candidate_id,))
        with self.assertRaisesRegex(publisher.PublicationError, "analysis_not_reproducible_from_source"):
            publisher.make_publication_plan(analysis, self.snapshot, approval=approval,
                                            entities=self.entities, lineages=(self.lineages[0], edge))

    def test_unbound_entity_and_wrong_kind_are_rejected(self) -> None:
        with self.assertRaisesRegex(publisher.PublicationError, "entity_candidate_not_approved"):
            self.plan(entities=(*self.entities[:-1], replace(self.target, candidate_id=None)))
        wrong = replace(self.target, candidate_id=self.job.candidate_id)
        with self.assertRaisesRegex(publisher.PublicationError, "entity_candidate_kind_mismatch"):
            self.plan(entities=(*self.entities[:-1], wrong))

    def test_unused_approved_candidate_is_rejected(self) -> None:
        unused = next(c for c in self.analysis.candidates if c.subject == "file:job.py")
        with self.assertRaisesRegex(publisher.PublicationError, "unused_approved_candidate"):
            self.plan(approval=replace(self.approval, candidate_ids=(*self.approval.candidate_ids, unused.candidate_id)))

    def test_unresolved_candidate_cannot_be_approved(self) -> None:
        unresolved = next(c for c in self.analysis.candidates if c.status == "unresolved")
        with self.assertRaisesRegex(publisher.PublicationError, "unpublishable_candidate_approval"):
            self.plan(approval=replace(self.approval, candidate_ids=(*self.approval.candidate_ids, unresolved.candidate_id)))

    def test_source_drift_is_rejected_before_client_use(self) -> None:
        plan = self.plan()
        (self.root / "job.py").write_text('QUERY = "SELECT id FROM dbo.renamed_table"\n', encoding="utf-8")
        client = Mock()
        with self.assertRaisesRegex(publisher.PublicationError, "candidate_validation_failed"):
            self.publish(plan, client)
        self.assertEqual(client.mock_calls, [])

    def test_missing_trusted_source_scope_cannot_be_published(self) -> None:
        with self.assertRaises(TypeError):
            publisher.publish_plan(self.plan(), Mock(), now_ms=1500, readback=False)  # type: ignore[call-arg]

    def test_publish_uses_one_pass_and_does_not_claim_commit(self) -> None:
        client = SimpleNamespace(lineage=Mock())
        receipt = self.publish(self.plan(), client, emit=lambda _client, _spec: "created")
        self.assertEqual(receipt.status, "ACKNOWLEDGED_NOT_READ_BACK")
        self.assertEqual(receipt.published_lineages, 2)
        self.assertEqual(client.lineage.add_lineage.call_count, 2)
        self.assertEqual(receipt.to_dict()["credentials_in_receipt"], False)

    def test_technical_approval_requires_bool_true_not_truthy_values(self) -> None:
        invalid_values: list[Any] = [1, "true", None, False]
        for value in invalid_values:
            with self.subTest(value=value), self.assertRaises(publisher.PublicationError):
                replace(self.approval, technical_lineage=value)

    def test_expired_and_future_approval_are_rejected_before_client_use(self) -> None:
        for now in (999, 2000):
            client = Mock()
            with self.subTest(now=now), self.assertRaises(publisher.PublicationError):
                self.publish(self.plan(), client, now_ms=now)
            self.assertEqual(client.mock_calls, [])

    def test_approval_expiry_during_capture_is_rejected_before_client_use(self) -> None:
        plan = self.plan()
        client = Mock()
        with patch.object(publisher, "_current_time_ms", side_effect=[1500, 2000]):
            with self.assertRaisesRegex(publisher.PublicationError, "publication_approval_expired"):
                self.publish(plan, client, now_ms=None)
        self.assertEqual(client.mock_calls, [])

    def test_source_scope_and_commit_claim_are_not_taken_from_plan(self) -> None:
        client = Mock()
        with self.assertRaises(publisher.PublicationError):
            self.publish(self.plan(), client, source_id="different-host-scope")
        with self.assertRaisesRegex(publisher.PublicationError, "publication_revision_mismatch"):
            self.publish(self.plan(revision="f" * 40), client)
        self.assertEqual(client.mock_calls, [])

    def test_entity_failure_stops_following_entities_and_lineages(self) -> None:
        client = Mock()
        with patch.object(publisher, "_emit_entity", side_effect=publisher.PublicationError("schema_conflict")) as emit:
            receipt = self.publish(self.plan(), client)
        self.assertEqual(emit.call_count, 1)
        self.assertEqual(client.mock_calls, [])
        self.assertEqual(receipt.attempted_lineages, 0)
        self.assertEqual(receipt.status, "UNKNOWN_NEEDS_RECONCILIATION")

    def test_official_sdk_constructs_pipeline_entities_without_inventing_empty_schema(self) -> None:
        for spec in self.entities:
            with self.subTest(kind=spec.kind):
                entity = publisher._entity_object(spec)
                self.assertEqual(str(entity.urn), spec.urn)
                if spec.kind == "dataset":
                    self.assertNotIn("schemaMetadata", [mcp.aspectName for mcp in entity.as_mcps()])

    def test_official_sdk_constructs_bi_entities(self) -> None:
        for kind in ("chart", "dashboard"):
            with self.subTest(kind=kind):
                spec = publisher.EntitySpec.create(kind=kind, urn=f"urn:li:{kind}:(grafana,review)",
                                                   platform="grafana", name="review")
                self.assertEqual(str(publisher._entity_object(spec).urn), spec.urn)

    def test_complete_lineage_endpoint_types_and_urns_are_checked(self) -> None:
        bad_pairs = [(self.job.urn, self.flow.urn, "writes"), (self.source.urn, self.flow.urn, "reads"),
                     (self.job.urn, self.target.urn, "transforms"), ("urn:li:dataset:junk", self.job.urn, "reads")]
        for upstream, downstream, relation in bad_pairs:
            with self.subTest(relation=relation), self.assertRaises(publisher.PublicationError):
                publisher.LineageSpec.create(upstream=upstream, downstream=downstream,
                                             relation_type=relation, candidate_ids=(self.writes.candidate_id,))

    def test_grafana_contains_and_consumes_use_datahub_direction(self) -> None:
        (self.root / "dashboard.json").write_text(json.dumps({
            "uid": "review", "panels": [{"id": 1, "targets": [{"rawSql": "SELECT id FROM dbo.source_table"}]}],
        }), encoding="utf-8")
        source = snapshot_module.capture_snapshot(self.root, ["dashboard.json"], source_id="approved-bi")
        analysis = analyzer.analyze_snapshot(source)
        dashboard = next(c for c in analysis.candidates if c.subject == "bi:dashboard:review" and c.kind == "asset")
        chart = next(c for c in analysis.candidates if c.subject == "bi:chart:review:1" and c.kind == "asset")
        dataset = next(c for c in analysis.candidates if c.subject == "dataset:dbo.source_table" and c.kind == "asset")
        edges = [c for c in analysis.candidates if c.kind == "relationship" and dict(c.attributes).get("relation_type") in {"contains", "consumes"}]
        specs = (
            publisher.EntitySpec.create(kind="dashboard", urn="urn:li:dashboard:(grafana,review)", platform="grafana", name="review", candidate_id=dashboard.candidate_id),
            publisher.EntitySpec.create(kind="chart", urn="urn:li:chart:(grafana,review-1)", platform="grafana", name="review-1", candidate_id=chart.candidate_id),
            replace(self.source, candidate_id=dataset.candidate_id),
        )
        by_subject = {dashboard.subject: specs[0].urn, chart.subject: specs[1].urn, dataset.subject: specs[2].urn}
        lineages = tuple(publisher.LineageSpec.create(upstream=by_subject[c.object], downstream=by_subject[c.subject],
                         relation_type=dict(c.attributes)["relation_type"], candidate_ids=(c.candidate_id,)) for c in edges)
        approval = replace(self.approval, candidate_ids=tuple([s.candidate_id for s in specs] + [c.candidate_id for c in edges]))
        plan = publisher.make_publication_plan(analysis, source, approval=approval, entities=specs, lineages=lineages)
        compiled = publisher.compile_publication_mcps(replace(plan, approval=None), root=str(self.root), paths=["dashboard.json"],
                                                     source_id="approved-bi")
        native = {(m.entityUrn, m.aspectName): m.aspect for m in compiled}
        self.assertEqual(native[(specs[1].urn, "chartInfo")].inputs, [specs[2].urn])
        self.assertEqual([edge.destinationUrn for edge in native[(specs[0].urn, "dashboardInfo")].chartEdges],
                         [specs[1].urn])
        client = SimpleNamespace(lineage=Mock())
        receipt = publisher.publish_plan(plan, client, root=str(self.root), paths=["dashboard.json"], source_id="approved-bi",
                                         now_ms=1500, readback=False, emit=lambda *_: "created")
        self.assertEqual(receipt.published_lineages, 2)
        self.assertEqual({(edge.upstream, edge.downstream) for edge in plan.lineages},
                         {(specs[2].urn, specs[1].urn), (specs[1].urn, specs[0].urn)})

    def test_old_publication_format_is_not_silently_upgraded(self) -> None:
        value = self.plan().to_dict()
        for old_format in ("dataflow-discovery.publication-plan/1", "dataflow-discovery.publication-plan/2"):
            value["format"] = old_format
            with self.assertRaisesRegex(publisher.PublicationError, "unsupported_publication_format"):
                publisher.PublicationPlan.from_dict(value)


class PythonJobIOFixture(unittest.TestCase):
    SOURCE = '''from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL
from config_api import target
QUERY = text("INSERT INTO dm.output_rows (id) SELECT id FROM dbo.input_rows")
def execute(conn, statement):
    conn.execute(statement)
def load(conn):
    execute(conn, QUERY)
def unrelated(conn):
    return QUERY
def engine_factory(config):
    return create_engine(URL.create("mssql", database=config.database))
def run():
    engine = engine_factory(target())
    with engine.begin() as conn:
        load(conn)
'''

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def prepare(self, source=None, *, job_name="load", flow_name="run", extra_jobs=()):
        (self.root / "job.py").write_text(source or self.SOURCE, encoding="utf-8")
        snapshot = snapshot_module.capture_snapshot(self.root, ["job.py"], source_id="python-job-io")
        analysis = analyzer.analyze_snapshot(snapshot)
        functions = {dict(c.attributes)["name"]: c for c in analysis.candidates if c.method == "python_ast_function"}
        flow = publisher.EntitySpec.create(kind="dataFlow", urn="urn:li:dataFlow:(python,fixture,DEV)",
                    platform="python", name="fixture", candidate_id=functions[flow_name].candidate_id)
        jobs = tuple(publisher.EntitySpec.create(kind="dataJob", urn=f"urn:li:dataJob:({flow.urn},{name})",
                    name=name, flow_urn=flow.urn, candidate_id=functions[name].candidate_id)
                    for name in (job_name, *extra_jobs))
        assets = [c for c in analysis.candidates if c.kind == "asset" and c.subject.startswith("dataset:")]
        datasets = {c.subject: publisher.EntitySpec.create(kind="dataset",
                    urn=f"urn:li:dataset:(urn:li:dataPlatform:mssql,{c.subject[8:]},DEV)",
                    platform="mssql", name=c.subject[8:], candidate_id=c.candidate_id, create_if_missing=False)
                    for c in assets}
        edges = []
        for c in analysis.candidates:
            if c.method != "sql_ast_dependency":
                continue
            relation = dict(c.attributes)["relation_type"]
            dataset = datasets[c.object].urn
            upstream, downstream = (dataset, jobs[0].urn) if relation == "reads" else (jobs[0].urn, dataset)
            edges.append(publisher.LineageSpec.create(upstream=upstream, downstream=downstream,
                         relation_type=relation, candidate_ids=(c.candidate_id,)))
        return snapshot, analysis, (flow, *jobs, *datasets.values()), tuple(edges)

    def plan(self, *args, **kwargs):
        snapshot, analysis, entities, edges = self.prepare(*args, **kwargs)
        return publisher.make_publication_plan(analysis, snapshot, entities=entities, lineages=edges)

    def compile(self, plan):
        return publisher.compile_publication_mcps(plan, root=str(self.root), paths=["job.py"], source_id="python-job-io")


class PythonJobIOTests(PythonJobIOFixture):
    def test_python_job_io_uses_bound_sql_execution_through_helper(self):
        plan = self.plan()
        records = self.compile(plan)
        io = next(m.aspect for m in records if m.aspectName == "dataJobInputOutput")
        self.assertEqual(io.inputDatasets, ["urn:li:dataset:(urn:li:dataPlatform:mssql,dbo.input_rows,DEV)"])
        self.assertEqual(io.outputDatasets, ["urn:li:dataset:(urn:li:dataPlatform:mssql,dm.output_rows,DEV)"])
        self.assertFalse(any(m.entityUrn.startswith("urn:li:dataset:") for m in records))
        self.assertIsNone(plan.approval)

    def test_unreachable_job_cannot_adopt_sql_from_reachable_sibling(self):
        with self.assertRaisesRegex(publisher.PublicationError, "lineage_candidate_binding_mismatch"):
            self.plan(job_name="unrelated")

    def test_returning_sql_text_and_callgraph_are_not_executing_sql(self):
        source = self.SOURCE.replace("execute(conn, QUERY)", "return QUERY")
        with self.assertRaisesRegex(publisher.PublicationError, "lineage_candidate_binding_mismatch"):
            self.plan(source)

    def test_unresolved_connection_cannot_authorize_job_io(self):
        source = self.SOURCE.replace('engine = engine_factory(target())', 'engine = unknown_factory()')
        with self.assertRaisesRegex(publisher.PublicationError, "lineage_candidate_binding_mismatch"):
            self.plan(source)

    def test_direct_factory_form_remains_unsupported_by_existing_trace(self):
        source = self.SOURCE.replace('engine = engine_factory(target())', 'engine = create_engine("mssql+pyodbc://fixture")')
        with self.assertRaisesRegex(publisher.PublicationError, "lineage_candidate_binding_mismatch"):
            self.plan(source)

    def test_called_job_cannot_be_attached_to_an_unrelated_flow(self):
        source = self.SOURCE + "\ndef other_run():\n    return 1\n"
        with self.assertRaisesRegex(publisher.PublicationError, "lineage_candidate_binding_mismatch"):
            self.plan(source, flow_name="other_run")

    def test_shadowed_helper_does_not_inherit_original_sql(self):
        source = self.SOURCE + "\nexecute = replacement\n"
        with self.assertRaisesRegex(publisher.PublicationError, "lineage_candidate_binding_mismatch"):
            self.plan(source)

    def test_two_sql_literals_on_one_line_do_not_share_evidence(self):
        source = self.SOURCE.replace('QUERY = text("INSERT INTO dm.output_rows (id) SELECT id FROM dbo.input_rows")',
                    'QUERY = text("INSERT INTO dm.output_rows (id) SELECT id FROM dbo.input_rows"); UNUSED = "SELECT id FROM dbo.decoy"')
        with self.assertRaisesRegex(publisher.PublicationError, "lineage_candidate_binding_mismatch"):
            self.plan(source)

    def test_nested_selected_job_owns_its_sql_not_the_parent_job(self):
        source = self.SOURCE.replace("def load(conn):\n    execute(conn, QUERY)",
                   "def inner(conn):\n    execute(conn, QUERY)\ndef load(conn):\n    inner(conn)")
        with self.assertRaisesRegex(publisher.PublicationError, "lineage_candidate_binding_mismatch"):
            self.plan(source, extra_jobs=("inner",))
        plan = self.plan(source, job_name="inner", extra_jobs=("load",))
        io = {m.entityUrn: m.aspect for m in self.compile(plan) if m.aspectName == "dataJobInputOutput"}
        inner = next(e.urn for e in plan.entities if e.kind == "dataJob" and e.name == "inner")
        outer = next(e.urn for e in plan.entities if e.kind == "dataJob" and e.name == "load")
        self.assertEqual(len(io[inner].inputDatasets), 1)
        self.assertNotIn(outer, io)

    def test_real_etl_direct_io_compiles_without_relabelling_all_source_tables(self):
        # Independent case expectations. The publisher never receives this map.
        expected = {
            "load_dimensions": ({"dm.dim_date", "dm.dim_territory", "dm.dim_product", "dm.dim_customer"},
                                {"dm.dim_date", "dm.dim_territory", "dm.dim_product", "dm.dim_customer"}),
            "load_sales_fact": ({"dm.fact_sales_order_line"}, {"dm.fact_sales_order_line"}),
            "validate_datamart": ({"dm.fact_sales_order_line", "dm.dim_date", "reporting.v_sales_order_line"}, set()),
        }
        source = (Path(__file__).resolve().parents[1] / "extensions/sales-datamart/src/sales_datamart/etl.py").read_text()
        (self.root / "job.py").write_text(source)
        snapshot = snapshot_module.capture_snapshot(self.root, ["job.py"], source_id="python-job-io")
        analysis = analyzer.analyze_snapshot(snapshot)
        selected = {c.candidate_id: c for c in analysis.candidates}
        functions = {dict(c.attributes)["name"]: c for c in analysis.candidates if c.method == "python_ast_function"}
        flow = publisher.EntitySpec.create(kind="dataFlow", urn="urn:li:dataFlow:(python,sales_datamart,PROD)",
                    platform="python", name="sales_datamart", env="PROD", candidate_id=functions["run_etl"].candidate_id)
        jobs = tuple(publisher.EntitySpec.create(kind="dataJob", urn=f"urn:li:dataJob:({flow.urn},{public})",
                    name=public, flow_urn=flow.urn, env="PROD", candidate_id=functions[function].candidate_id)
                    for function, public in [("_load_dimensions", "load_dimensions"),
                        ("_load_facts", "load_sales_fact"), ("_validate_target", "validate_datamart")])
        owners = publisher._python_job_sql_owners(SimpleNamespace(entities=(flow, *jobs)), selected, snapshot)
        grouped = {}
        for item in analysis.candidates:
            if item.method == "sql_ast_dependency":
                for job in jobs:
                    if (job.urn, item.subject) in owners:
                        grouped.setdefault((job.urn, dict(item.attributes)["relation_type"], item.object), []).append(item.candidate_id)
        asset_candidates = {c.subject:c for c in analysis.candidates if c.kind == "asset"}
        subjects = {subject for _, _, subject in grouped}
        datasets = {subject:publisher.EntitySpec.create(kind="dataset",
                    urn=f"urn:li:dataset:(urn:li:dataPlatform:mssql,salesdatamart.{subject[8:]},PROD)",
                    platform="mssql", name=f"salesdatamart.{subject[8:]}", env="PROD", create_if_missing=False,
                    candidate_id=asset_candidates[subject].candidate_id) for subject in subjects}
        edges = tuple(publisher.LineageSpec.create(
                    upstream=datasets[subject].urn if relation == "reads" else job,
                    downstream=job if relation == "reads" else datasets[subject].urn,
                    relation_type=relation, candidate_ids=ids)
                    for (job, relation, subject), ids in sorted(grouped.items()))
        plan = publisher.make_publication_plan(analysis, snapshot, entities=(flow, *jobs, *datasets.values()), lineages=edges)
        by_urn = {entity.urn:entity.name.removeprefix("salesdatamart.") for entity in datasets.values()}
        io = {m.entityUrn:m.aspect for m in self.compile(plan) if m.aspectName == "dataJobInputOutput"}
        observed = {job.name:({by_urn[u] for u in io[job.urn].inputDatasets},
                            {by_urn[u] for u in io[job.urn].outputDatasets}) for job in jobs}
        self.assertEqual(observed, expected)
        self.assertEqual(len(edges), 13)
        self.assertEqual(len(datasets), 6)
        self.assertTrue(all(use["execution_verified"] is False for uses in owners.values() for use in uses))
        # Extraction sits outside these three Jobs. Do not pretend this direct
        # SQL seam proves the separate record/lookup transfer into each Job.
        self.assertFalse(any("SalesOrderHeader" in subject or "ProductCategory" in subject for subject in subjects))

    def test_actual_sql_rename_rejects_old_plan_and_updates_new_io(self):
        original = self.plan()
        changed = self.SOURCE.replace("dbo.input_rows", "dbo.renamed_rows")
        replacement = self.plan(changed)
        with patch.object(publisher, "_entity_object") as construct:
            with self.assertRaises(publisher.PublicationError):
                self.compile(original)
            construct.assert_not_called()
        io = next(m.aspect for m in self.compile(replacement) if m.aspectName == "dataJobInputOutput")
        self.assertEqual(io.inputDatasets, ["urn:li:dataset:(urn:li:dataPlatform:mssql,dbo.renamed_rows,DEV)"])
        self.assertNotEqual(original.candidate_digest, replacement.candidate_digest)


class PythonResourcePublicationTests(PythonJobIOFixture):
    SOURCE = '''from dataclasses import dataclass
@dataclass(frozen=True)
class Event:
    metric: int
def fetch(conn, statement):
    result = conn.execute(statement)
    return list(result.mappings().all())
def decode(rows):
    return [Event(row["value"]) for row in rows]
def load(conn, events):
    parameters = [{"value":event.metric} for event in events]
    conn.execute("UPDATE dbo.ReceivedEvents SET Amount=:value", parameters)
def run(source, target):
    with source.connect() as incoming:
        events = decode(fetch(incoming, "SELECT Amount AS value FROM dbo.Orders"))
        with target.begin() as outgoing:
            load(outgoing, events)
'''
    def prepare(self, source=None, *, job_name="load", flow_name="run", extra_jobs=()):
        from dataflow_discovery.python_catalog import bind_python_sql_dependencies
        from dataflow_discovery.catalog import MssqlScope
        from tests.test_dataflow_discovery_catalog import Reader
        snapshot, analysis, entities, edges = PythonJobIOFixture.prepare(
            self, source or self.SOURCE, job_name=job_name, flow_name=flow_name, extra_jobs=extra_jobs)
        source_urn = 'urn:li:dataset:(urn:li:dataPlatform:mssql,lab.dbo.orders,PROD)'
        target_urn = 'urn:li:dataset:(urn:li:dataPlatform:mssql,target.dbo.receivedevents,PROD)'
        source_urns = (source_urn, *getattr(self, 'extra_inputs', ()))
        self.reader = Reader([*source_urns, target_urn])
        described = bind_python_sql_dependencies(analysis, snapshot, path='job.py', entrypoint='run', scopes_by_context={}, reader=self.reader)
        scopes = {c['context_id']:MssqlScope(database, 'dbo', 'PROD', True, True, urns)
                  for c,(database,urns) in zip(described['contexts'], [('Lab', source_urns), ('Target', (target_urn,))], strict=True)}
        self.context = {'path':'job.py', 'entrypoint':'run', 'scopes_by_context':scopes}
        bound = bind_python_sql_dependencies(analysis, snapshot, reader=self.reader, **self.context)
        self.assertTrue(all(c['status'] == 'CATALOG_BOUND' for c in bound['contexts']))
        identities = {b['dataset_subject']:b['dataset']['urn'] for c in bound['contexts'] for b in c['bindings']}
        selected = {c.candidate_id:c for c in analysis.candidates}
        changed = {e.urn:identities[selected[e.candidate_id].subject] for e in entities if e.kind == 'dataset'}
        entities = tuple(replace(e, urn=changed[e.urn]) if e.kind == 'dataset' else e for e in entities)
        edges = tuple(replace(e, upstream=changed.get(e.upstream,e.upstream), downstream=changed.get(e.downstream,e.downstream)) for e in edges)
        return snapshot, analysis, entities, edges

    def plan(self, source=None):
        snapshot, analysis, entities, edges = self.prepare(source)
        return publisher.make_publication_plan(analysis, snapshot, entities=entities, lineages=edges,
                        python_analysis=self.context, catalog_reader=self.reader)

    def compile(self, plan):
        return publisher.compile_publication_mcps(plan, root=str(self.root), paths=['job.py'], source_id='python-job-io',
                        python_analysis=self.context, catalog_reader=self.reader)

    def test_record_source_reaches_job_without_faking_direct_sql_execution(self):
        snapshot, analysis, entities, edges = self.prepare()
        with self.assertRaisesRegex(publisher.PublicationError, 'lineage_candidate_binding_mismatch'):
            publisher.make_publication_plan(analysis, snapshot, entities=entities, lineages=edges)
        plan = publisher.make_publication_plan(analysis, snapshot, entities=entities, lineages=edges,
                        python_analysis=self.context, catalog_reader=self.reader)
        io, = [m.aspect for m in self.compile(plan) if m.aspectName == 'dataJobInputOutput']
        self.assertEqual(io.inputDatasets, ['urn:li:dataset:(urn:li:dataPlatform:mssql,lab.dbo.orders,PROD)'])
        self.assertEqual(io.outputDatasets, ['urn:li:dataset:(urn:li:dataPlatform:mssql,target.dbo.receivedevents,PROD)'])
        self.assertIsNone(plan.approval)
        self.assertTrue(all(not edge.column_mapping for edge in plan.lineages))

    def test_read_only_selection_does_not_need_to_approve_the_consuming_write(self):
        snapshot, analysis, entities, edges = self.prepare()
        entities = tuple(e for e in entities if e.kind != 'dataset' or 'lab.' in e.urn)
        edges = tuple(e for e in edges if e.relation_type == 'reads')
        plan = publisher.make_publication_plan(analysis, snapshot, entities=entities, lineages=edges,
                        python_analysis=self.context, catalog_reader=self.reader)
        io, = [m.aspect for m in self.compile(plan) if m.aspectName == 'dataJobInputOutput']
        self.assertEqual(io.inputDatasets, ['urn:li:dataset:(urn:li:dataPlatform:mssql,lab.dbo.orders,PROD)'])
        self.assertFalse(io.outputDatasets)

    def test_shared_sql_owners_remain_bound_to_the_specific_connection_invocation(self):
        from dataflow_discovery.python_catalog import bind_python_sql_dependencies
        from dataflow_discovery.catalog import MssqlScope
        from tests.test_dataflow_discovery_catalog import Reader
        source = '''def query(conn):
    conn.execute("SELECT OrderID FROM dbo.Orders")
def left(engine):
    with engine.connect() as conn:
        query(conn)
def right(engine):
    with engine.connect() as conn:
        query(conn)
def run(first, second):
    left(first)
    right(second)
'''
        snapshot, analysis, entities, edges = PythonJobIOFixture.prepare(self, source, job_name='left', extra_jobs=('right',))
        left = next(e for e in entities if e.kind == 'dataJob' and e.name == 'left')
        right = next(e for e in entities if e.kind == 'dataJob' and e.name == 'right')
        raw = next(e for e in entities if e.kind == 'dataset')
        first = 'urn:li:dataset:(urn:li:dataPlatform:mssql,first.dbo.orders,PROD)'
        second = first.replace('first.', 'second.')
        self.reader = Reader([first, second])
        contexts = bind_python_sql_dependencies(analysis, snapshot, path='job.py', entrypoint='run', scopes_by_context={}, reader=self.reader)['contexts']
        self.context = {'path':'job.py', 'entrypoint':'run', 'scopes_by_context':{
            c['context_id']:MssqlScope(db, 'dbo', 'PROD', True, True, (urn,))
            for c,db,urn in zip(contexts, ['first','second'], [first,second], strict=True)}}
        for dataset, owner, foreign in [(first,left,right),(second,right,left)]:
            chosen = tuple(replace(e, urn=dataset) if e == raw else e for e in entities)
            correct = (replace(edges[0], upstream=dataset, downstream=owner.urn),)
            plan = publisher.make_publication_plan(analysis, snapshot, entities=chosen, lineages=correct,
                python_analysis=self.context, catalog_reader=self.reader)
            self.compile(plan)
            with self.subTest(dataset=dataset), self.assertRaisesRegex(publisher.PublicationError, 'python_resource_candidate_binding_mismatch'):
                publisher.make_publication_plan(analysis, snapshot, entities=chosen,
                    lineages=(replace(correct[0], downstream=foreign.urn),),
                    python_analysis=self.context, catalog_reader=self.reader)

        # One source symbol may identify two physical resources only through the
        # trusted invocation-specific scopes, never a global subject->URN guess.
        both = tuple(e for e in entities if e != raw) + (replace(raw, urn=first), replace(raw, urn=second))
        paired = (replace(edges[0], upstream=first, downstream=left.urn),
                  replace(edges[0], upstream=second, downstream=right.urn))
        plan = publisher.make_publication_plan(analysis, snapshot, entities=both, lineages=paired,
                    python_analysis=self.context, catalog_reader=self.reader)
        restored = publisher.PublicationPlan.from_dict(plan.to_dict())
        ios = {m.entityUrn:m.aspect for m in self.compile(restored) if m.aspectName == 'dataJobInputOutput'}
        self.assertEqual(ios[left.urn].inputDatasets, [first])
        self.assertEqual(ios[right.urn].inputDatasets, [second])
        self.assertTrue(all(not e.column_mapping for e in plan.lineages))
        self.assertIsNone(plan.approval)
        with self.assertRaisesRegex(publisher.PublicationError, 'ambiguous_subject_identity'):
            publisher.make_publication_plan(analysis, snapshot, entities=both, lineages=paired)
        with patch.object(publisher, '_entity_object') as sdk:
            with self.assertRaisesRegex(publisher.PublicationError, 'ambiguous_subject_identity'):
                PythonJobIOFixture.compile(self, restored)
            sdk.assert_not_called()
        swapped = tuple(replace(edge, upstream=second if edge.upstream == first else first) for edge in paired)
        with self.assertRaisesRegex(publisher.PublicationError, 'python_resource_candidate_binding_mismatch'):
            publisher.make_publication_plan(analysis, snapshot, entities=both, lineages=swapped,
                        python_analysis=self.context, catalog_reader=self.reader)
        from datahub.metadata.schema_classes import StatusClass
        self.reader.aspects[second, StatusClass].removed = True
        with patch.object(publisher, '_entity_object') as sdk:
            with self.assertRaisesRegex(publisher.PublicationError, 'python_resource_entity_binding_mismatch'):
                self.compile(restored)
            sdk.assert_not_called()

    def test_same_query_in_two_namespaces_transfers_only_the_selected_record_stream(self):
        from dataflow_discovery.python_catalog import bind_python_sql_dependencies
        from dataflow_discovery.catalog import MssqlScope
        from tests.test_dataflow_discovery_catalog import Reader
        prefix = self.SOURCE[:self.SOURCE.index('def run(')]
        entry = '''QUERY = "SELECT Amount AS value FROM dbo.Orders"
def run(first, second, target):
    with first.connect() as a, second.connect() as b, target.begin() as out:
        first_events = decode(fetch(a, QUERY))
        second_events = decode(fetch(b, QUERY))
        load(out, SELECTED)
'''
        urns = [f'urn:li:dataset:(urn:li:dataPlatform:mssql,{name}.dbo.orders,PROD)' for name in ('first','second')]
        target = 'urn:li:dataset:(urn:li:dataPlatform:mssql,target.dbo.receivedevents,PROD)'
        for chosen, forwarded in ((0,False),(1,False),(0,True),(1,True)):
            with self.subTest(chosen=chosen, forwarded=forwarded):
                program = prefix + entry.replace('SELECTED', ('first_events','second_events')[chosen])
                if forwarded:
                    parameter = ('one','two')[chosen]
                    program = f'def choose(*, one, two):\n    return {parameter}\n' + prefix + entry.replace(
                        'SELECTED', 'choose(one=first_events, two=second_events)')
                snapshot, analysis, entities, edges = PythonJobIOFixture.prepare(self, program)
                order_asset = next(e for e in entities if e.kind == 'dataset' and 'Orders' in e.urn)
                target_asset = next(e for e in entities if e.kind == 'dataset' and e != order_asset)
                both = tuple(e for e in entities if e.kind != 'dataset') + (
                    replace(order_asset, urn=urns[0]), replace(order_asset, urn=urns[1]), replace(target_asset, urn=target))
                self.reader = Reader([*urns, target])
                contexts = bind_python_sql_dependencies(analysis, snapshot, path='job.py', entrypoint='run', scopes_by_context={}, reader=self.reader)['contexts']
                self.context = {'path':'job.py', 'entrypoint':'run', 'scopes_by_context':{
                    c['context_id']:MssqlScope(db, 'dbo', 'PROD', True, True, (urn,))
                    for c,db,urn in zip(contexts, ['first','second','target'], [*urns,target], strict=True)}}
                correct = tuple(replace(edge, upstream=urns[chosen]) if edge.relation_type == 'reads'
                                else replace(edge, downstream=target) for edge in edges)
                plan = publisher.make_publication_plan(analysis, snapshot, entities=both, lineages=correct,
                            python_analysis=self.context, catalog_reader=self.reader)
                io, = [m.aspect for m in self.compile(plan) if m.aspectName == 'dataJobInputOutput']
                self.assertEqual(io.inputDatasets, [urns[chosen]])
                self.assertEqual(io.outputDatasets, [target])
                forged = tuple(replace(edge, upstream=urns[1-chosen]) if edge.relation_type == 'reads' else edge for edge in correct)
                with self.assertRaisesRegex(publisher.PublicationError, 'python_resource_candidate_binding_mismatch'):
                    publisher.make_publication_plan(analysis, snapshot, entities=both, lineages=forged,
                                python_analysis=self.context, catalog_reader=self.reader)

    def test_plain_parameter_forwarding_is_not_an_unknown_helper_effect(self):
        forwarding = 'def relay(*, values):\n    return values\n'
        source = forwarding + self.SOURCE.replace('load(outgoing, events)', 'load(outgoing, relay(values=events))')
        plan = self.plan(source)
        io, = [m.aspect for m in self.compile(plan) if m.aspectName == 'dataJobInputOutput']
        self.assertEqual(io.inputDatasets, ['urn:li:dataset:(urn:li:dataPlatform:mssql,lab.dbo.orders,PROD)'])
        self.assertIsNone(plan.approval)
        reused = forwarding + self.SOURCE.replace('            load(outgoing, events)',
            '            relay(values=events)\n            load(outgoing, events)')
        self.plan(reused)
        self.plan(source.replace('    return values', '    """Return this parameter without evaluating an operation."""\n    return values'))
        variants = [
            reused.replace('def run(source, target):', 'def run(source, target, relay):'),
            reused.replace('    return values', '    opaque(values)\n    return values'),
            source.replace('    return values', '    opaque(values)\n    return values'),
            source.replace('    return values', '    values.clear()\n    return values'),
            source.replace('    return values', '    if values:\n        return values'),
            source.replace('def relay', '@decorate\ndef relay'),
            source.replace('    return values', '    return []'),
            source.replace('    return values', '    return values[:]'),
        ]
        for variant in variants:
            with self.subTest(variant=variant), self.assertRaises(publisher.PublicationError):
                self.plan(variant)

    def test_consumed_query_join_dependency_is_not_lost_without_value_column(self):
        self.extra_inputs = ('urn:li:dataset:(urn:li:dataPlatform:mssql,lab.dbo.rules,PROD)',)
        source = self.SOURCE.replace('SELECT Amount AS value FROM dbo.Orders',
            'SELECT o.Amount AS value FROM dbo.Orders o JOIN dbo.Rules r ON o.OrderID=r.OrderID')
        plan = self.plan(source)
        io, = [m.aspect for m in self.compile(plan) if m.aspectName == 'dataJobInputOutput']
        self.assertEqual(set(io.inputDatasets), {
            'urn:li:dataset:(urn:li:dataPlatform:mssql,lab.dbo.orders,PROD)', self.extra_inputs[0]})
        self.assertTrue(all(not edge.column_mapping for edge in plan.lineages))

    def test_query_literal_column_still_transports_a_table_resource(self):
        # No physical input column provides this value. Query-result rows still
        # come from Orders; table I/O must not require fabricated column origins.
        plan = self.plan(self.SOURCE.replace('SELECT Amount AS value', 'SELECT 1 AS value'))
        io, = [m.aspect for m in self.compile(plan) if m.aspectName == 'dataJobInputOutput']
        self.assertEqual(io.inputDatasets, ['urn:li:dataset:(urn:li:dataPlatform:mssql,lab.dbo.orders,PROD)'])
        self.assertTrue(all(not edge.column_mapping for edge in plan.lineages))

    def test_lookup_resource_does_not_require_claiming_scalar_conversion_correct(self):
        prefix = self.SOURCE[:self.SOURCE.index('def run(')].replace(
            'parameters = [{"value":event.metric} for event in events]', 'parameters = {"value":events[1]}')
        entry = '''def run(source, target):
    with source.connect() as incoming:
        rows = fetch(incoming, "SELECT OrderID AS id, Amount AS value FROM dbo.Orders")
        mapping = {row["id"]:VALUE for row in rows}
        with target.begin() as outgoing:
            load(outgoing, mapping)
'''
        for value in ['row["value"]', 'constant(row["value"])']:
            with self.subTest(value=value):
                source = 'def constant(ignored):\n    return 0\n' + prefix + entry.replace('VALUE', value)
                plan = self.plan(source)
                io, = [m.aspect for m in self.compile(plan) if m.aspectName == 'dataJobInputOutput']
                self.assertEqual(io.inputDatasets, ['urn:li:dataset:(urn:li:dataPlatform:mssql,lab.dbo.orders,PROD)'])
                self.assertTrue(all(not edge.column_mapping for edge in plan.lineages))
                self.assertIsNone(plan.approval)

    def test_compilation_without_host_context_cannot_reuse_resource_plan(self):
        plan = self.plan()
        with self.assertRaises(publisher.PublicationError), patch.object(publisher, '_entity_object') as sdk:
            PythonJobIOFixture.compile(self, plan)
        sdk.assert_not_called()

    def test_discarded_mutated_or_wrong_record_field_is_not_published(self):
        sources = [self.SOURCE.replace('        with target.begin()', f'        {change}\n        with target.begin()')
                   for change in ['events = []', 'events.clear()']]
        sources.append(self.SOURCE.replace('event.metric', 'event.not_a_field'))
        for source in sources:
            with self.subTest(source=source), self.assertRaisesRegex(publisher.PublicationError, 'python_resource_candidate_binding_mismatch'):
                self.plan(source)

    def _assert_invalidated_payload_keeps_prior_declarations(self, source):
        from dataflow_discovery.python_lookup_values import bind_python_lookup_values
        source = source.replace('    conn.execute("UPDATE', '    opaque(parameters)\n    conn.execute("UPDATE')
        snapshot, analysis, entities, edges = self.prepare(source)
        report = bind_python_lookup_values(analysis, snapshot, reader=self.reader, **self.context)
        slots = [slot for context in report['contexts'] for statement in context['write_statements'] for slot in statement['slots']]
        self.assertTrue(slots)
        for slot in slots:
            self.assertTrue(slot['python_declarations'])
            self.assertEqual(slot['parameter_declaration_status'], 'PRIOR_DECLARATIONS_ONLY')
            self.assertTrue(all(d['collection_findings'] for d in slot['python_declarations']))
            self.assertTrue(slot['record_consumer']['links'])
            self.assertTrue(all(link['consumer_role'] == 'prior_declaration' and link['chain_findings']
                                for link in slot['record_consumer']['links']))
        with self.assertRaisesRegex(publisher.PublicationError, 'python_resource_candidate_binding_mismatch'):
            publisher.make_publication_plan(analysis, snapshot, entities=entities, lineages=edges,
                            python_analysis=self.context, catalog_reader=self.reader)

    def test_invalidated_payload_keeps_prior_declarations_but_cannot_publish(self):
        self._assert_invalidated_payload_keeps_prior_declarations(self.SOURCE)

    def test_invalidated_append_payload_retains_its_prior_fields(self):
        source = self.SOURCE.replace('parameters = [{"value":event.metric} for event in events]',
            'parameters = []\n    for event in events:\n        parameters.append({"value":event.metric})')
        self._assert_invalidated_payload_keeps_prior_declarations(source)

    def test_invalidated_lookup_payload_does_not_drop_collection_findings(self):
        from dataflow_discovery.python_lookup_values import bind_python_lookup_values
        prefix = self.SOURCE[:self.SOURCE.index('def run(')].replace(
            'parameters = [{"value":event.metric} for event in events]',
            'parameters = {"value":events[1]}\n    opaque(parameters)')
        source = prefix + '''def run(source, target):
    with source.connect() as incoming:
        rows = fetch(incoming, "SELECT OrderID AS id, Amount AS value FROM dbo.Orders")
        mapping = {row["id"]:row["value"] for row in rows}
        with target.begin() as outgoing:
            load(outgoing, mapping)
'''
        snapshot, analysis, entities, edges = self.prepare(source)
        report = bind_python_lookup_values(analysis, snapshot, reader=self.reader, **self.context)
        declarations = [d for c in report['contexts'] for stmt in c['write_statements']
                        for slot in stmt['slots'] for d in slot['lookup_values']['declarations']]
        self.assertTrue(declarations)
        self.assertTrue(all(d['consumer_role'] == 'prior_declaration' and d['chain_findings'] for d in declarations))
        with self.assertRaisesRegex(publisher.PublicationError, 'python_resource_candidate_binding_mismatch'):
            publisher.make_publication_plan(analysis, snapshot, entities=entities, lineages=edges,
                            python_analysis=self.context, catalog_reader=self.reader)

    def test_parameter_reassignment_does_not_erase_an_earlier_escape(self):
        source = self.SOURCE.replace('def load(conn, events):',
            'def load(conn, events):\n    opaque(events)\n    events = events')
        with self.assertRaisesRegex(publisher.PublicationError, 'python_resource_candidate_binding_mismatch'):
            self.plan(source)

    def test_unknown_call_escape_cannot_prove_unchanged_resource(self):
        source = self.SOURCE.replace('        with target.begin()', '        opaque(events)\n        with target.begin()')
        with self.assertRaisesRegex(publisher.PublicationError, 'python_resource_candidate_binding_mismatch'):
            self.plan(source)

    def test_alias_local_helper_and_closure_effects_are_not_bypasses(self):
        changes = [
            'alias = events\n        alias.clear()',
            'alias = events\n        opaque(alias)',
            'box = {"items":events}\n        opaque(box)',
            'def mutate():\n            events.clear()\n        mutate()',
            'mutate(events)',
        ]
        for change in changes:
            source = self.SOURCE.replace('        with target.begin()', f'        {change}\n        with target.begin()')
            source += '\ndef mutate(values):\n    values.clear()\n'
            with self.subTest(change=change), self.assertRaisesRegex(publisher.PublicationError, 'python_resource_candidate_binding_mismatch'):
                self.plan(source)

    def test_plain_record_constructor_exemption_does_not_ignore_local_shadowing(self):
        source = self.SOURCE.replace('        with target.begin()', '        Event(events)\n        with target.begin()')
        self.plan(source)  # Supported dataclass constructor does not mutate its argument.
        with self.assertRaisesRegex(publisher.PublicationError, 'python_resource_candidate_binding_mismatch'):
            self.plan(source.replace('def run(source, target):', 'def run(source, target, Event):'))

    def test_forged_catalog_identity_is_not_just_a_matching_raw_table_name(self):
        snapshot, analysis, entities, edges = self.prepare()
        old = next(e.urn for e in entities if e.kind == 'dataset' and 'lab.' in e.urn)
        forged = old.replace('lab.', 'impostor.')
        entities = tuple(replace(e, urn=forged) if e.urn == old else e for e in entities)
        edges = tuple(replace(e, upstream=forged) if e.upstream == old else e for e in edges)
        with self.assertRaisesRegex(publisher.PublicationError, 'python_resource_entity_binding_mismatch'):
            publisher.make_publication_plan(analysis, snapshot, entities=entities, lineages=edges,
                            python_analysis=self.context, catalog_reader=self.reader)

    def test_missing_catalog_input_column_is_checked_again_before_sdk(self):
        from datahub.metadata.schema_classes import SchemaMetadataClass
        from tests.test_dataflow_discovery_catalog import schema
        plan = self.plan()
        source = next(e.urn for e in plan.entities if e.kind == 'dataset' and 'lab.' in e.urn)
        self.reader.aspects[source, SchemaMetadataClass] = schema(('orderid',))
        with patch.object(publisher, '_entity_object') as sdk:
            with self.assertRaises(publisher.PublicationError):
                self.compile(plan)
            sdk.assert_not_called()

    def test_readonly_validator_and_comprehension_shadowing_preserve_resource(self):
        validator = '''def inspect_items(items):
    for row in items:
        if row.metric < 0:
            raise ValueError("negative")
    unrelated = []
    result = [row.get("id") for row in unrelated]
    return None
'''
        source = validator + self.SOURCE.replace('        with target.begin()',
            '        inspect_items(events)\n        with target.begin()')
        plan = self.plan(source)
        io, = [m.aspect for m in self.compile(plan) if m.aspectName == 'dataJobInputOutput']
        self.assertEqual(io.inputDatasets, ['urn:li:dataset:(urn:li:dataPlatform:mssql,lab.dbo.orders,PROD)'])
        self.assertIsNone(plan.approval)
        self.assertTrue(all(not edge.column_mapping for edge in plan.lineages))
        # The same loop name is not harmless if this comprehension really reads
        # the original records and passes them to an opaque callable.
        for mutation in ['result = [opaque(row) for row in items]',
                         'result = [row.get("id") for row in items]']:
            changed = source.replace('result = [row.get("id") for row in unrelated]', mutation)
            with self.subTest(mutation=mutation), self.assertRaises(publisher.PublicationError):
                self.plan(changed)

    def test_local_validator_mutation_escape_property_and_recursive_effects_reject(self):
        bodies = [
            'items.clear()',
            'alias = items\n    alias += []',
            '(alias := items)\n    alias.clear()',
            'match items:\n        case [alias]:\n            alias.metric = 0',
            'import other as items',
            'class items:\n        pass',
            'opaque(items)',
            'class Capture:\n        items.clear()',
            'with items:\n        pass',
            'inspect_items(items)',
            'for row in items:\n        row.metric = 0',
            'for row in items:\n        row.side_effect',
        ]
        # Property bodies are not assumed to be passive field loads.
        base = self.SOURCE.replace('    metric: int',
            '    metric: int\n    @property\n    def side_effect(self):\n        opaque(self)')
        for body in bodies:
            source = f'def inspect_items(items):\n    {body}\n' + base.replace(
                '        with target.begin()', '        inspect_items(events)\n        with target.begin()')
            with self.subTest(body=body), self.assertRaises(publisher.PublicationError):
                self.plan(source)

    def test_record_getter_decimal_result_is_not_the_mutable_record_receiver(self):
        source = 'from decimal import Decimal\n' + self.SOURCE.replace('    metric: int',
            '    metric: int\n    @property\n    def total(self):\n'
            '        return sum((self.metric,), Decimal("0")).quantize(Decimal("0.000001"))')
        source = ('def inspect_items(items):\n    for item in items:\n        item.total\n' + source).replace(
            '        with target.begin()', '        inspect_items(events)\n        with target.begin()')
        plan = self.plan(source)
        self.compile(plan)
        self.assertTrue(all(not edge.column_mapping for edge in plan.lineages))
        for changed in [
            source.replace('sum((self.metric,), Decimal("0"))', 'opaque(self)'),
            source.replace('    def total(self):\n', '    def total(self):\n        Decimal = opaque\n'),
            'def sum(*args):\n    return opaque(args)\n' + source,
        ]:
            with self.subTest(source=changed), self.assertRaises(publisher.PublicationError):
                self.plan(changed)

    def test_unguarded_return_uses_its_graph_without_losing_finally_effects(self):
        source = self.SOURCE.replace('def run(source, target):', '''def produce(source):
    with source.connect() as incoming:
        events = decode(fetch(incoming, "SELECT Amount AS value FROM dbo.Orders"))
    return events
def run(source, target):''').replace(
            '        events = decode(fetch(incoming, "SELECT Amount AS value FROM dbo.Orders"))\n        with target.begin()',
            '        events = produce(source)\n        with target.begin()')
        self.compile(self.plan(source))
        for returned in [
            'opaque(events)\n    return events',
            'try:\n        return events\n    finally:\n        events.clear()',
        ]:
            with self.subTest(returned=returned), self.assertRaises(publisher.PublicationError):
                self.plan(source.replace('    return events', '    ' + returned))

    def test_removed_catalog_asset_is_checked_again_before_sdk(self):
        from datahub.metadata.schema_classes import StatusClass
        plan = self.plan()
        source = next(e.urn for e in plan.entities if e.kind == 'dataset' and 'lab.' in e.urn)
        self.reader.aspects[source, StatusClass].removed = True
        with patch.object(publisher, '_entity_object') as sdk:
            with self.assertRaises(publisher.PublicationError):
                self.compile(plan)
            sdk.assert_not_called()


if __name__ == "__main__":
    unittest.main()
