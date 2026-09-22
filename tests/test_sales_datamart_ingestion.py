"""Offline contract checks for the bounded native MSSQL metadata canary.

No connection or ingestion run. Live ACL, schema, and lineage readback remain
separate acceptance evidence.
"""
import json
from pathlib import Path
import unittest

from datahub.ingestion.source.sql.mssql.source import SQLServerConfig

ROOT = Path(__file__).resolve().parents[1]
RECIPE = ROOT / "extensions/sales-datamart/metadata/target-ingestion.json"
TABLES = (
    "dim_date", "dim_product", "dim_customer", "dim_territory",
    "fact_sales_order_line",
)


class TargetMetadataRecipeTests(unittest.TestCase):
    def setUp(self):
        self.recipe = json.loads(RECIPE.read_text())
        self.config = SQLServerConfig.model_validate(self.recipe["source"]["config"])

    def test_only_five_tables_and_one_view(self):
        for table in TABLES:
            # Native SQLServerSource.get_identifier lowercases BEFORE filtering.
            name = f"salesdatamart.dm.{table}"
            self.assertTrue(self.config.table_pattern.allowed(name))
            self.assertFalse(self.config.view_pattern.allowed(name))
        self.assertTrue(self.config.view_pattern.allowed("salesdatamart.reporting.v_sales_order_line"))
        self.assertFalse(self.config.table_pattern.allowed("salesdatamart.reporting.v_sales_order_line"))
        for name in (
            "adventureworks2019.sales.salesorderheader",
            "salesdatamart.dm.fact_sales_order_line_old",
            "salesdatamart.other.fact_sales_order_line",
            "salesdatamart.reporting.other_view",
            "otherdb.reporting.v_sales_order_line",
            "salesdatamartXdmXdim_date",
            "salesdatamart.dm.dim_date.other",
        ):
            with self.subTest(name=name):
                self.assertFalse(self.config.table_pattern.allowed(name))
                self.assertFalse(self.config.view_pattern.allowed(name))

    def test_fixed_database_no_row_scanning_or_query_history(self):
        c = self.config
        self.assertEqual(c.database, "SalesDatamart")
        self.assertEqual(c.host_port, "host.docker.internal:14334")
        self.assertEqual(c.username, "datahub_ingest")
        for flag in ("include_stored_procedures", "include_stored_procedures_code",
                     "include_jobs", "include_query_lineage", "include_usage_statistics",
                     "include_lineage"):
            self.assertFalse(getattr(c, flag), flag)
        self.assertFalse(c.profiling.enabled)
        self.assertFalse(c.stateful_ingestion.enabled)
        self.assertEqual(c.options["connect_args"], {"timeout": 30, "login_timeout": 5})

    def test_view_lineage_and_normalization_match_native_contract(self):
        c = self.config
        self.assertTrue(c.include_tables)
        self.assertTrue(c.include_views)
        self.assertTrue(c.include_view_lineage)
        self.assertTrue(c.include_view_column_lineage)
        self.assertEqual(c.env, "PROD")
        self.assertTrue(c.convert_urns_to_lowercase)
        self.assertTrue(c.convert_column_urns_to_lowercase)

    def test_existing_secret_references_only(self):
        self.assertEqual(self.recipe["source"]["type"], "mssql")
        self.assertEqual(self.recipe["source"]["config"]["password"], "${DATAHUB_MSSQL_PASSWORD}")
        self.assertEqual(self.recipe["sink"], {
            "type": "datahub-rest", "config": {
                "server": "http://datahub-gms:8080", "token": "${DATAHUB_TOKEN}",
            },
        })
        self.assertEqual(set(self.recipe), {"source", "sink"})


if __name__ == "__main__":
    unittest.main()
