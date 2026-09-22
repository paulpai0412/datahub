from pathlib import Path
import json
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/run-dm01-canary.mjs'
RECEIPT = Path('.local/evidence/dataflow-discovery/dm01-canary-run-20260914.json')
PROPOSAL = Path('.local/evidence/dataflow-discovery/dm01-canary-proposal-20260914.json')


class CanaryOperatorTests(unittest.TestCase):
    def invoke(self, root, *args):
        blocker = root / 'no-network.mjs'
        blocker.write_text('globalThis.fetch = () => { throw new Error("unexpected_network_call"); };\n')
        return subprocess.run(['node', '--import', str(blocker), str(SCRIPT), *args], cwd=root, capture_output=True, text=True, timeout=15)

    def test_flag_required_before_credentials_or_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.invoke(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn('explicit_batch_flag_required', result.stdout)
            self.assertFalse((root / RECEIPT).exists())

    def test_malformed_json_is_caught_without_disclosing_body_or_mutating(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / PROPOSAL).parent.mkdir(parents=True)
            (root / PROPOSAL).write_text('SENSITIVE_FIXTURE_not_json')
            result = self.invoke(root, '--execute-approved-batch')
            receipt = json.loads((root / RECEIPT).read_text())
            self.assertEqual(result.returncode, 1)
            self.assertEqual(receipt['error'], 'SyntaxError')
            self.assertFalse(receipt['sourceMutationAttempted'])
            self.assertFalse(receipt['executionMutationAttempted'])
            self.assertNotIn('SENSITIVE_FIXTURE', result.stdout + result.stderr + (root / RECEIPT).read_text())

    def test_edited_recipe_cannot_use_previous_approval(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / PROPOSAL).parent.mkdir(parents=True)
            (root / PROPOSAL).write_text(json.dumps({'source_urn': 'urn:li:dataHubIngestionSource:a513e611-5631-4cf2-8b96-3fa9fd1fee51', 'expected_source_version': '3', 'expected_recipe_sha256': 'b5fe9c11ee6c7117abc5a0918da29a86d2edaff49ea20918b5b2277916ed2d70', 'proposed_recipe': '{}'}))
            result = self.invoke(root, '--execute-approved-batch')
            receipt = json.loads((root / RECEIPT).read_text())
            self.assertEqual(result.returncode, 1)
            self.assertEqual(receipt['error'], 'approved_proposal_mismatch')
            self.assertFalse(receipt['sourceMutationAttempted'])
            self.assertFalse(receipt['executionMutationAttempted'])

    def test_resume_refuses_a_possible_prior_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / RECEIPT).parent.mkdir(parents=True)
            prior = {'sourceUrn': 'urn:li:dataHubIngestionSource:a513e611-5631-4cf2-8b96-3fa9fd1fee51', 'phase': 'conditional_source_update', 'error': 'http_412', 'sourceMutationAttempted': True, 'executionMutationAttempted': True, 'requestId': '597819ae-27cb-4f94-b0b7-fa3fe8900346'}
            original = json.dumps(prior)
            (root / RECEIPT).write_text(original)
            result = self.invoke(root, '--resume-reconciled-create-mode-412')
            resumed = json.loads((root / RECEIPT.with_name('dm01-canary-resumed-20260914.json')).read_text())
            self.assertEqual(result.returncode, 1)
            self.assertEqual(resumed['error'], 'resume_precondition_not_proven')
            self.assertFalse(resumed['sourceMutationAttempted'])
            self.assertFalse(resumed['executionMutationAttempted'])
            self.assertEqual((root / RECEIPT).read_text(), original)

    def test_existing_receipt_is_not_overwritten_or_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / RECEIPT).parent.mkdir(parents=True)
            original = '{"status":"UNKNOWN_RECONCILE"}'
            (root / RECEIPT).write_text(original)
            result = self.invoke(root, '--execute-approved-batch')
            self.assertEqual(result.returncode, 1)
            self.assertIn('receipt_exists_reconcile_do_not_replay', result.stdout)
            self.assertEqual((root / RECEIPT).read_text(), original)


if __name__ == '__main__':
    unittest.main()
