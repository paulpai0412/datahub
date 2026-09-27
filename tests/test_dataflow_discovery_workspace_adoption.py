from __future__ import annotations

from contextlib import redirect_stdout
from io import BytesIO, StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import json
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions/dataflow-discovery/src"))
from dataflow_discovery.publisher import PublicationError, compile_workspace_lineage
from dataflow_discovery.workspace import _workflow_preview
from dataflow_discovery import bridge


SOURCE = "urn:li:dataset:(urn:li:dataPlatform:mssql,example.dbo.source,PROD)"
TARGET = "urn:li:dataset:(urn:li:dataPlatform:mssql,example.dbo.target,PROD)"
EXISTING_FLOW = "urn:li:dataFlow:(python,existing_etl,PROD)"
EXISTING_JOB = f"urn:li:dataJob:({EXISTING_FLOW},load)"
SHA = "a" * 64


def case():
    analysis = SimpleNamespace(source_id="example", digest="b" * 64, analysis_version="1.0.3")
    snapshot = SimpleNamespace(sha256=SHA)
    report = {
        "source_id": analysis.source_id, "snapshot_sha256": SHA,
        "candidate_digest": analysis.digest, "path": "job.py", "entrypoint": "run",
        "output_partition": {"complete": True, "fields": []},
        "trace_findings": [], "contexts": [],
    }
    workflow = {
        "coverage": {"sqlOwnershipComplete": True},
        "flow": {"id": "python-flow:" + "c" * 64, "name": "run", "candidateId": "flow"},
        "jobs": [
            {"id": "python-step:" + "d" * 64, "name": "extract", "candidateId": "extract",
             "evidence": {"path": "job.py", "line": 2, "endLine": 3, "fileSha256": SHA},
             "contexts": [], "invocations": [], "reads": [{"urn": SOURCE}], "writes": []},
            {"id": "python-step:" + "e" * 64, "name": "load", "candidateId": "load",
             "evidence": {"path": "job.py", "line": 4, "endLine": 5, "fileSha256": SHA},
             "contexts": [], "invocations": [], "reads": [{"urn": SOURCE}], "writes": [{"urn": TARGET}]},
        ],
        "dependencies": [
            {"from": "python-step:" + "d" * 64, "to": "python-step:" + "e" * 64,
             "method": "record_transfer", "contextPairs": []},
        ],
    }
    adoption = {"snapshotSha256": SHA, "flowUrn": EXISTING_FLOW,
                "jobs": {"load": EXISTING_JOB}, "evidenceOnly": ["extract"],
                "nativeVersions": {
                    EXISTING_FLOW: {"dataFlowKey": "1", "dataFlowInfo": "1"},
                    EXISTING_JOB: {"dataJobKey": "1", "dataJobInfo": "1", "dataJobInputOutput": "2"},
                }, "relatedCatalogUrns": []}
    return analysis, snapshot, report, workflow, adoption


class WorkspaceAdoptionTests(unittest.TestCase):
    def test_existing_flow_and_job_keep_native_identity_and_unmapped_read_proof(self):
        analysis, snapshot, report, workflow, adoption = case()
        result = compile_workspace_lineage(analysis, snapshot, report, workflow, env="PROD", adoption=adoption)
        self.assertEqual(result["flowUrn"], EXISTING_FLOW)
        self.assertEqual(list(result["jobUrns"].values()), [EXISTING_JOB])
        self.assertFalse(result["publicationAuthorized"])
        self.assertEqual(len(result["aspects"]), 3)
        flow_info = next(item for item in result["aspects"] if item["aspect"] == "dataFlowInfo")
        job_info = next(item for item in result["aspects"] if item["aspect"] == "dataJobInfo")
        job_io = next(item for item in result["aspects"] if item["aspect"] == "dataJobInputOutput")
        self.assertEqual(set(flow_info["value"]), {"customProperties"})
        self.assertIn("datahub_etl.evidenceOnlyJobs", flow_info["value"]["customProperties"])
        self.assertIn(SOURCE, flow_info["value"]["customProperties"]["datahub_etl.evidenceOnlyJobs"])
        self.assertEqual(job_info["value"]["customProperties"]["datahub_etl.sourceFunction"], "load")
        self.assertEqual(set(job_info["value"]), {"customProperties"})
        self.assertEqual(job_io["urn"], EXISTING_JOB)
        self.assertEqual(job_io["value"]["inputDatasets"], [SOURCE])
        self.assertEqual(job_io["value"]["outputDatasets"], [TARGET])
        self.assertEqual(job_io["value"].get("inputDatajobs", []), [])
        self.assertIn("extract", result["candidateIds"])

    def test_evidence_only_job_remains_visible_without_a_native_urn(self):
        analysis, snapshot, report, workflow, adoption = case()
        workflow["flow"]["evidence"] = {"path": "job.py", "line": 1}
        workflow["controls"] = []
        workflow["blockers"] = []
        compiled = compile_workspace_lineage(analysis, snapshot, report, workflow, env="PROD", adoption=adoption)
        graph = {"nodes": [{"id": SOURCE}, {"id": TARGET}]}
        preview = _workflow_preview(workflow, graph, compiled)
        self.assertEqual(preview["flow"]["urn"], EXISTING_FLOW)
        self.assertEqual([(job["name"], job["urn"]) for job in preview["jobs"]],
                         [("extract", None), ("load", EXISTING_JOB)])
        self.assertEqual(preview["dependencies"][0]["from"], 0)
        self.assertEqual(preview["dependencies"][0]["to"], 1)

    def test_adoption_does_not_change_default_new_flow_compilation(self):
        analysis, snapshot, report, workflow, _ = case()
        result = compile_workspace_lineage(analysis, snapshot, report, workflow, env="PROD")
        self.assertNotEqual(result["flowUrn"], EXISTING_FLOW)
        self.assertEqual(len(result["jobUrns"]), 2)

    def test_workspace_bridge_admits_bounded_preview_but_rejects_oversize(self):
        input_bytes = json.dumps({"operation": "workspace_analyze", "policy": {}, "request": {}}).encode()

        def run(length):
            stub = {"preview": "x" * (length - len('{"preview":""}'))}
            self.assertEqual(len(json.dumps(stub, separators=(",", ":")).encode()), length)
            stdout = StringIO()
            with (patch.object(bridge.sys, "stdin", SimpleNamespace(buffer=BytesIO(input_bytes))),
                  patch.object(bridge.importlib, "import_module", return_value=SimpleNamespace(
                      analyze_workspace_selection=lambda *args, **kwargs: stub)),
                  redirect_stdout(stdout)):
                code = bridge.main()
            return code, json.loads(stdout.getvalue())

        self.assertEqual(run(57000)[0], 0)
        self.assertEqual(run(58001), (2, {"error": "discovery_workspace_too_large"}))

    def test_stale_or_unproven_mapping_fails_closed(self):
        for mutate, code in [
            (lambda a, w: a.update(snapshotSha256="0" * 64), "workspace_compiler_source_mismatch"),
            (lambda a, w: a.update(flowUrn="urn:li:dataFlow:(python,other,DEV)"), "workspace_adoption_invalid"),
            (lambda a, w: a["jobs"].update(load="urn:li:dataJob:(urn:li:dataFlow:(python,other,PROD),load)"), "workspace_adoption_invalid"),
            (lambda a, w: a.update(evidenceOnly=[]), "workspace_adoption_invalid"),
            (lambda a, w: a.update(relatedCatalogUrns=["urn:li:dataset:unexpected"]), "workspace_adoption_invalid"),
            (lambda a, w: w["jobs"][0]["writes"].append({"urn": TARGET}), "workspace_adoption_unproven"),
            (lambda a, w: w["jobs"][1].update(reads=[]), "workspace_adoption_unproven"),
            (lambda a, w: w.update(dependencies=[]), "workspace_adoption_unproven"),
        ]:
            with self.subTest(code=code, mutate=mutate):
                analysis, snapshot, report, workflow, adoption = case()
                mutate(adoption, workflow)
                with self.assertRaisesRegex(PublicationError, code):
                    compile_workspace_lineage(analysis, snapshot, report, workflow, env="PROD", adoption=adoption)


if __name__ == "__main__":
    unittest.main()
