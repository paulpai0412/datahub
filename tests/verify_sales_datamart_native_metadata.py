"""Read-only case verifier: native file-sink events vs SQL metadata and view DDL.

The expected view projection is an independent case golden, NOT Skill logic.
Usage: .venv/bin/python tests/verify_sales_datamart_native_metadata.py EVENTS PHYSICAL_RECEIPT
"""
import json
from pathlib import Path
import sys

from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import MetadataChangeEventClass


def dataset(name):
    return f"urn:li:dataset:(urn:li:dataPlatform:mssql,salesdatamart.{name},PROD)"


def schema_field(urn, field):
    return f"urn:li:schemaField:({urn},{field})"


def decode_events(events):
    """Official file sink contains both MCE snapshots and MCPs."""
    aspects = {}
    for raw in events:
        if "proposedSnapshot" in raw:
            snapshot = MetadataChangeEventClass.from_obj(raw).proposedSnapshot
            pairs = [(snapshot.urn, a.ASPECT_NAME, a) for a in snapshot.aspects]
        else:
            mcp = MetadataChangeProposalWrapper.from_obj(raw)
            pairs = [(mcp.entityUrn, mcp.aspectName, mcp.aspect)]
        for urn, name, aspect in pairs:
            assert (urn, name) not in aspects, (urn, name, "duplicate aspect")
            aspects[urn, name] = aspect.to_obj()
    return aspects


def verify_aspects(aspects, physical):
    fields = {}
    for name, _object_id, _ordinal, column, kind, size, precision, scale, nullable in physical:
        native = {"int": "INTEGER", "smallint": "SMALLINT", "tinyint": "TINYINT", "date": "DATE"}.get(kind)
        if kind == "decimal":
            native = f"DECIMAL({precision},{scale})"
        if kind == "nvarchar":
            native = f"NVARCHAR({size // 2})"
        assert native is not None, (column, kind)
        fields.setdefault(dataset(name), {})[column.lower()] = (native, bool(nullable))
    assert len(fields) == 6 and sum(map(len, fields.values())) == 61
    actual_schemas = {urn for urn, name in aspects if name == "schemaMetadata"}
    assert actual_schemas == set(fields)
    for urn, expected in fields.items():
        actual = aspects[urn, "schemaMetadata"]
        assert len(actual["fields"]) == len(expected)
        for field in actual["fields"]:
            native, nullable = expected[field["fieldPath"]]
            observed = field["nativeDataType"].split(" COLLATE ")[0].replace(" ", "")
            assert observed == native and field["nullable"] == nullable, (urn, field["fieldPath"])

    expected_keys = {
        "dm.dim_customer": {"customerkey"}, "dm.dim_date": {"datekey"},
        "dm.dim_product": {"productkey"}, "dm.dim_territory": {"territorykey"},
        "dm.fact_sales_order_line": {"salesorderid", "salesorderdetailid"},
        "reporting.v_sales_order_line": set(),  # Views do not inherit a declared PK.
    }
    for name, keys in expected_keys.items():
        actual = aspects[dataset(name), "schemaMetadata"]
        assert {f["fieldPath"] for f in actual["fields"] if f.get("isPartOfKey")} == keys
    fact = dataset("dm.fact_sales_order_line")
    foreign_keys = aspects[fact, "schemaMetadata"]["foreignKeys"]
    expected_fks = {
        "customerkey": ("dm.dim_customer", "customerkey"),
        "orderdatekey": ("dm.dim_date", "datekey"),
        "productkey": ("dm.dim_product", "productkey"),
        "territorykey": ("dm.dim_territory", "territorykey"),
    }
    assert len(foreign_keys) == 4
    for source, (target, column) in expected_fks.items():
        matches = [fk for fk in foreign_keys if fk["sourceFields"] == [schema_field(fact, source)]]
        assert len(matches) == 1
        assert matches[0]["foreignDataset"] == dataset(target)
        assert matches[0]["foreignFields"] == [schema_field(dataset(target), column)]

    # Read against 001_create_sales_datamart.sql's explicit SELECT projection.
    view = dataset("reporting.v_sales_order_line")
    expected_edges = {}
    for table, columns in {
        "dm.fact_sales_order_line": "salesorderid salesorderdetailid orderdatekey productkey customerkey territorykey status currencyrateid orderqty unitprice unitpricediscount linenetamount sourcelinetotal",
        "dm.dim_product": "sourceproductid productname productnumber productsubcategoryname productcategoryname",
        "dm.dim_customer": "sourcecustomerid",
        "dm.dim_territory": "sourceterritoryid territoryname countryregioncode territorygroup",
    }.items():
        for column in columns.split():
            expected_edges[schema_field(view, column)] = [schema_field(dataset(table), column)]
    expected_edges[schema_field(view, "orderdate")] = [schema_field(dataset("dm.dim_date"), "fulldate")]
    lineage = aspects[view, "upstreamLineage"]
    assert {u["dataset"] for u in lineage["upstreams"]} == set(fields) - {view}
    assert len(lineage["fineGrainedLineages"]) == len(expected_edges) == 24
    actual_edges = {}
    for edge in lineage["fineGrainedLineages"]:
        assert edge["upstreamType"] == "FIELD_SET" and edge["downstreamType"] == "FIELD"
        assert len(edge["downstreams"]) == 1
        downstream = edge["downstreams"][0]
        assert downstream not in actual_edges
        actual_edges[downstream] = edge["upstreams"]
    assert actual_edges == expected_edges

    urns = {urn for urn, _name in aspects}
    containers = {u for u in urns if u.startswith("urn:li:container:")}
    queries = {u for u in urns if u.startswith("urn:li:query:")}
    assert len(containers) == 3 and len(queries) == 1
    assert urns == set(fields) | containers | queries
    assert {u["query"] for u in lineage["upstreams"]} == queries
    return {"status": "SIX_SCHEMAS_AND_24_VIEW_COLUMN_EDGES_PASS", "datasets": sorted(fields),
            "columns": 61, "primaryKeyShapes": 6, "factForeignKeys": 4,
            "viewUpstreams": 5, "viewColumnEdges": 24,
            "containers": sorted(containers), "queries": sorted(queries),
            "aspectNames": sorted({name for _urn, name in aspects}),
            "isSkillOrAgentAcceptance": False}


def verify(events, physical):
    return verify_aspects(decode_events(events), physical)


def verify_readback(receipt, physical):
    assert receipt["execution"]["state"] in {"SUCCESS", "SUCCEEDED"}
    assert receipt["sourceUrn"] == "urn:li:dataHubIngestionSource:c382a4fe-48a9-4a0b-893a-95029a74b25f"
    assert receipt["requestId"] == "f2ce4ab4-1892-4936-9ac5-f2bd0370f3cb"
    aspects = {}
    for urn, entries in receipt["readback"].items():
        for name, entry in entries.items():
            aspects[urn, name] = entry["value"]
            if name == "schemaMetadata":
                metadata = entry["systemMetadata"]
                assert metadata["runId"] == receipt["requestId"]
                assert metadata["lastObserved"] >= receipt["startedAt"]
                assert metadata["pipelineName"] == receipt["sourceUrn"]
    result = verify_aspects(aspects, physical)
    result.update(datahubReadback=True, requestId=receipt["requestId"],
                  sourceVersion=receipt["sourceVersion"])
    return result


if __name__ == "__main__":
    assert len(sys.argv) == 3, "expected EVENTS_OR_READBACK PHYSICAL_RECEIPT"
    evidence = json.loads(Path(sys.argv[1]).read_text())
    physical = json.loads(Path(sys.argv[2]).read_text())["physicalSchema"]
    result = verify_readback(evidence, physical) if isinstance(evidence, dict) else verify(evidence, physical)
    print(json.dumps(result, indent=2))
