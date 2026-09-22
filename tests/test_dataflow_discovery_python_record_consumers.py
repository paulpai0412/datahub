from pathlib import Path
import tempfile
import unittest

from dataflow_discovery.host import capture_and_analyze
from dataflow_discovery.python_catalog import bind_python_sql_dependencies
from dataflow_discovery.python_bind_values import analyze_python_bind_arguments
from dataflow_discovery.python_record_consumers import bind_python_record_consumers
from tests.test_dataflow_discovery_catalog import Reader, scope, urn
from tests.test_dataflow_discovery_python_decoders import source


PROGRAM='''from dataclasses import dataclass
@dataclass(frozen=True)
class Item:
    decoded: int
@dataclass(frozen=True)
class Bundle:
    entries: tuple
    @property
    def count(self):
        return len(self.entries)
def fetch_rows(conn, sql):
    result=conn.execute(sql)
    return list(result.mappings().all())
def decode(rows):
    return tuple(Item(row["raw"]) for row in rows)
def produce(engine):
    with engine.connect() as conn:
        items=decode(fetch_rows(conn,"SELECT Amount AS raw FROM dbo.Orders"))
    packet=Bundle(items)
    return packet
def load(conn, packet):
    unused=(row for row in [])
    payload=[]
    for row in packet.entries:
        payload.append({"value":row.decoded})
    conn.execute("UPDATE dbo.Orders SET Amount=:value",payload)
def run(source, target):
    packet=produce(source)
    with target.begin() as conn:
        load(conn,packet)
'''


# Independent telemetry-routing shape: no domain-specific bundle, dimension
# loader, or lookup. Two calls share producer AST but not resource identity.
ROUTER = '''from dataclasses import dataclass
@dataclass(frozen=True)
class Sample:
    measurement: int
def fetch(conn, statement):
    result = conn.execute(statement)
    return list(result.mappings().all())
def decode_samples(records):
    return tuple(Sample(record["reading"]) for record in records)
def stream(engine):
    with engine.connect() as conn:
        return decode_samples(fetch(conn, "SELECT Amount AS reading FROM dbo.Orders"))
def forward(*, values):
    return values
def store(conn, samples):
    parameters = [{"measurement":sample.measurement} for sample in samples]
    conn.execute("UPDATE dbo.Orders SET Amount=:measurement", parameters)
def run(left, right, destination):
    first = stream(left)
    second = stream(right)
    selected = forward(values=first)
    with destination.begin() as conn:
        store(conn, selected)
'''


class RecordConsumerTests(unittest.TestCase):
    def report(self, program=PROGRAM, policies=None):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        (Path(directory.name)/'case.py').write_text(program)
        captured=capture_and_analyze(directory.name,['case.py'],source_id='record-consumer-case')
        reader=Reader([urn(),urn('other'),urn('target')])
        described=bind_python_sql_dependencies(captured.analysis,captured.snapshot,path='case.py',entrypoint='run',scopes_by_context={},reader=reader)
        scopes={c['context_id']:(policies[index] if policies else scope()) for index,c in enumerate(described['contexts'])}
        return bind_python_record_consumers(captured.analysis,captured.snapshot,path='case.py',entrypoint='run',scopes_by_context=scopes,reader=reader)

    def slots(self,report):
        return [s for c in report['contexts'] for statement in c['write_statements'] for s in statement['slots']]

    def test_keyword_only_identity_helper_keeps_producer_invocation(self):
        report = self.report(ROUTER, [scope(), scope('Other'), scope('Target')])
        slot, = self.slots(report)
        links = slot['record_consumer']['links']
        self.assertTrue(links)
        self.assertEqual({origin['dataset_urn'] for link in links for origin in link['origins']}, {urn()})
        self.assertEqual({link['record_field'] for link in links}, {'measurement'})
        self.assertTrue(all(not link['runtime_value_verified'] for link in links))
        self.assertFalse(report['publication_authorized'])
        self.assertIn('helper_return_effects_unverified', {f['reason'] for link in links for f in link['chain_findings']})

    def test_transfer_argument_change_selects_other_producer_not_all_inputs(self):
        report = self.report(ROUTER.replace('selected = forward(values=first)', 'selected = forward(values=second)'),
                             [scope(), scope('Other'), scope('Target')])
        slot, = self.slots(report)
        self.assertEqual({o['dataset_urn'] for link in slot['record_consumer']['links'] for o in link['origins']}, {urn('other')})

    def test_discarding_helper_does_not_inherit_evaluated_collection_argument(self):
        report = self.report(ROUTER.replace('return values', 'return ()'), [scope(), scope('Other'), scope('Target')])
        slot, = self.slots(report)
        self.assertEqual(slot['record_consumer']['links'], [])

    def test_generator_return_is_not_the_collection_returned_by_call(self):
        for body in ['yield ()\n    return values', 'yield from ()\n    return values']:
            with self.subTest(body=body):
                source = ROUTER.replace('return values', body)
                slot, = self.slots(self.report(source, [scope(), scope('Other'), scope('Target')]))
                self.assertEqual(slot['record_consumer']['links'], [])

    def test_conditional_single_return_retains_guard_without_success_claim(self):
        source = ROUTER.replace('return values', 'if opaque():\n        return values')
        report = self.report(source, [scope(), scope('Other'), scope('Target')])
        nodes = {node['id']:node for node in report['transport']['nodes']}
        call, = [node for node in nodes.values() if node['kind'] == 'call'
                 and nodes[node['callee_ref']].get('name') == 'forward']
        self.assertEqual([(g['kind'],g['branch']) for g in call['declared_return_guards']], [('If','body')])
        self.assertFalse(call['result_verified'])
        self.assertEqual(report['status'], 'INCONCLUSIVE')
        self.assertFalse(report['publication_authorized'])

    def test_multiple_return_paths_are_not_resolved_by_picking_one(self):
        source = ROUTER.replace('return values', 'if opaque():\n        return values\n    return ()')
        slot, = self.slots(self.report(source, [scope(), scope('Other'), scope('Target')]))
        self.assertEqual(slot['record_consumer']['links'], [])

    def test_direct_record_return_does_not_require_named_local_initializer(self):
        source = ROUTER.replace('def forward(*, values):\n    return values',
            '@dataclass(frozen=True)\nclass Envelope:\n    contents: tuple\ndef forward(*, values):\n    return Envelope(values)')
        source = source.replace('store(conn, selected)', 'store(conn, selected.contents)')
        slot, = self.slots(self.report(source, [scope(), scope('Other'), scope('Target')]))
        self.assertEqual({o['dataset_urn'] for link in slot['record_consumer']['links'] for o in link['origins']}, {urn()})

    def test_returned_container_to_consumer_preserves_guarded_declarations(self):
        report=self.report()
        slot,=self.slots(report)
        link,=slot['record_consumer']['links']
        self.assertEqual(link['record_field'],'decoded')
        self.assertEqual(link['result_label'],'raw')
        self.assertEqual(link['origins'][0]['field_path'],'amount')
        self.assertEqual(link['consumer_role'],'value')
        self.assertNotIn('assignment_not_dominating',{f['reason'] for f in link['chain_findings']})
        self.assertTrue(any(node.get('successful_use_only') and
                            any(guard['kind'] == 'With' for guard in node.get('guards', []))
                            for node in report['transport']['nodes']))
        self.assertFalse(link['runtime_value_verified'])
        self.assertFalse(report['publication_authorized'])
        self.assertEqual(report['status'],'INCONCLUSIVE')

    def test_same_producer_ast_is_not_collapsed_across_invocations(self):
        program=PROGRAM[:PROGRAM.index('def run(')]+'''def run(left, right, target):
    first=produce(left)
    second=produce(right)
    with target.begin() as conn:
        load(conn,first)
        load(conn,second)
'''
        report=self.report(program,[scope(),scope('Other'),scope('Target'),scope('Target')])
        first,second=self.slots(report)
        a,=first['record_consumer']['links'];b,=second['record_consumer']['links']
        self.assertEqual(a['origins'][0]['dataset_urn'],urn())
        self.assertEqual(b['origins'][0]['dataset_urn'],urn('other'))
        self.assertNotEqual(a['producer_context_id'],b['producer_context_id'])

    def test_lookup_key_is_not_a_lookup_result_value(self):
        program=PROGRAM.replace('def load(conn, packet):','def load(conn, packet, keys=None):').replace('"value":row.decoded','"value":keys[row.decoded]')
        slot,=self.slots(self.report(program))
        link,=slot['record_consumer']['links']
        self.assertEqual(link['consumer_role'],'lookup_key')
        self.assertIn('lookup_result_value_unverified',{gap['reason'] for gap in slot['record_consumer']['unresolved']})
        self.assertFalse(slot['record_consumer']['runtime_value_verified'])

    def test_non_field_property_or_custom_initialization_does_not_supply_collection(self):
        for program in [PROGRAM.replace('row in packet.entries','row in packet.count'),
                        PROGRAM.replace('def count(self):','def entries(self):'),
                        PROGRAM.replace('def count(self):','def __post_init__(self):')]:
            with self.subTest(program=program):
                self.assertFalse(any(s['record_consumer']['links'] for s in self.slots(self.report(program))))

    def test_comprehension_target_does_not_rebind_function_loop_variable(self):
        report=analyze_python_bind_arguments(source('''def run(engine, data):
    unused=(row for row in [])
    rows=[]
    for row in data:
        rows.append({"value":row.amount})
    with engine.begin() as conn:
        conn.execute("UPDATE dbo.Orders SET Amount=:value",rows)
'''),entrypoint='run')
        nodes={n['id']:n for n in report['nodes']}
        attribute=next(n for n in nodes.values() if n['kind']=='attribute' and n['attribute']=='amount')
        self.assertEqual(nodes[attribute['owner_ref']]['kind'],'iteration_element')

    def test_shared_branch_graph_has_a_bounded_traversal(self):
        from dataflow_discovery.python_record_consumers import _unfold
        from dataflow_discovery.catalog import CatalogBindingError
        nodes: dict[str, dict] = {'v0':{'id':'v0','kind':'call'}}
        for index in range(1,15):
            nodes[f'v{index}']={'id':f'v{index}','kind':'boolean_choice','operands':[f'v{index-1}',f'v{index-1}']}
        with self.assertRaisesRegex(CatalogBindingError,'record_consumer_traversal_limit'):
            _unfold('v14',nodes)

    def test_missing_decoder_field_is_not_joined_by_query_or_target_name(self):
        report=self.report(PROGRAM.replace('"value":row.decoded','"value":row.raw'))
        slot,=self.slots(report)
        self.assertEqual(slot['record_consumer']['links'],[])


if __name__=='__main__':
    unittest.main()
