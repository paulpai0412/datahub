import hashlib
import json
import unittest

from dataflow_discovery.python_decoders import analyze_python_decoder
from dataflow_discovery.snapshot import SourceFile


def source(text):
    raw = text.encode()
    return SourceFile('decoder.py', text, hashlib.sha256(raw).hexdigest(), len(raw))


def analyze(text):
    return analyze_python_decoder(source(text), entrypoint='decode')


class DecoderTests(unittest.TestCase):
    def test_positional_keyword_and_input_owner_are_not_name_matching(self):
        report = analyze('''from dataclasses import dataclass as dc
@dc(frozen=True)
class Output:
    target_id: int
    label: str
def decode(rows):
    return tuple(Output(row["source_number"], label=row["source_title"]) for row in rows)
''')
        record, = report['records']
        self.assertEqual(record['record_type'], 'Output')
        self.assertEqual([f['name'] for f in record['fields']], ['target_id','label'])
        self.assertEqual([(f['input_reads'][0]['input_parameter'],f['input_reads'][0]['field_name']) for f in record['fields']], [('rows','source_number'),('rows','source_title')])
        self.assertFalse(report['runtime_values_verified'])
        self.assertFalse(report['transformation_semantics_verified'])
        self.assertFalse(report['publication_authorized'])

    def test_escaped_return_collection_only_describes_prior_records(self):
        report = analyze('''from dataclasses import dataclass
@dataclass
class Entry:
    value: int
def decode(rows):
    result = []
    for row in rows:
        result.append(Entry(row["reading"]))
    opaque(result)
    return result
''')
        record, = report['records']
        self.assertEqual(record['collection_findings'], ['object_escape_effects_unverified'])
        field, = record['fields']
        self.assertEqual([(r['field_name'],r['role']) for r in field['input_reads']], [('reading','prior_declaration')])
        self.assertFalse(report['runtime_values_verified'])
        self.assertFalse(report['publication_authorized'])

    def test_helpers_conversions_and_nullable_condition_remain_separate(self):
        report = analyze('''from dataclasses import dataclass
@dataclass
class Output:
    value: int | None
def convert(value):
    if value < 0:
        raise ValueError("PRIVATE_ERROR_LITERAL")
    return int(value)
def decode(rows):
    return [Output(None if row["nullable"] is None else convert(row["raw"])) for row in rows]
''')
        field = report['records'][0]['fields'][0]
        self.assertEqual({(r['field_name'],r['role']) for r in field['input_reads']}, {('nullable','condition'),('raw','evaluated_argument')})
        helper, = report['helpers']
        self.assertEqual(helper['function'], 'convert')
        self.assertEqual(len(helper['raises']),1)
        self.assertEqual(len(helper['conditions']),1)
        self.assertNotIn('PRIVATE_ERROR_LITERAL', json.dumps(report))

    def test_constant_helper_reads_argument_without_value_lineage(self):
        report = analyze('''from dataclasses import dataclass
@dataclass
class Output:
    value: int
def constant(ignored):
    return 0
def decode(rows):
    return [Output(constant(row["raw"])) for row in rows]
''')
        field = report['records'][0]['fields'][0]
        self.assertEqual({(r['field_name'], r['role']) for r in field['input_reads']}, {('raw', 'evaluated_argument')})
        self.assertFalse(report['transformation_semantics_verified'])
        self.assertFalse(report['publication_authorized'])

    def test_helper_return_declaration_is_separate_from_argument_evaluation(self):
        report = analyze('''from dataclasses import dataclass
@dataclass
class Output:
    value: int
def select(first, *, second):
    return second
def decode(rows):
    return [Output(select(row["unused"], second=row["chosen"])) for row in rows]
''')
        field = report['records'][0]['fields'][0]
        self.assertEqual({(r['field_name'], r['role']) for r in field['input_reads']},
            {('unused', 'evaluated_argument'), ('chosen', 'evaluated_argument'), ('chosen', 'return_declaration')})
        self.assertFalse(report['runtime_values_verified'])

    def test_append_local_alias_and_derived_value_keep_all_operands(self):
        report = analyze('''from dataclasses import dataclass
@dataclass
class Output:
    value: int
def combine(a,b):
    return a*b
def decode(rows):
    result = []
    for row in rows:
        quantity = row["qty"]
        result.append(Output(combine(quantity, row["price"])))
    return tuple(result)
''')
        field = report['records'][0]['fields'][0]
        self.assertEqual({r['field_name'] for r in field['input_reads']}, {'qty','price'})
        self.assertEqual([h['function'] for h in report['helpers']], ['combine'])
        self.assertTrue(any(n['kind']=='binary_expression' and n['operator']=='Mult' for n in report['nodes']))

    def helper_return(self, body):
        report = analyze('from dataclasses import dataclass\n@dataclass\nclass Output:\n    value: object\ndef convert(value):\n'
                         + body + '\ndef decode(rows):\n    return [Output(convert(row["raw"])) for row in rows]\n')
        helper, = report['helpers']
        nodes = {node['id']: node for node in report['nodes']}
        return report, nodes[helper['returns'][-1]['value_ref']], nodes

    def test_aborting_handlers_preserve_assignment_on_normal_continuation(self):
        for handlers in [
            '    except TypeError:\n        raise ValueError("PRIVATE_FAILURE") from None\n',
            '    except (TypeError, ValueError):\n        raise\n',
            '    except TypeError:\n        raise\n    except ValueError:\n        raise\n',
        ]:
            with self.subTest(handlers=handlers):
                report, returned, nodes = self.helper_return(
                    '    try:\n        result = value * 2\n' + handlers + '    return result\n')
                self.assertEqual(returned['kind'], 'assignment')
                self.assertEqual(nodes[returned['value_ref']]['operator'], 'Mult')
                self.assertFalse(report['runtime_values_verified'])
                self.assertFalse(report['transformation_semantics_verified'])
                self.assertFalse(report['publication_authorized'])
                self.assertNotIn('PRIVATE_FAILURE', json.dumps(report))

    def test_non_dominating_or_unsupported_try_paths_stay_unresolved(self):
        bodies = [
            '    try:\n        result = value * 2\n    except* TypeError:\n        pass\n',
            '    try:\n        result = value * 2\n    except TypeError:\n        pass\n',
            '    try:\n        result = value * 2\n    except TypeError:\n        if value:\n            raise\n',
            '    try:\n        result = value * 2\n    except TypeError:\n        raise\n    except ValueError:\n        pass\n',
            '    try:\n        if value:\n            result = value * 2\n    except TypeError:\n        raise\n',
            '    if value:\n        try:\n            result = value * 2\n        except TypeError:\n            raise\n',
            '    with suppress(TypeError):\n        try:\n            result = value * 2\n        except TypeError:\n            raise\n',
            '    match value:\n        case 1:\n            try:\n                result = value * 2\n            except TypeError:\n                raise\n',
            '    try:\n        try:\n            result = value * 2\n        except TypeError:\n            raise\n    except* TypeError:\n        pass\n',
            '    try:\n        result = value * 2\n    except TypeError:\n        raise\n    finally:\n        pass\n',
            '    try:\n        result = value * 2\n    except TypeError:\n        raise\n    else:\n        pass\n',
        ]
        for body in bodies:
            with self.subTest(body=body):
                _, returned, _ = self.helper_return(body + '    return result\n')
                self.assertEqual(returned['kind'], 'unresolved')
                self.assertEqual(returned['reason'], 'assignment_not_dominating')
        _, returned, _ = self.helper_return(
            '    try:\n        result = value * 2\n    except TypeError:\n        raise\n    result.change()\n    return result\n')
        self.assertEqual(returned['reason'], 'mutation_unresolved')

    def test_aborting_handler_does_not_prove_assignment_inside_that_handler(self):
        _, returned, _ = self.helper_return(
            '    try:\n        result = value * 2\n    except TypeError:\n        return result\n')
        self.assertEqual(returned['reason'], 'assignment_not_dominating')

    def test_invalidated_value_only_retains_prior_declaration(self):
        report = analyze('''from dataclasses import dataclass
@dataclass
class Output:
    value: object
def decode(rows):
    result = []
    for row in rows:
        value = row["raw"]
        value.change()
        result.append(Output(value))
    return result
''')
        field = report['records'][0]['fields'][0]
        self.assertEqual({r['role'] for r in field['input_reads']}, {'prior_declaration'})
        self.assertTrue(any(n['reason']=='mutation_unresolved' for n in field['unresolved']))

    def test_constructor_argument_errors_do_not_produce_records(self):
        for arguments in ['row["a"], value=row["a"]', '**row', '', 'row["a"], row["b"]', 'other=row["a"]', '*row']:
            with self.subTest(arguments=arguments):
                report = analyze('from dataclasses import dataclass\n@dataclass\nclass Output:\n    value: int\ndef decode(rows):\n    return [Output('+arguments+') for row in rows]\n')
                self.assertEqual(report['records'], [])
                self.assertTrue(report['findings'])

    def test_non_plain_dataclasses_are_not_given_default_constructor_semantics(self):
        cases = [
            '@dataclass(init=False)\nclass Output:\n    value: int',
            '@dataclass(kw_only=True)\nclass Output:\n    value: int',
            '@dataclass\nclass Output:\n    value: int = 1',
            '@dataclass\nclass Output:\n    value: int\n    def __post_init__(self):\n        self.value=0',
            '@dataclass\nclass Output:\n    value: ClassVar[int]',
            '@dataclass\nclass Output:\n    value: InitVar[int]',
            '@dataclass\nclass Output:\n    value: "int"',
            '@dataclass\nclass Output(Base):\n    value: int',
        ]
        for case in cases:
            with self.subTest(case=case):
                report = analyze('from dataclasses import dataclass, InitVar\nfrom typing import ClassVar\n'+case+'\ndef decode(rows):\n    return [Output(row["a"]) for row in rows]\n')
                self.assertEqual(report['records'], [])

    def test_constructor_parameter_and_exception_binding_shadow_class(self):
        prefix = 'from dataclasses import dataclass\n@dataclass\nclass Output:\n    value: int\n'
        bodies = [
            'def decode(rows, Output):\n    return [Output(row["a"]) for row in rows]\n',
            'def decode(rows):\n    try:\n        risky()\n    except Exception as Output:\n        return [Output(row["a"]) for row in rows]\n',
        ]
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(analyze(prefix+body)['records'], [])

    def test_only_returned_records_and_no_source_execution(self):
        report = analyze('''from dataclasses import dataclass
raise RuntimeError("MUST_NOT_EXECUTE_MODULE")
@dataclass
class Output:
    value: int
def decode(rows):
    discarded = [Output(row["unused"]) for row in rows]
    return 3
''')
        self.assertEqual(report['records'], [])
        self.assertFalse(report['source_executed'])
        self.assertNotIn('MUST_NOT_EXECUTE_MODULE', json.dumps(report))

    def test_nested_iteration_is_not_flattened_into_one_input_row(self):
        report = analyze('''from dataclasses import dataclass
@dataclass
class Output:
    value: int
def decode(rows):
    return [Output(cell["value"]) for row in rows for cell in row]
''')
        read, = report['records'][0]['fields'][0]['input_reads']
        self.assertIsNone(read['input_parameter'])
        self.assertFalse(read['input_owner_described'])

    def test_integrity_and_entrypoint_are_checked(self):
        original = source('def decode(rows):\n    return rows\n')
        with self.assertRaises(ValueError):
            analyze_python_decoder(SourceFile(original.path, original.text+'# drift', original.sha256, original.size_bytes),entrypoint='decode')
        with self.assertRaisesRegex(ValueError,'invalid_python_decoder_entrypoint'):
            analyze_python_decoder(original,entrypoint='unknown')


if __name__ == '__main__':
    unittest.main()
