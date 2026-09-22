import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserGrants,
  GrantError,
} from "../extensions/datahub-agent/integration/browser-grants.mjs";

const alice = {
  tenant: "fixture",
  urn: "urn:li:corpuser:alice",
  key: "a".repeat(48),
};
const bob = {
  tenant: "fixture",
  urn: "urn:li:corpuser:bob",
  key: "b".repeat(48),
};

test("one-use ticket is bound to actor origin; cannot be used as a session", () => {
  const grants = new BrowserGrants();
  const issued = grants.issue(alice);
  assert.throws(() => grants.authorize(issued.ticket, alice.key), GrantError);
  assert.throws(() => grants.exchange(issued.ticket, bob.key), GrantError);
  const { session } = grants.exchange(issued.ticket, alice.key);
  assert.notEqual(session, issued.ticket);
  assert.throws(() => grants.exchange(issued.ticket, alice.key), GrantError);
  assert.throws(() => grants.authorize(session, bob.key), GrantError);
  assert.deepEqual(grants.authorize(session, alice.key).actor, alice);
});

test("renewal and revocation require the verified actor including tenant", () => {
  let now = 0;
  const grants = new BrowserGrants({
    clock: () => now,
    ticketMs: 10,
    leaseMs: 20,
  });
  const issued = grants.issue(alice);
  const { session } = grants.exchange(issued.ticket, alice.key);
  for (const actor of [bob, { ...alice, tenant: "other" }, undefined]) {
    assert.throws(() => grants.renew(issued.grantId, actor), GrantError);
    assert.throws(() => grants.revoke(issued.grantId, actor), GrantError);
  }
  now = 19;
  grants.renew(issued.grantId, alice);
  now = 20;
  assert.equal(grants.authorize(session, alice.key).expires, 39);
  let closed = 0;
  grants.onRevoke(session, alice.key, () => {
    closed++;
  });
  now = 39;
  assert.throws(() => grants.authorize(session, alice.key), GrantError);
  grants.sweep();
  assert.equal(closed, 1);
  assert.throws(() => grants.renew(issued.grantId, alice), GrantError);
});

test("unused tickets expire and free capacity; renew cannot revive them", () => {
  let now = 0;
  const grants = new BrowserGrants({
    clock: () => now,
    limit: 1,
    ticketMs: 10,
    leaseMs: 100,
  });
  const first = grants.issue(alice);
  assert.throws(() => grants.issue(bob), {
    message: "grant_capacity_exhausted",
  });
  now = 10;
  assert.throws(() => grants.exchange(first.ticket, alice.key), GrantError);
  assert.throws(() => grants.renew(first.grantId, alice), GrantError);
  const second = grants.issue(bob);
  assert.equal(second.key, bob.key);
});

test("revocation closes every active connection and removes all authentication", () => {
  const grants = new BrowserGrants();
  const issued = grants.issue(alice);
  const { session } = grants.exchange(issued.ticket, alice.key);
  let closed = 0;
  grants.onRevoke(session, alice.key, () => {
    throw new Error("synthetic broken socket");
  });
  grants.onRevoke(session, alice.key, () => {
    closed++;
  });
  const remove = grants.onRevoke(session, alice.key, () => {
    closed += 100;
  });
  remove();
  grants.revoke(issued.grantId, alice);
  grants.revoke(issued.grantId, alice);
  assert.equal(closed, 1);
  assert.throws(() => grants.authorize(session, alice.key), GrantError);
  assert.throws(
    () => grants.onRevoke(session, alice.key, () => {}),
    GrantError,
  );
});

test("restart fails closed; caller mutation cannot replace actor; malformed tokens denied", () => {
  const actor = { ...alice };
  const grants = new BrowserGrants();
  const issued = grants.issue(actor);
  actor.urn = bob.urn;
  const { session } = grants.exchange(issued.ticket, alice.key);
  assert.equal(grants.authorize(session, alice.key).actor.urn, alice.urn);
  assert.throws(
    () => new BrowserGrants().authorize(session, alice.key),
    GrantError,
  );
  for (const token of [undefined, "", "x".repeat(44), "secret\n", 123, {}]) {
    assert.throws(() => grants.authorize(token, alice.key), GrantError);
    assert.throws(() => grants.exchange(token, alice.key), GrantError);
  }
});

test("one browser cookie survives sibling lease expiry/revoke but not the last lease", () => {
  let now = 0;
  const grants = new BrowserGrants({ clock: () => now, leaseMs: 20 });
  const first = grants.issue(alice);
  const { session } = grants.exchange(first.ticket, alice.key);
  const second = grants.issue(alice);
  assert.equal(
    grants.exchange(second.ticket, alice.key, session).session,
    session,
  );
  let closed = 0;
  grants.onRevoke(session, alice.key, () => closed++);
  now = 10;
  grants.renew(second.grantId, alice);
  now = 20;
  grants.sweep();
  assert.equal(grants.authorize(session, alice.key).expires, 30);
  assert.throws(
    () => grants.authorize(session, alice.key, first.grantId),
    GrantError,
    "a surviving sibling cannot resurrect a revoked/expired exchange during readiness",
  );
  assert.equal(closed, 0);
  assert.throws(() => grants.renew(first.grantId, alice), GrantError);
  grants.revoke(second.grantId, alice);
  assert.equal(closed, 1);
  assert.throws(() => grants.authorize(session, alice.key), GrantError);
});

test("cookie joining needs a fresh same-actor ticket; separate browsers stay separate", () => {
  const grants = new BrowserGrants();
  const first = grants.issue(alice);
  const { session } = grants.exchange(first.ticket, alice.key);
  const otherBrowser = grants.issue(alice);
  const separate = grants.exchange(otherBrowser.ticket, alice.key).session;
  assert.notEqual(separate, session);
  const foreign = grants.issue(bob);
  assert.throws(
    () => grants.exchange(foreign.ticket, bob.key, session),
    GrantError,
  );
  assert.throws(
    () => grants.exchange(first.ticket, alice.key, session),
    GrantError,
  );
  assert.throws(
    () => grants.exchange("invalid", alice.key, session),
    GrantError,
  );
  grants.revoke(otherBrowser.grantId, alice);
  assert.doesNotThrow(() => grants.authorize(session, alice.key));
  assert.throws(() => grants.authorize(separate, alice.key), GrantError);
  grants.revoke(first.grantId, alice);
  const fresh = grants.issue(alice);
  assert.notEqual(
    grants.exchange(fresh.ticket, alice.key, session).session,
    session,
  );
});

test("stop-only proof cannot access/renew alone; identity loss revokes only this browser session", () => {
  const grants = new BrowserGrants();
  const first = grants.issue(alice);
  const { session } = grants.exchange(first.ticket, alice.key);
  const sibling = grants.issue(alice);
  grants.exchange(sibling.ticket, alice.key, session);
  const isolated = grants.issue(alice);
  const otherSession = grants.exchange(isolated.ticket, alice.key).session;
  for (const token of [
    first.ticket,
    session,
    isolated.revokeToken,
    "x".repeat(43),
  ]) {
    assert.throws(() => grants.release(first.grantId, token, true), GrantError);
    assert.throws(() => grants.renew(first.grantId, alice, token), GrantError);
  }
  assert.throws(
    () => grants.renew(first.grantId, undefined, first.revokeToken),
    GrantError,
  );
  assert.throws(
    () => grants.authorize(first.revokeToken, alice.key),
    GrantError,
  );
  assert.throws(
    () => grants.exchange(first.revokeToken, alice.key),
    GrantError,
  );
  let closed = 0;
  grants.onRevoke(session, alice.key, () => closed++);
  grants.release(sibling.grantId, sibling.revokeToken);
  assert.equal(closed, 0);
  assert.doesNotThrow(() => grants.authorize(session, alice.key));
  const replacement = grants.issue(alice);
  grants.exchange(replacement.ticket, alice.key, session);
  grants.release(first.grantId, first.revokeToken, true);
  assert.equal(closed, 1);
  assert.throws(() => grants.authorize(session, alice.key), GrantError);
  assert.throws(
    () => grants.renew(replacement.grantId, alice, replacement.revokeToken),
    GrantError,
  );
  assert.doesNotThrow(() => grants.authorize(otherSession, alice.key));
  assert.doesNotThrow(() => grants.release(first.grantId, first.revokeToken));
});

test("connection count is bounded and released slots can be reused", () => {
  const grants = new BrowserGrants();
  const { ticket } = grants.issue(alice);
  const { session } = grants.exchange(ticket, alice.key);
  const removals = Array.from({ length: 32 }, () =>
    grants.onRevoke(session, alice.key, () => {}),
  );
  assert.throws(() => grants.onRevoke(session, alice.key, () => {}), {
    message: "connection_capacity_exhausted",
  });
  removals[0]();
  assert.doesNotThrow(() => grants.onRevoke(session, alice.key, () => {}));
});
