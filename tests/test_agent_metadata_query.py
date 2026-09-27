"""Offline SQL compiler/executor tests; SQLite memory is a test fixture only."""
from copy import deepcopy
from decimal import Decimal
import importlib
from pathlib import Path
import sys
import unittest
import inspect
from types import SimpleNamespace
from unittest.mock import patch
from sqlalchemy import create_engine

ROOT = Path(__file__).resolve().parents[1] / "extensions/datahub-agent/integration"
sys.path.insert(0, str(ROOT))
compiler = importlib.import_module('metadata_query')
runner = importlib.import_module('query_runner')
compile_query, QueryError = compiler.compile_query, compiler.QueryError
execute, public_error = runner.execute, runner.public_error


def snapshot(name, columns):
    return {"urn": f"urn:li:dataset:(urn:li:dataPlatform:mssql,test.demo.main.{name},TEST)",
            "platform": "mssql", "platformInstanceUrn": "urn:li:dataPlatformInstance:(mssql,test)",
            "environment": "TEST", "qualifiedName": f"test.demo.main.{name}",
            "fields": [{"path": n, "nativeType": t} for n, t in columns]}


META = [snapshot("orders", [("customer_id", "int"), ("tenant", "int"), ("amount", "decimal(18,2)"), ("date", "date")]),
        snapshot("customers", [("id", "int"), ("tenant", "int"), ("region", "varchar(40)")])]
BINDING = {"platform": "mssql", "platformInstanceUrn": META[0]["platformInstanceUrn"],
           "environment": "TEST", "datasetPrefix": "test.", "database": "demo"}
ref = lambda dataset, field: {"dataset": dataset, "field": field}
PLAN = {"datasets": [{"urn": m["urn"], "alias": alias} for m, alias in zip(META, ["o", "c"])],
        "joins": [{"dataset": "c", "type": "left", "on": [
            {"left": ref("o", "customer_id"), "op": "eq", "right": ref("c", "id")},
            {"left": ref("o", "tenant"), "op": "eq", "right": ref("c", "tenant")}]}],
        "select": [{"field": ref("c", "region"), "as": "region"},
                   {"field": ref("o", "amount"), "aggregate": "sum", "as": "revenue"}],
        "filters": [{"field": ref("o", "amount"), "op": "gte", "value": 10}],
        "groupBy": ["region"], "orderBy": [{"field": "revenue", "direction": "desc"}], "limit": 20}


class CompilerTests(unittest.TestCase):
    def test_composite_join_really_computes_not_fixed_report(self):
        compiled = compile_query(PLAN, META, BINDING)
        wire = compiled.wire()
        self.assertIn("LEFT OUTER JOIN", wire["sql"])
        self.assertIn("[o].[tenant] = [c].[tenant]", wire["sql"])
        self.assertNotIn("sales_by_category", wire["sql"])
        # Execute the same SQLAlchemy SELECT tree against an in-memory fixture;
        # this is NOT a claim about a live MSSQL or Oracle database.
        engine = create_engine("sqlite:///:memory:", future=True)
        with engine.begin() as con:
            con.exec_driver_sql('CREATE TABLE orders(customer_id INT, tenant INT, amount DECIMAL, date TEXT)')
            con.exec_driver_sql('CREATE TABLE customers(id INT, tenant INT, region TEXT)')
            con.exec_driver_sql("INSERT INTO orders VALUES (1,1,15,'2026-01-01'),(1,2,40,'2026-02-01'),(3,1,6,'2026-03-01')")
            con.exec_driver_sql("INSERT INTO customers VALUES (1,1,'North'),(1,2,'South')")
            self.assertEqual([tuple(r) for r in con.execute(compiled.statement, compiled.parameters)], [('South', 40), ('North', 15)])
            changed = deepcopy(PLAN)
            changed['select'][1] = {'field': None, 'aggregate': 'count', 'as': 'orders'}
            changed['filters'] = []
            changed['orderBy'] = [{'field': 'region', 'direction': 'asc'}]
            counts = compile_query(changed, META, BINDING)
            self.assertEqual([tuple(r) for r in con.execute(counts.statement, counts.parameters)], [(None, 1), ('North', 1), ('South', 1)])
        engine.dispose()

    def test_four_dialects_and_date_buckets(self):
        for dialect in ('mssql', 'postgres', 'oracle', 'mysql'):
            meta, binding, plan = deepcopy(META), dict(BINDING, platform=dialect), deepcopy(PLAN)
            for m in meta:
                m['platform'] = dialect
                if dialect == 'oracle': m['qualifiedName'] = m['qualifiedName'].replace('demo.', '')
                if dialect == 'mysql': m['qualifiedName'] = m['qualifiedName'].replace('main.', '')
            plan['select'][0] = {'field': ref('o','date'), 'bucket': 'month', 'as': 'month'}
            plan['groupBy'] = ['month']
            compiled = compile_query(plan, meta, binding).wire()
            self.assertIn('JOIN', compiled['sql'])
            self.assertEqual(compiled['columns'][0]['type'], 'time')
            self.assertNotIn('sales', compiled['sql'])

    def test_values_bound_and_identifiers_quoted(self):
        plan = deepcopy(PLAN)
        evil = "x' OR 1=1; DROP TABLE customers;--"
        plan['filters'] = [{'field': ref('c','region'), 'op': 'eq', 'value': evil}]
        wire = compile_query(plan, META, BINDING).wire()
        self.assertNotIn(evil, wire['sql'])
        self.assertIn(evil, wire['parameters'].values())
        for mutation in [
            lambda p: p.update(sql='DELETE FROM anything'),
            lambda p: p['select'][0].update(field=ref('c','missing')),
            lambda p: p['select'][0].update(aggregate='xp_cmdshell'),
            lambda p: p['joins'][0].update(on=[]),
            lambda p: p['joins'][0]['on'][0].update(left=ref('c','id')),
            lambda p: p['joins'][0].update(type='cross'),
            lambda p: p.update(limit=True),
            lambda p: p.update(groupBy=[]),
            lambda p: p['datasets'][1].update(alias='o'),
        ]:
            bad = deepcopy(PLAN); mutation(bad)
            with self.assertRaises(QueryError): compile_query(bad, META, BINDING)
        with self.assertRaisesRegex(QueryError, 'source_mismatch'):
            compile_query(PLAN, META, dict(BINDING, database='other'))

    def test_quoted_metadata_fields_and_self_join(self):
        meta, plan = deepcopy(META), deepcopy(PLAN)
        meta[1]['fields'].append({'path': 'Region Name', 'nativeType': 'varchar'})
        plan['select'][0]['field']['field'] = 'Region Name'
        self.assertIn('[c].[Region Name]', compile_query(plan, meta, BINDING).wire()['sql'])
        plan['datasets'][1]['urn'] = META[0]['urn']
        plan['select'][0]['field'] = ref('c','tenant')
        plan['joins'][0]['on'][0]['right'] = ref('c','customer_id')
        self.assertIn('JOIN', compile_query(plan, META[:1], BINDING).wire()['sql'])

    def test_mssql_connector_matches_installed_driver_without_connecting(self):
        driver = importlib.import_module('pytds')
        signature = inspect.signature(driver.connect)
        received = []
        def fake_connect(**kwargs):
            signature.bind(**kwargs)  # Regression: pytds accepts dsn, NOT host.
            received.append(kwargs)
            return 'synthetic-connection'
        with patch.object(runner.importlib, 'import_module', return_value=SimpleNamespace(connect=fake_connect)):
            connection = runner.connect('mssql', {'host':'fixture.invalid','port':1433,'username':'fixture','password':'synthetic','database':'demo'})
        self.assertEqual(connection, 'synthetic-connection')
        self.assertEqual(received[0]['dsn'], 'fixture.invalid')
        self.assertTrue(received[0]['disable_connect_retry'])
        self.assertEqual(received[0]['timeout'], 30)
        self.assertFalse(received[0]['autocommit'])

    def test_dbapi_bound_execution_limit_rollback_and_denial(self):
        events = []
        class Cursor:
            description = [('region',), ('revenue',)]
            def execute(self, sql, params): events.append(('execute', sql, params))
            def fetchmany(self, count): return [('North', Decimal('12.3400'))] * count
            def close(self): events.append('cursor_close')
        class Connection:
            def cursor(self): return Cursor()
            def rollback(self): events.append('rollback')
            def close(self): events.append('close')
        result = execute(compile_query(PLAN, META, BINDING), {}, lambda *_: Connection())
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['rows']), 20)
        self.assertEqual(result['rows'][0]['revenue'], '12.3400')
        self.assertEqual(events[-3:], ['cursor_close', 'rollback', 'close'])
        self.assertEqual(events[0][2]['p0'], 10)
        self.assertEqual(public_error(Exception(1142, 'secret table denied')), 'query_source_denied')
        self.assertEqual(public_error(Exception('password=private')), 'query_execution_unconfirmed')


if __name__ == '__main__': unittest.main()
