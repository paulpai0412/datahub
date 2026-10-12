import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installSemanticBridge } from './semantic.js';

function fixture() {
  const previous = globalThis.window, origin = 'http://actor.localhost:30150', frame = { contentWindow: {} };
  globalThis.window = Object.assign(new EventTarget(), { location: { href: 'http://localhost:9002/mfe/agent' }, history: { state: null, replaceState() {} } });
  const calls = [], key = 'a'.repeat(48), id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const cleanup = installSemanticBridge({ container: {}, frame, origin, actorKey: key, send(request, signal) {
    return new Promise((resolve, reject) => {
      calls.push({ request, signal, resolve });
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  } });
  function request(action, type = 'datahub-semantic', overrides = {}) {
    const replies = [], port = { postMessage(text) { replies.push(JSON.parse(text)); }, close() {} };
    const body = { action, requestId: id, cycleRunUrn: `urn:li:dataProcessInstance:semantic-${key}-${id}` };
    window.dispatchEvent(Object.assign(new Event('message'), { source: frame.contentWindow, origin,
      data: { type, body: JSON.stringify(body), uiRequestId: 'native-request' }, ports: [port], ...overrides }));
    return { replies, cancel() { port.onmessage?.({ data: { type: 'cancel' } }); } };
  }
  return { calls, request, cleanup, restore() { cleanup(); globalThis.window = previous; } };
}

test('independent requests dispatch once within Host capacity without owning or releasing the mutation/consent lock', async () => {
  const f = fixture();
  try {
    const card = f.request('read_review');
    const writer = f.request('start_managed_cycle');
    const reader = f.request('read_managed_cycle');
    await setImmediate();
    assert.equal(f.calls.length, 1, 'Host capacity remains one; other requests wait without a busy rejection');
    assert.deepEqual(writer.replies, []); assert.deepEqual(reader.replies, []);
    assert.deepEqual(f.request('prepare_managed').replies, [{ error: 'semantic_request_busy' }]);
    assert.deepEqual(f.request('read_review', 'datahub-semantic-review').replies, [{ error: 'semantic_request_busy' }]);
    assert.deepEqual(f.request('read_review', 'datahub-semantic-batch-review').replies, [{ error: 'semantic_request_busy' }]);
    f.calls[0].resolve({ card: true }); await setImmediate();
    assert.deepEqual(card.replies, [{ card: true }]);
    assert.equal(f.calls.length, 2, 'the write is first dispatched only after the read settles');
    assert.deepEqual(f.request('prepare_managed').replies, [{ error: 'semantic_request_busy' }], 'read completion cannot release someone else\'s write lock');
    f.calls[1].resolve({ written: true }); await setImmediate();
    assert.deepEqual(writer.replies, [{ written: true }]);
    assert.equal(f.calls.length, 3);
    const next = f.request('finish_managed_cycle'); await setImmediate(); assert.equal(f.calls.length, 3);
    f.calls[2].resolve({ read: true }); await setImmediate(); assert.equal(f.calls.length, 4);
    f.calls[3].resolve({ closed: true }); await setImmediate();
    assert.deepEqual(reader.replies, [{ read: true }]); assert.deepEqual(next.replies, [{ closed: true }]);
  } finally { f.restore(); }
});

test('queued cancellation never dispatches; unmount cancels active and waiting requests without retry', async () => {
  const f = fixture();
  try {
    f.request('read_review'); const waiting = f.request('read_review_detail'); f.request('start_managed_cycle');
    await setImmediate(); assert.equal(f.calls.length, 1);
    waiting.cancel(); await setImmediate(); assert.equal(f.calls[0].signal.aborted, false);
    assert.deepEqual(f.request('finish_managed_cycle').replies, [{ error: 'semantic_request_busy' }]);
    f.calls[0].resolve({ read: true }); await setImmediate(); assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].request.action, 'start_managed_cycle', 'cancelled detail was never dispatched');
    f.request('read_review'); f.cleanup(); await setImmediate(); assert.equal(f.calls[1].signal.aborted, true);
    f.request('read_review'); assert.equal(f.calls.length, 2, 'unmounted and queued reads cannot dispatch');
  } finally { f.restore(); }
});

test('first-dispatch queue is bounded and never resubmits a failed request', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 32; i++) f.request('read_review');
    const overflow = f.request('read_review'); await setImmediate();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(overflow.replies, [{ error: 'semantic_request_busy' }]);
    f.cleanup(); await setImmediate(); assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test('foreground admission attaches the pending UI proof, serializes with consent and never grants publication', async () => {
  const f = fixture();
  try {
    const request = f.request('continue_maintenance');
    await setImmediate();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].request.uiRequestId, 'native-request');
    assert.equal(f.calls[0].request.publicationAuthorized, undefined);
    assert.deepEqual(f.request('prepare_maintenance').replies, [{ error: 'semantic_request_busy' }]);
    f.calls[0].resolve({ state: 'DRAFT', foregroundPreparation: true, publicationAuthorized: false });
    await setImmediate();
    assert.equal(request.replies[0].publicationAuthorized, false);
    const forged = f.request('continue_maintenance', 'datahub-semantic', {
      data: { type: 'datahub-semantic', body: JSON.stringify({ action: 'continue_maintenance', uiRequestId: 'forged' }) },
    });
    await setImmediate();
    assert.deepEqual(forged.replies, [{ error: 'semantic_request_failed' }]);
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test('concurrent read admission does not accept forged origin, caller approval or unknown actions', async () => {
  const f = fixture();
  try {
    f.request('read_review', 'datahub-semantic', { origin: 'http://untrusted.example' }); assert.equal(f.calls.length, 0);
    f.request('read_review', 'datahub-semantic', { source: {} }); assert.equal(f.calls.length, 0);
    const forged = f.request('approve_review'), unknown = f.request('invented_read'); await setImmediate();
    assert.deepEqual(forged.replies, [{ error: 'semantic_request_failed' }]);
    assert.deepEqual(unknown.replies, [{ error: 'semantic_request_failed' }]); assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});
