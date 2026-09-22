"""Python SQL argument declarations, never executable rows or trusted lineage."""
import hashlib
import json
import unittest

from dataflow_discovery.python_bind_values import analyze_python_bind_arguments
from dataflow_discovery.snapshot import SourceFile


def analyze(text):
    raw = text.encode()
    return analyze_python_bind_arguments(SourceFile('case.py', text, hashlib.sha256(raw).hexdigest(), len(raw)), entrypoint='run')


class BindValueTests(unittest.TestCase):
    def test_helper_parameter_to_list_to_generator_mapping_keeps_actual_path(self):
        report = analyze('''def send(conn, sql, rows):
    values = list(rows)
    if values:
        conn.execute(sql, values)
def run(engine, products):
    with engine.begin() as conn:
        send(conn, "UPDATE dbo.Products SET Price=:price", ({"price": row.amount} for row in products))
''')
        self.assertEqual(report['findings'], [])
        self.assertEqual(len(report['uses']), 1)
        nodes = report['nodes']
        self.assertTrue(any(n['kind']=='parameter' and n['name']=='rows' for n in nodes))
        self.assertTrue(any(n['kind']=='assignment' and n['name']=='values' for n in nodes))
        self.assertTrue(any(n['kind']=='mapping_literal' and n['fields'][0]['name']=='price' for n in nodes))
        self.assertTrue(any(n['kind']=='attribute' and n['attribute']=='amount' for n in nodes))
        generator = next(n for n in nodes if n['kind']=='declared_comprehension')
        self.assertTrue(generator['deferred'])
        self.assertFalse(generator['consumed_verified'])
        self.assertFalse(report['python_values_verified'])

    def test_repeated_sql_uses_do_not_reexpand_the_same_argument_transport(self):
        prefix = 'def relay(values):\n    return values\ndef send(conn, payload):\n'
        statement = '    conn.execute("UPDATE dbo.T SET x=:x", payload)\n'
        suffix = 'def run(engine, origin):\n    rows = relay([{"x":item.amount} for item in origin])\n    with engine.begin() as conn:\n        send(conn, rows)\n'
        one = analyze(prefix + statement + suffix)
        many = analyze(prefix + statement * 20 + suffix)
        self.assertEqual(len(many['uses']), 20)
        self.assertEqual(many['findings'], [])
        # Each later SQL call needs its own parameter reference and an escape
        # finding: this syntax does not prove an arbitrary execute receiver leaves
        # the supplied object untouched. The shared transport is still built once.
        self.assertLessEqual(len(many['nodes']), len(one['nodes']) + 2 * (len(many['uses']) - 1))
        nodes = {node['id']:node for node in many['nodes']}
        self.assertTrue(all(nodes[use['parameter_ref']]['reason'] == 'object_escape_effects_unverified'
                            for use in many['uses'][1:]))
        self.assertFalse(many['python_values_verified'])

    def test_shared_invocation_does_not_reuse_a_value_across_mutation(self):
        report = analyze('''def run(engine):
    params = {"x":1}
    with engine.begin() as conn:
        conn.execute("UPDATE dbo.T SET x=:x", params)
        params["x"] = 2
        conn.execute("UPDATE dbo.T SET x=:x", params)
''')
        nodes = {node['id']:node for node in report['nodes']}
        self.assertEqual(nodes[report['uses'][0]['parameter_ref']]['kind'], 'assignment')
        self.assertEqual(nodes[report['uses'][1]['parameter_ref']]['reason'], 'container_item_mutation')

    def test_reordered_keyword_calls_keep_separate_parameter_origins(self):
        report = analyze('''def send(conn, sql, rows):
    conn.execute(sql, rows)
def run(engine, left, right):
    with engine.begin() as conn:
        send(rows={"x": left.amount}, conn=conn, sql="UPDATE dbo.T SET x=:x")
        send(conn, "UPDATE dbo.T SET x=:x", {"x": right.amount})
''')
        self.assertEqual(len(report['uses']), 2)
        self.assertNotEqual(report['uses'][0]['parameter_ref'], report['uses'][1]['parameter_ref'])
        self.assertNotEqual(report['uses'][0]['call_path'], report['uses'][1]['call_path'])
        self.assertTrue(any(n.get('name')=='left' for n in report['nodes']))
        self.assertTrue(any(n.get('name')=='right' for n in report['nodes']))

    def test_literal_contents_not_exported_and_dynamic_keys_not_invented(self):
        report = analyze('''def run(engine, key):
    with engine.begin() as conn:
        conn.execute("UPDATE dbo.T SET x=:x", {"x": "PRIVATE_LITERAL_NOT_EXPORTED"})
        conn.execute("UPDATE dbo.T SET x=:x", {key: 1})
''')
        self.assertNotIn('PRIVATE_LITERAL_NOT_EXPORTED', json.dumps(report))
        self.assertTrue(any(n.get('reason')=='dynamic_or_duplicate_mapping_keys' for n in report['nodes']))

    def test_reassigned_parameter_is_not_bound_to_old_argument(self):
        report = analyze('''def send(conn, sql, rows):
    rows = {"replacement": 0}
    conn.execute(sql, rows)
def run(engine):
    with engine.begin() as conn:
        send(conn, "UPDATE dbo.T SET x=:x", {"original": 1})
''')
        nodes = {n['id']:n for n in report['nodes']}
        reference = nodes[report['uses'][0]['parameter_ref']]
        self.assertEqual(reference['kind'], 'assignment')
        self.assertEqual(nodes[reference['value_ref']]['fields'][0]['name'], 'replacement')

    def test_conditional_non_dominating_definition_does_not_select_a_value(self):
        report = analyze('''def run(engine, flag):
    if flag:
        params = {"x": 1}
    with engine.begin() as conn:
        conn.execute("UPDATE dbo.T SET x=:x", params)
''')
        self.assertTrue(any(n.get('reason')=='assignment_not_dominating' for n in report['nodes']))

    def test_opposite_if_branch_does_not_supply_a_definition(self):
        report = analyze('''def run(engine, flag):
    with engine.begin() as conn:
        if flag:
            params = {"x": 1}
        else:
            conn.execute("UPDATE dbo.T SET x=:x", params)
''')
        self.assertTrue(any(n.get('reason')=='assignment_not_dominating' for n in report['nodes']))

    def test_append_collection_keeps_iteration_calculation_and_lookup_distinct(self):
        report = analyze('''def run(engine, source, keys):
    rows = []
    for row in source:
        rows.append({"key": keys[row.source_id], "amount": row.qty * row.price})
    with engine.begin() as conn:
        conn.execute("UPDATE dbo.T SET x=:x", rows)
''')
        nodes = report['nodes']
        collection = next(n for n in nodes if n['kind']=='declared_append_collection')
        self.assertFalse(collection['contents_verified'])
        self.assertTrue(collection['appends'][0]['guards'])
        self.assertTrue(any(n['kind']=='iteration_element' for n in nodes))
        self.assertTrue(any(n['kind']=='lookup' for n in nodes))
        self.assertTrue(any(n['kind']=='binary_expression' and n['operator']=='Mult' for n in nodes))

    def test_container_item_mutation_does_not_reuse_initial_literal_as_value(self):
        report = analyze('''def run(engine):
    params = {"x": 1}
    params["x"] = 2
    with engine.begin() as conn:
        conn.execute("UPDATE dbo.T SET x=:x", params)
''')
        node = next(n for n in report['nodes'] if n['id']==report['uses'][0]['parameter_ref'])
        self.assertEqual(node['kind'], 'unresolved')

    def test_parameter_method_mutation_is_not_ignored(self):
        report = analyze('''def send(conn, sql, rows):
    rows.clear()
    conn.execute(sql, rows)
def run(engine):
    with engine.begin() as conn:
        send(conn, "UPDATE dbo.T SET x=:x", {"x": 1})
''')
        node = next(n for n in report['nodes'] if n['id']==report['uses'][0]['parameter_ref'])
        self.assertEqual(node.get('reason'), 'parameter_object_method_effects')

    def test_list_helper_declarations_link_sql_slot_to_different_python_attribute(self):
        from pathlib import Path
        import tempfile
        from dataflow_discovery.host import capture_and_analyze
        from dataflow_discovery.python_catalog import bind_python_sql_dependencies
        from dataflow_discovery.python_bind_values import bind_python_parameter_declarations
        from tests.test_dataflow_discovery_catalog import Reader, scope
        text = '''def make_rows(source):
    result = []
    for row in source:
        result.append({"amount": row.net, "lookup": row.identifier})
    return result
def send(conn, sql, rows):
    values = list(rows)
    conn.execute(sql, values)
def run(engine, source):
    with engine.begin() as conn:
        send(conn, "UPDATE dbo.Orders SET Amount=:amount WHERE OrderID=:lookup", make_rows(source))
'''
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'case.py').write_text(text)
            captured = capture_and_analyze(directory, ['case.py'], source_id='transport-case')
            reader = Reader()
            described = bind_python_sql_dependencies(captured.analysis, captured.snapshot, path='case.py', entrypoint='run', scopes_by_context={}, reader=reader)
            scopes = {context['context_id']:scope() for context in described['contexts']}
            report = bind_python_parameter_declarations(captured.analysis, captured.snapshot, path='case.py', entrypoint='run', scopes_by_context=scopes, reader=reader)
        slot, = report['contexts'][0]['write_statements'][0]['slots']
        declaration, = slot['python_declarations']
        nodes = {node['id']:node for node in report['transport']['nodes']}
        self.assertEqual(declaration['parameter_name'], 'amount')
        self.assertEqual(nodes[declaration['value_ref']]['attribute'], 'net')
        self.assertEqual(slot['field_path'], 'amount')
        self.assertEqual(report['status'], 'INCONCLUSIVE')
        self.assertFalse(report['python_values_verified'])
        self.assertFalse(report['publication_authorized'])

    def test_python_computation_is_not_executed(self):
        report = analyze('''def dangerous():
    raise RuntimeError("MUST_NOT_EXECUTE")
def run(engine):
    with engine.begin() as conn:
        conn.execute("UPDATE dbo.T SET x=:x", {"x": dangerous()})
''')
        self.assertFalse(report['source_executed'])
        self.assertFalse(report['publication_authorized'])
        self.assertTrue(any(n['kind']=='call' and not n['result_verified'] for n in report['nodes']))


if __name__ == '__main__':
    unittest.main()
