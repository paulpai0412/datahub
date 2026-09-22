from pathlib import Path
import tempfile
import unittest

from dataflow_discovery.host import capture_and_analyze
from dataflow_discovery.python_catalog import bind_python_sql_dependencies
from dataflow_discovery.python_lookup_values import bind_python_lookup_values
from tests.test_dataflow_discovery_catalog import Reader, scope

PROGRAM='''def fetch_rows(conn, statement):
    result=conn.execute(statement)
    return list(result.mappings().all())
def number(row, key):
    return int(row.get(key))
def maps(engine):
    with engine.connect() as conn:
        rows=fetch_rows(conn,"SELECT OrderID AS Id, Amount AS Value FROM dbo.Orders")
    first={number(row,"Id"):number(row,"Value") for row in rows}
    second={number(row,"Value"):number(row,"Id") for row in rows}
    return first, second
def run(source, target, requested):
    ignored, selected=maps(source)
    with target.begin() as conn:
        parameters={"value":selected[requested]}
        conn.execute("UPDATE dbo.Orders SET Amount=:value",parameters)
'''


class LookupValueTests(unittest.TestCase):
    def report(self, program=PROGRAM):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        (Path(directory.name)/'case.py').write_text(program)
        captured=capture_and_analyze(directory.name,['case.py'],source_id='lookup-case')
        reader=Reader()
        described=bind_python_sql_dependencies(captured.analysis,captured.snapshot,path='case.py',entrypoint='run',scopes_by_context={},reader=reader)
        scopes={c['context_id']:scope() for c in described['contexts']}
        result=bind_python_lookup_values(captured.analysis,captured.snapshot,path='case.py',entrypoint='run',scopes_by_context=scopes,reader=reader)
        slot,=[s for c in result['contexts'] for stmt in c['write_statements'] for s in stmt['slots']]
        return result,slot

    def test_tuple_position_and_helper_get_preserve_map_key_and_value_separately(self):
        report,slot=self.report()
        declaration,=slot['lookup_values']['declarations']
        self.assertEqual({r['result_label'] for r in declaration['map_key_reads']},{'Value'})
        self.assertEqual({r['result_label'] for r in declaration['map_value_reads']},{'Id'})
        self.assertEqual(declaration['map_value_reads'][0]['origins'][0]['field_path'],'orderid')
        self.assertFalse(declaration['duplicate_keys_verified'])
        self.assertFalse(declaration['lookup_match_verified'])
        self.assertFalse(declaration['key_conversion_verified'])
        self.assertFalse(report['publication_authorized'])

    def test_lookup_evaluated_by_constant_helper_is_not_slot_value_lineage(self):
        program = 'def constant(ignored):\n    return 0\n' + PROGRAM.replace(
            '{"value":selected[requested]}', '{"value":constant(selected[requested])}')
        report, slot = self.report(program)
        self.assertEqual({d.get('consumer_role') for d in slot['lookup_values']['declarations']}, {'evaluated_argument'})
        self.assertFalse(report['publication_authorized'])

    def test_ignored_conversion_argument_is_not_labelled_value_origin(self):
        program = PROGRAM.replace('def number(row, key):\n    return int(row.get(key))',
            'def constant(ignored):\n    return 0\ndef number(row, key):\n    return constant(row.get(key))')
        report, slot = self.report(program)
        declaration, = slot['lookup_values']['declarations']
        self.assertEqual({r['read_role'] for r in declaration['map_key_reads'] + declaration['map_value_reads']}, {'evaluated_argument'})
        self.assertFalse(declaration['runtime_value_verified'])
        self.assertFalse(report['publication_authorized'])
        # Reading a whole mapping as an argument is not a field read, either.
        _, slot = self.report(PROGRAM.replace('return int(row.get(key))', 'return 0'))
        self.assertEqual(slot['lookup_values']['declarations'], [])

    def test_selected_tuple_item_is_not_last_assignment_or_first_item(self):
        _,slot=self.report(PROGRAM.replace('ignored, selected=','selected, ignored='))
        declaration,=slot['lookup_values']['declarations']
        self.assertEqual({r['result_label'] for r in declaration['map_value_reads']},{'Value'})

    def test_tuple_arity_and_star_unpack_do_not_pick_an_element(self):
        for lhs in ['ignored, selected, extra=','*ignored, selected=']:
            with self.subTest(lhs=lhs):
                _,slot=self.report(PROGRAM.replace('ignored, selected=',lhs))
                self.assertEqual(slot['lookup_values']['declarations'],[])

    def test_unknown_get_key_or_mismatched_case_does_not_guess_value_field(self):
        for call in ['number(row,"id")','number(row,key)','row.get("Id", 42)']:
            with self.subTest(call=call):
                _,slot=self.report(PROGRAM.replace('number(row,"Value"):number(row,"Id")','number(row,"Value"):'+call))
                self.assertEqual(slot['lookup_values']['declarations'],[])

    def test_filter_and_conditional_reads_are_not_hidden(self):
        program=PROGRAM.replace('number(row,"Value"):number(row,"Id") for row in rows',
                                'number(row,"Value"):(row["Id"] if row["Value"] else row["Id"]) for row in rows if row["Id"]')
        _,slot=self.report(program)
        declaration,=slot['lookup_values']['declarations']
        self.assertTrue(declaration['filter_refs'])
        self.assertIn('condition',{r['read_role'] for r in declaration['map_value_reads']})
        self.assertFalse(declaration['runtime_value_verified'])

    def test_multiple_iterators_are_not_assumed_one_query_mapping(self):
        program=PROGRAM.replace('number(row,"Value"):number(row,"Id") for row in rows',
                                'row["Value"]:other["Id"] for row in rows for other in rows')
        _,slot=self.report(program)
        self.assertEqual(slot['lookup_values']['declarations'],[])


if __name__=='__main__':
    unittest.main()
