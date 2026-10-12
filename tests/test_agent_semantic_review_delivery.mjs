import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { semanticCatalogFixture } from './fixtures/semantic-catalog-fixture.mjs';
import { semanticReviewDetailPage } from '../extensions/datahub-agent/integration/native-semantic-tasks.mjs';
import { loadSemanticReview } from '../extensions/datahub-agent/mfe/semantic-review.js';
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const sha = (v) => createHash('sha256').update(v).digest('hex');
const signal = () => new AbortController().signal;

async function prepared() {
  const f = semanticCatalogFixture();
  f.state.dataset.datasetProperties.value.description = '有來源依據的合成測試文字'.repeat(35);
  const original = f.state.dataset.schemaMetadata.value.fields[0];
  f.state.dataset.schemaMetadata.value.fields = Array.from({ length: 25 }, (_, i) => ({ ...original, fieldPath: `delivery_field_${i}`, description: '' }));
  const request = await f.request(Array.from({ length: 25 }, (_, i) => ({ kind: 'description', operation: 'set', fieldPath: `delivery_field_${i}`,
    value: `Synthetic description ${i}`, reason: 'Synthetic large-evidence delivery regression', evidenceIds: ['asset:source-description'] })));
  const receipt = await f.prepare({ ...request, responseMode: 'receipt' });
  return { f, receipt };
}

test('25-item native review >48KB loads in one <=512KiB detail response; writes return a bounded receipt and never replay', async () => {
  const { f, receipt } = await prepared();
  assert.equal(receipt.delivery, 'receipt'); assert.equal(receipt.candidateCount, 25); assert(bytes(receipt) < 8000);
  assert.equal(receipt.candidateIds, undefined); assert.equal(receipt.preview.changes, undefined);
  const actions = [];
  const detail = await loadSemanticReview(receipt.reviewRef, async (request) => {
    const result = await f.call(request); actions.push({ action: request.action, bytes: bytes(result) }); return result;
  }, signal());
  assert.equal(detail.preview.changes.length, 25); assert.equal(detail.candidateIds.length, 25);
  assert.equal(actions.filter((row) => row.action === 'read_review_detail').length, 1);
  assert(actions.find((row) => row.action === 'read_review_detail').bytes > 48000);
  assert(actions.every((row) => row.bytes <= 524288));
  const published = await f.command(detail, 'approve_review', { responseMode: 'receipt' });
  assert.equal(published.delivery, 'receipt'); assert(bytes(published) < 8000);
  assert.equal(published.publication.status, 'VERIFIED_CURRENT_VALUES');
  assert.equal(published.initialOutcome.status, 'VERIFIED_CURRENT_VALUES');
  const writes = f.writes.targetWrites;
  const audit = await loadSemanticReview(receipt.reviewRef, (request) => f.call(request), signal());
  assert.equal(audit.attempt.attemptId, published.attempt.attemptId);
  assert.equal(JSON.parse(audit.attempt.outcomeJson).status, 'VERIFIED_CURRENT_VALUES');
  assert.equal(f.writes.targetWrites, writes);
  await assert.rejects(f.command(detail, 'approve_review', { responseMode: 'receipt' }));
  assert.equal(f.writes.targetWrites, writes);
});

test('published detail identity survives a moving observation clock but still rejects changed native values', async () => {
  const { f, receipt } = await prepared();
  const published = await f.command(receipt, 'approve_review', { responseMode: 'receipt' });
  const writes = { targets: f.writes.targetWrites, records: f.writes.recordWrites };
  const pages = [];
  const audit = await loadSemanticReview(receipt.reviewRef, async (request) => {
    f.writes.now += 1000;
    const result = await f.call(request);
    if (request.action === 'read_review_detail') pages.push(result);
    return result;
  }, signal());
  assert.equal(audit.currentContext.status, 'SOURCE_SCHEMA_REFERENCES_RECHECKED');
  assert.equal(audit.currentContext.observedAt, f.writes.now);
  assert.equal(audit.receipt.currentContext.observedAt, f.writes.now);
  assert.equal(JSON.parse(pages.map(p => p.chunk).join('')).currentContext.observedAt, undefined);
  assert.equal(audit.attempt.attemptId, published.attempt.attemptId);
  assert.equal(JSON.parse(audit.attempt.outcomeJson).status, 'VERIFIED_CURRENT_VALUES');
  const fresh = await f.call({ action: 'read_review', ...receipt.reviewRef, responseMode: 'receipt' });
  f.state.dataset.editableSchemaMetadata.value.editableSchemaFieldInfo.find(row => row.fieldPath === 'delivery_field_0').description = 'changed by another writer';
  await assert.rejects(f.call({ action: 'read_review_detail', ...receipt.reviewRef, version: fresh.runVersion,
    planDigest: fresh.planDigest, detailDigest: fresh.details.digest, offset: 0 }), /semantic_review_detail_changed/);
  assert.deepEqual({ targets: f.writes.targetWrites, records: f.writes.recordWrites }, writes);
});

test('lost target ACK receipt retains initial UNKNOWN even when current values match; detail read never replays', async () => {
  const { f, receipt } = await prepared();
  f.writes.lossAfter = 1;
  await assert.rejects(f.command(receipt, 'approve_review', { responseMode: 'receipt' }), /publication_write_unconfirmed/);
  const result = await f.call({ action: 'read_review', ...receipt.reviewRef, responseMode: 'receipt' });
  assert.equal(result.delivery, 'receipt');
  assert.notEqual(result.initialOutcome.status, 'VERIFIED_CURRENT_VALUES');
  assert.equal(result.reconciliation.status, 'MATCHED_CLAIMED_ATTEMPT');
  const initial = result.initialOutcome.status;
  const detail = await loadSemanticReview(receipt.reviewRef, (r) => f.call(r), signal());
  assert.equal(JSON.parse(detail.attempt.outcomeJson).status, initial);
  assert.equal(f.writes.targetWrites, 1);
  await assert.rejects(f.command(result, 'approve_review', { responseMode: 'receipt' }));
  assert.equal(f.writes.targetWrites, 1);
});

test('native detail pages reject wrong version, digest, offset, current drift, revoked ACL and expiry without writes', async () => {
  const { f, receipt } = await prepared();
  const request = { action: 'read_review_detail', ...receipt.reviewRef, version: receipt.runVersion,
    planDigest: receipt.planDigest, detailDigest: receipt.details.digest, offset: 0 };
  const writes = { targets: f.writes.targetWrites, records: f.writes.recordWrites };
  for (const extra of [{ version: '999' }, { planDigest: 'f'.repeat(64) }, { detailDigest: 'f'.repeat(64) }, { offset: -1 }, { offset: receipt.details.length }])
    await assert.rejects(f.call({ ...request, ...extra }), /semantic_review_detail_(changed|page_invalid)/);
  f.policy.semanticPublicationApproved = false;
  await assert.rejects(f.call(request), /semantic_review_detail_changed/);
  const readonly = await loadSemanticReview(receipt.reviewRef, (r) => f.call(r), signal());
  assert.equal(readonly.readOnly, true);
  f.state.denied.add(f.assets.dataset);
  await assert.rejects(f.call(request), /denied|forbidden/);
  f.state.denied.clear(); f.policy.semanticPublicationApproved = true;
  f.writes.now = receipt.expiresAt + 1;
  await assert.rejects(f.call(request), /semantic_review_detail_changed/);
  assert.deepEqual({ targets: f.writes.targetWrites, records: f.writes.recordWrites }, writes);
});

function largeDocumentTransport() {
  // Transport-only oversized document. Not a claim that native record admission
  // accepts arbitrary 512KB+ proposals; native budgets remain unchanged.
  const ref = { runUrn: 'urn:li:dataProcessInstance:synthetic-delivery', decisionId: 'synthetic-decision' };
  const document = { format: 'datahub-semantic.review/1', publicationAuthorized: false, reviewRef: ref,
    runVersion: '1', planDigest: 'a'.repeat(64), candidateIds: ['cand_' + '1'.repeat(24)], history: [],
    preview: { changes: [{ before: '繁體😀\\\"'.repeat(65000), after: 'preserved' }] } };
  const serialized = JSON.stringify(document), digest = sha(serialized);
  const receipt = { ...document, delivery: 'receipt', candidateCount: 1,
    preview: { source: { urn: 'urn:li:dataHubIngestionSource:fixture', name: 'Synthetic' } },
    details: { format: 'datahub-semantic.review-detail/1', digest, length: serialized.length, pageSize: 524288 } };
  delete receipt.candidateIds; delete receipt.history;
  const calls = [];
  async function send(request) {
    calls.push(request);
    if (request.action === 'read_review') return structuredClone(receipt);
    const page = semanticReviewDetailPage(serialized, request.offset, { format: 'datahub-semantic.review-detail/1',
      publicationAuthorized: false, reviewRef: ref, runVersion: '1', planDigest: document.planDigest, detailDigest: digest });
    assert(bytes(page) <= 524288); return page;
  }
  return { document, ref, receipt, send, calls };
}

test('oversized exact JSON documents paginate by escaped UTF-8 wire bytes and reassemble Unicode losslessly', async () => {
  const f = largeDocumentTransport();
  const result = await loadSemanticReview(f.ref, f.send, signal());
  const { receipt: _receipt, ...document } = result;
  assert.deepEqual(document, f.document);
  assert(f.calls.filter((call) => call.action === 'read_review_detail').length > 1);
  assert(f.calls.every((call) => ['read_review', 'read_review_detail'].includes(call.action)));
});

for (const scenario of ['missing', 'reordered', 'tampered', 'different-version', 'different-digest', 'final-change', 'cancelled']) {
  test(`partial or changed details never become approvable: ${scenario}`, async () => {
    const f = largeDocumentTransport(), abort = new AbortController(); let reads = 0;
    await assert.rejects(loadSemanticReview(f.ref, async (request) => {
      const result = await f.send(request);
      if (request.action === 'read_review' && ++reads === 2 && scenario === 'final-change') result.details.digest = 'f'.repeat(64);
      if (request.action === 'read_review_detail') {
        if (scenario === 'missing') return { error: 'synthetic_missing' };
        if (scenario === 'reordered') result.offset++;
        if (scenario === 'tampered') result.chunk = 'x' + result.chunk.slice(1);
        if (scenario === 'different-version') result.runVersion = '2';
        if (scenario === 'different-digest') result.detailDigest = 'b'.repeat(64);
        if (scenario === 'cancelled') abort.abort();
      }
      return result;
    }, abort.signal), /semantic_review_detail_unconfirmed/);
    assert(f.calls.every((call) => !call.action.includes('approve')));
  });
}
