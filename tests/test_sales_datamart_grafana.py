"""Template regressions and the official ingestion entrypoint, with HTTP fixtures only.

Schema resolution and SQL parsing use HTTP fixtures, not a live Catalog.
No Grafana rendering, SQL execution, or live publication is certified. In
particular, parser output and the no-graph fallback are NOT lineage acceptance. Run with the pinned project .venv (acryl-datahub 1.7.0.9).
"""

import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlsplit

# Disable SDK telemetry before importing the public ingestion entrypoint.
os.environ["DATAHUB_TELEMETRY_ENABLED"] = "false"

import requests
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.emitter.mce_builder import make_schema_field_urn
from datahub.ingestion.run.pipeline import Pipeline
from datahub.metadata.urns import DatasetUrn
from datahub.metadata.schema_classes import (
    ChartInfoClass, DashboardInfoClass, SchemaMetadataClass, UpstreamLineageClass,
)

ROOT = Path(__file__).resolve().parents[1]
GRAFANA = ROOT / "extensions/sales-datamart/grafana"
DATASOURCE = {"type": "mssql", "uid": "dataflow-salesdatamart"}
DASHBOARD_UID = "dataflow-sales-v1"
FOLDER_UID = "dataflow-discovery"
VIEW_URN = "urn:li:dataset:(urn:li:dataPlatform:mssql,salesdatamart.reporting.v_sales_order_line,PROD)"
# Independent expectations from the seven SELECT projections, not parser output.
EXPECTED_ORIGINS = {
    1: {"value": {"linenetamount"}},
    2: {"value": {"salesorderid"}},
    3: {"value": {"linenetamount", "salesorderid"}},
    4: {"time": {"orderdate"}, "sales_amount": {"linenetamount"}},
    5: {"category": {"productcategoryname"}, "sales_amount": {"linenetamount"}},
    6: {"territory": {"territoryname"}, "sales_amount": {"linenetamount"}},
    7: {"line_count": set(), "order_count": {"salesorderid"}, "quantity": {"orderqty"},
        "line_net_amount": {"linenetamount"}, "source_line_total": {"sourcelinetotal"}},
}


def catalog_fixture():
    """Synthetic schema response; the private recorded-schema case is separate."""
    columns = {
        "linenetamount": ("NumberType", "decimal(19,6)"),
        "salesorderid": ("NumberType", "int"),
        "orderdate": ("DateType", "date"),
        "productcategoryname": ("StringType", "nvarchar(50)"),
        "territoryname": ("StringType", "nvarchar(50)"),
        "orderqty": ("NumberType", "smallint"),
        "sourcelinetotal": ("NumberType", "decimal(19,6)"),
    }
    return {VIEW_URN: {
        "schemaName": "synthetic-view-fixture", "platform": "urn:li:dataPlatform:mssql",
        "version": 0, "hash": "", "platformSchema": {"com.linkedin.schema.OtherSchema": {"rawSchema": ""}},
        "fields": [{"fieldPath": name, "type": {"type": {f"com.linkedin.schema.{kind}": {}}},
                    "nativeDataType": native} for name, (kind, native) in columns.items()],
    }}


def template(name):
    return json.loads((GRAFANA / name).read_text())


def ingest_fixture(dashboard, *, catalog=None, requests_seen=None, catalog_reads=None,
                   transform=None, catalog_aspects=None, transformers=None, observations=None,
                   ingest_tags=True):
    """Real connector/parser + file sink; only external HTTP is replaced.

    Optional catalog maps exact URNs to recorded/synthetic SchemaMetadata JSON.
    It is never a SQL-parsing or lineage-answer fixture.
    """
    dashboard = copy.deepcopy(dashboard)

    def request(_session, method, url, **kwargs):
        if requests_seen is not None:
            requests_seen.append((method, url))
        schema_read = catalog is not None and method == "POST" and url == "https://catalog.invalid/openapi/v3/entity/dataset/batchGet"
        if method != "GET" and not schema_read:
            raise AssertionError("unexpected mutation in fixture pipeline")
        page = (kwargs.get("params") or {}).get("page", 1)
        status = 200
        if catalog is not None and url == "https://catalog.invalid/config":
            body = {"noCode": "true", "version": "v1.7.0.1"}
        elif catalog is not None and url.startswith("https://catalog.invalid/aspects/"):
            parts = urlsplit(url)
            urn = unquote(parts.path[len("/aspects/"):])
            aspect = parse_qs(parts.query).get("aspect", [None])[0]
            names = {"schemaMetadata": "com.linkedin.schema.SchemaMetadata",
                     "datasetKey": "com.linkedin.metadata.key.DatasetKey", "status": "com.linkedin.common.Status"}
            if aspect not in names:
                raise AssertionError("unexpected direct Catalog aspect")
            if urn not in catalog:
                status, body = 404, {}
            else:
                parsed = DatasetUrn.from_string(urn)
                values = {"schemaMetadata": catalog[urn], "status": {"removed": False},
                          "datasetKey": {"platform": str(parsed.platform), "name": parsed.name, "origin": parsed.env}}
                values.update((catalog_aspects or {}).get(urn, {}))
                if values[aspect] is None:
                    status, body = 404, {}
                else:
                    body = {"aspect": {names[aspect]: values[aspect]}}
        elif schema_read and catalog is not None:
            requested = kwargs.get("json")
            if requested is None:
                requested = json.loads(kwargs["data"])
            if catalog_reads is not None:
                catalog_reads.append(requested)
            if not isinstance(requested, list) or any(set(item) != {"urn", "schemaMetadata"} for item in requested):
                raise AssertionError("unexpected Catalog read scope")
            body = [{"urn": item["urn"], "schemaMetadata": {"value": catalog[item["urn"]]}}
                    for item in requested if item["urn"] in catalog]
        elif url == "https://grafana.invalid/api/folders":
            body = [{"id": 1, "uid": FOLDER_UID, "title": FOLDER_UID}] if page == 1 else []
        elif url == "https://grafana.invalid/api/search":
            body = [{"uid": DASHBOARD_UID}] if page == 1 else []
        elif url == f"https://grafana.invalid/api/dashboards/uid/{DASHBOARD_UID}":
            body = {"dashboard": dashboard, "meta": {"folderUid": FOLDER_UID, "folderId": 1, "folderTitle": FOLDER_UID}}
        else:
            raise AssertionError("unexpected network target in fixture pipeline")
        response = requests.Response()
        response.status_code = status
        response.url = url
        response.encoding = "utf-8"
        response._content = json.dumps(body).encode()
        return response

    with tempfile.TemporaryDirectory() as directory, patch.object(
        requests.Session, "request", request
    ):
        output = Path(directory) / "mcps.json"
        pipeline = Pipeline.create(
            {
                "run_id": "dm02-grafana-offline-regression",
                **({"transformers": transformers} if transformers is not None else {}),
                **({"datahub_api": {"server": "https://catalog.invalid", "token": "fixture-not-a-credential", "retry_max_times": 0}} if catalog is not None else {}),
                "source": {
                    "type": "grafana",
                    "config": {
                        "url": "https://grafana.invalid",
                        "service_account_token": "fixture-not-a-credential",
                        "ingest_owners": False,
                        "ingest_tags": ingest_tags,
                        "connection_to_platform_map": {
                            DATASOURCE["uid"]: {
                                "platform": "mssql",
                                "database": "SalesDatamart",
                                "database_schema": "reporting",
                            }
                        },
                    },
                },
                "sink": {"type": "file", "config": {"filename": str(output)}},
            },
            report_to=None,
            no_progress=True,
        )
        pipeline.run()
        if observations is not None:
            observations.append({"status": pipeline.final_status.name,
                                 "records": json.loads(output.read_text())})
        pipeline.raise_from_status()
        mcps = [MetadataChangeProposalWrapper.from_obj(item) for item in json.loads(output.read_text())]
        return transform(mcps) if transform is not None else mcps


class GrafanaTemplateTests(unittest.TestCase):
    def test_mssql_settings_bind_the_approved_local_tls_exception(self):
        source = template("datasource.template.json")
        self.assertEqual(source["type"], "mssql")
        self.assertEqual(source["uid"], DATASOURCE["uid"])
        self.assertEqual(source["url"], "127.0.0.1:14334")
        self.assertEqual(source["user"], "sales_datamart_grafana")
        self.assertEqual(source["jsonData"]["database"], "SalesDatamart")
        # Grafana v13.1.2 sqleng.JsonData.Encrypt is a Go string, not bool.
        self.assertEqual(source["jsonData"]["encrypt"], "true")
        # Explicitly approved local-only test exception; encryption stays on.
        # The fixed host, database, and reader assertions above bind its scope.
        self.assertIs(source["jsonData"]["tlsSkipVerify"], True)
        self.assertEqual(source["jsonData"]["connectionTimeout"], 5)
        self.assertEqual(source["jsonData"]["maxOpenConns"], 2)
        self.assertEqual(source["secureJsonData"], {"password": "${SALESDATAMART_GRAFANA_PASSWORD}"})

    def test_native_all_expansion_calendar_dates_and_currency_claim(self):
        document = template("dashboard.json")
        dashboard = document["dashboard"]
        self.assertIs(document["overwrite"], False)
        self.assertEqual(document["folderUid"], FOLDER_UID)
        self.assertEqual(dashboard["timezone"], "utc")
        self.assertEqual(dashboard["time"]["from"], "2011-05-31T00:00:00.000Z")
        for variable in dashboard["templating"]["list"]:
            with self.subTest(variable=variable["name"]):
                # A custom allValue bypasses sqlstring formatting in Grafana.
                self.assertEqual(variable["allValue"], "")
                self.assertIs(variable["includeAll"], True)
                self.assertEqual(variable["datasource"], DATASOURCE)
                for panel in dashboard["panels"]:
                    self.assertIn("${" + variable["name"] + ":sqlstring}", panel["targets"][0]["rawSql"])
        self.assertNotIn("currencyUSD", json.dumps(dashboard))
        for panel in dashboard["panels"]:
            self.assertEqual(panel["datasource"], DATASOURCE)

    def test_official_connector_keeps_seven_panel_inputs_and_membership(self):
        mcps = ingest_fixture(template("dashboard.json")["dashboard"])
        charts = {mcp.entityUrn: mcp.aspect for mcp in mcps if isinstance(mcp.aspect, ChartInfoClass)}
        dashboards = [mcp.aspect for mcp in mcps if isinstance(mcp.aspect, DashboardInfoClass)]
        lineages = {mcp.entityUrn: mcp.aspect for mcp in mcps if isinstance(mcp.aspect, UpstreamLineageClass)}
        expected_inputs = set()
        for panel_id in range(1, 8):
            chart = f"urn:li:chart:(grafana,{DASHBOARD_UID}.{panel_id})"
            dataset = f"urn:li:dataset:(urn:li:dataPlatform:grafana,mssql.{DATASOURCE['uid']}.{DASHBOARD_UID}.{panel_id},PROD)"
            self.assertEqual(charts[chart].inputs, [dataset])
            expected_inputs.add(dataset)
        self.assertEqual(len(charts), 7)
        self.assertEqual(len(dashboards), 1)
        self.assertEqual(set(dashboards[0].charts), set(charts))
        self.assertEqual(set(lineages), expected_inputs)
        for lineage in lineages.values():
            # With no Catalog graph the connector invents a datasource-level
            # fallback, NOT the real reporting-view URN or column dependencies.
            self.assertFalse(lineage.fineGrainedLineages)
            self.assertEqual(
                [upstream.dataset for upstream in lineage.upstreams],
                ["urn:li:dataset:(urn:li:dataPlatform:mssql,SalesDatamart.dataflow-salesdatamart,PROD)"],
            )

    def test_official_parser_resolves_view_and_exact_column_sets(self):
        reads = []
        mcps = ingest_fixture(template("dashboard.json")["dashboard"], catalog=catalog_fixture(), catalog_reads=reads)
        self.assertEqual(reads, [[{"urn": VIEW_URN, "schemaMetadata": {}}]])
        lineages = {m.entityUrn: m.aspect for m in mcps if isinstance(m.aspect, UpstreamLineageClass)}
        self.assertEqual(len(lineages), 7)
        for panel_id, outputs in EXPECTED_ORIGINS.items():
            urn = f"urn:li:dataset:(urn:li:dataPlatform:grafana,mssql.{DATASOURCE['uid']}.{DASHBOARD_UID}.{panel_id},PROD)"
            lineage = lineages[urn]
            self.assertEqual([u.dataset for u in lineage.upstreams], [VIEW_URN])
            self.assertEqual(
                {tuple(edge.downstreams or []): set(edge.upstreams or []) for edge in lineage.fineGrainedLineages or []},
                {(make_schema_field_urn(urn, name),): {make_schema_field_urn(VIEW_URN, field) for field in fields}
                 for name, fields in outputs.items()},
            )
        # COUNT_BIG(*) has no fabricated physical '*' field dependency.

    def test_missing_catalog_still_emits_inferred_edges_not_identity_proof(self):
        reads = []
        mcps = ingest_fixture(template("dashboard.json")["dashboard"], catalog={}, catalog_reads=reads)
        self.assertTrue(reads)
        lineages = [m.aspect for m in mcps if isinstance(m.aspect, UpstreamLineageClass)]
        self.assertEqual(len(lineages), 7)
        self.assertTrue(all(lineage.fineGrainedLineages for lineage in lineages))
        # Pipeline success / confidence is not proof that any upstream field exists.

    @unittest.expectedFailure
    def test_official_panel_schema_matches_query_result_shape(self):
        """Known pinned-connector gap, not an accepted extra-field workaround."""
        mcps = ingest_fixture(template("dashboard.json")["dashboard"], catalog=catalog_fixture())
        actual = {int(m.entityUrn.rsplit(".", 1)[1].split(",", 1)[0]): {f.fieldPath for f in m.aspect.fields}
                  for m in mcps if m.entityUrn is not None and isinstance(m.aspect, SchemaMetadataClass)}
        self.assertEqual(actual, {panel_id: set(outputs) for panel_id, outputs in EXPECTED_ORIGINS.items()})

    def test_original_unbound_panels_do_not_produce_inputs(self):
        dashboard = template("dashboard.json")["dashboard"]
        for panel in dashboard["panels"]:
            del panel["datasource"]
        mcps = ingest_fixture(dashboard)
        charts = [mcp.aspect for mcp in mcps if isinstance(mcp.aspect, ChartInfoClass)]
        self.assertEqual(len(charts), 7)
        self.assertTrue(all(not chart.inputs for chart in charts))
        self.assertFalse(any(mcp.aspectName == "upstreamLineage" for mcp in mcps))


if __name__ == "__main__":
    unittest.main()
