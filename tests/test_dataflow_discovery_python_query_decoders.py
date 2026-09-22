import json
from pathlib import Path
import tempfile
import unittest

from dataflow_discovery.host import capture_and_analyze
from dataflow_discovery.python_catalog import bind_python_sql_dependencies
from dataflow_discovery.python_query_decoders import bind_python_query_decoders
from tests.test_dataflow_discovery_catalog import Reader, scope, urn


PREFIX = '''from dataclasses import dataclass
@dataclass
class Output:
    decoded: int
'''
HELPER = '''def read_rows(conn, statement):
    result = conn.execute(statement)
    return list(result.mappings().all())
'''


class QueryDecoderTests(unittest.TestCase):
    def report(self, sql='SELECT Amount AS raw FROM dbo.Orders', key='raw', helper=HELPER, extra='', program=None, policies=None):
        program = program or (PREFIX + helper + 'def decode(rows):\n    return tuple(Output(row[' + repr(key) + ']) for row in rows)\n'
                              + 'def run(engine'+extra+'):\n    with engine.connect() as conn:\n        return decode(read_rows(conn, '+repr(sql)+'))\n')
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        (Path(directory.name)/'case.py').write_text(program)
        captured = capture_and_analyze(directory.name,['case.py'],source_id='query-decoder-case')
        reader=Reader([urn(),urn('other')])
        description=bind_python_sql_dependencies(captured.analysis,captured.snapshot,path='case.py',entrypoint='run',scopes_by_context={},reader=reader)
        scopes={c['context_id']:(policies[index] if policies is not None else scope()) for index,c in enumerate(description['contexts'])}
        report=bind_python_query_decoders(captured.analysis,captured.snapshot,path='case.py',entrypoint='run',scopes_by_context=scopes,reader=reader)
        return report

    def test_bounded_mapping_result_preserves_links_but_rejects_guard_or_close_effects(self):
        bounded = '''LIMIT = 100000
def read_rows(conn, statement):
    result = conn.execute(statement)
    try:
        rows = list(result.mappings().fetchmany(LIMIT + 1))
        if len(rows) > LIMIT:
            raise RuntimeError("too_many_rows")
        return rows
    finally:
        result.close()
'''
        seam = self.report(helper=bounded)['contexts'][0]['query_decoder']
        self.assertEqual(seam['status'], 'DECLARATION_LINKS_DESCRIBED')
        self.assertEqual(seam['links'][0]['origins'][0]['dataset_urn'], urn())
        self.assertFalse(seam['transport']['runtime_result_verified'])
        for altered in [bounded.replace('result.close()', 'rows.clear()'),
                        bounded.replace('return rows', 'return other'),
                        bounded.replace('raise RuntimeError("too_many_rows")', 'pass'),
                        bounded.replace('LIMIT + 1', 'LIMIT'),
                        bounded.replace('LIMIT = 100000', 'LIMIT = arbitrary()'),
                        'from arbitrary import len\n' + bounded,
                        'match arbitrary:\n    case len:\n        pass\n' + bounded]:
            with self.subTest(source=altered):
                rejected = self.report(helper=altered)['contexts'][0]['query_decoder']
                self.assertEqual(rejected['status'], 'UNRESOLVED')
                self.assertEqual(rejected['links'], [])

    def test_actual_result_return_and_decoder_argument_link_not_helper_name(self):
        report=self.report(helper=HELPER.replace('read_rows','renamed_helper'),program=PREFIX+HELPER.replace('read_rows','renamed_helper')+'''def decode(*, input_rows):
    return [Output(row["raw"]) for row in input_rows]
def run(engine):
    with engine.connect() as conn:
        return decode(input_rows=renamed_helper(conn, "SELECT Amount AS raw FROM dbo.Orders"))
''')
        seam=report['contexts'][0]['query_decoder']
        self.assertEqual(seam['status'],'DECLARATION_LINKS_DESCRIBED')
        self.assertEqual(seam['input_parameter'],'input_rows')
        link,=seam['links']
        self.assertEqual(link['record_field'],'decoded')
        self.assertEqual(link['result_label'],'raw')
        self.assertEqual(link['origins'][0]['field_path'],'amount')
        self.assertEqual(link['origins'][0]['dataset_urn'],urn())
        self.assertFalse(seam['transport']['runtime_result_verified'])
        self.assertFalse(report['runtime_values_verified'])
        self.assertFalse(report['publication_authorized'])

    def test_result_labels_are_python_case_sensitive_even_when_catalog_is_not(self):
        good=self.report(sql='SELECT Amount AS MyValue FROM dbo.Orders',key='MyValue')
        self.assertEqual(good['contexts'][0]['query_decoder']['links'][0]['result_label'],'MyValue')
        wrong=self.report(sql='SELECT Amount AS MyValue FROM dbo.Orders',key='myvalue')
        self.assertEqual(wrong['contexts'][0]['query_decoder']['status'],'PARTIAL')
        self.assertEqual(wrong['contexts'][0]['query_decoder']['links'],[])

    def test_wrong_result_protocol_or_owner_is_not_promoted(self):
        returns=['list(result.all())','list(other.mappings().all())','list(result.mappings().all(1))','[]','list(result.scalars().all())']
        for returned in returns:
            with self.subTest(returned=returned):
                report=self.report(helper=HELPER.replace('list(result.mappings().all())',returned))
                self.assertEqual(report['contexts'][0]['query_decoder']['status'],'UNRESOLVED')
                self.assertEqual(report['contexts'][0]['query_decoder']['links'],[])

    def test_mutation_rebinding_and_materializer_shadowing_are_rejected(self):
        helpers=[HELPER.replace('    return','    result = replacement\n    return'),
                 HELPER.replace('    return','    result.change()\n    return'),
                 HELPER.replace('statement):','statement, list=None):'),
                 'from arbitrary import *\n'+HELPER]
        for helper in helpers:
            with self.subTest(helper=helper):
                report=self.report(helper=helper)
                self.assertFalse(any(c['query_decoder']['links'] for c in report['contexts']))

    def test_same_helper_and_sql_process_have_distinct_connection_contexts(self):
        program=PREFIX+HELPER+'''def decode(rows):
    return [Output(row["raw"]) for row in rows]
def batch(engine):
    with engine.connect() as conn:
        return decode(read_rows(conn, "SELECT Amount AS raw FROM dbo.Orders"))
def run(left, right):
    batch(left)
    batch(right)
'''
        report=self.report(program=program,policies=[scope(),scope('Other')])
        self.assertEqual(len(report['contexts']),2)
        self.assertNotEqual(report['contexts'][0]['context_id'],report['contexts'][1]['context_id'])
        self.assertEqual([c['query_decoder']['links'][0]['origins'][0]['dataset_urn'] for c in report['contexts']],[urn(),urn('other')])

    def test_decoder_shadow_and_non_direct_consumer_are_not_assumed(self):
        shadow=self.report(extra=', decode')
        self.assertEqual(shadow['contexts'][0]['query_decoder']['status'],'UNRESOLVED')
        program=PREFIX+HELPER+'''def decode(rows):
    return [Output(row["raw"]) for row in rows]
def run(engine):
    with engine.connect() as conn:
        rows=read_rows(conn, "SELECT Amount AS raw FROM dbo.Orders")
        return decode(rows)
'''
        self.assertEqual(self.report(program=program)['contexts'][0]['query_decoder']['status'],'UNRESOLVED')

    def test_implicit_labels_multi_results_and_missing_columns_are_not_guessed(self):
        for sql in ['SELECT Amount FROM dbo.Orders','SELECT Amount AS raw FROM dbo.Orders; SELECT OrderID AS raw FROM dbo.Orders','SELECT Missing AS raw FROM dbo.Orders']:
            with self.subTest(sql=sql):
                seam=self.report(sql=sql)['contexts'][0]['query_decoder']
                self.assertEqual(seam['links'],[])
                self.assertEqual(seam['status'],'UNRESOLVED')

    def test_count_and_literal_have_no_invented_physical_origins_or_leaked_value(self):
        for sql in ['SELECT COUNT(*) AS raw FROM dbo.Orders',"SELECT 'PRIVATE_SQL_LITERAL' AS raw FROM dbo.Orders"]:
            with self.subTest(sql=sql):
                report=self.report(sql=sql)
                link,=report['contexts'][0]['query_decoder']['links']
                self.assertEqual(link['origins'],[])
                self.assertNotIn('PRIVATE_SQL_LITERAL',json.dumps(report))


if __name__ == '__main__':
    unittest.main()
