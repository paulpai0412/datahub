import { createHash, randomBytes, randomUUID } from "node:crypto";

export class GrantError extends Error {
  constructor(code = "authentication_required") {
    super(code);
    this.code = code;
  }
}

function digest(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new GrantError();
  return createHash("sha256").update(token).digest("hex");
}

function sameActor(a, b) {
  return (
    b != null && a.tenant === b.tenant && a.urn === b.urn && a.key === b.key
  );
}

/** Ephemeral browser authentication, not workflow storage. Restart revokes all grants. */
export class BrowserGrants {
  #grants = new Map();
  #tickets = new Map();
  #sessions = new Map();
  #clock;
  #limit;
  #ticketMs;
  #leaseMs;

  constructor({
    clock = Date.now,
    limit = 1024,
    ticketMs = 30000,
    leaseMs = 90000,
  } = {}) {
    if (
      ![limit, ticketMs, leaseMs].every((n) => Number.isSafeInteger(n) && n > 0)
    ) {
      throw new Error("invalid_grant_configuration");
    }
    this.#clock = clock;
    this.#limit = limit;
    this.#ticketMs = ticketMs;
    this.#leaseMs = leaseMs;
  }

  issue(actor) {
    this.sweep();
    if (this.#grants.size >= this.#limit)
      throw new GrantError("grant_capacity_exhausted");
    if (
      !actor ||
      typeof actor.tenant !== "string" ||
      !actor.tenant ||
      typeof actor.urn !== "string" ||
      !actor.urn.startsWith("urn:li:corpuser:") ||
      !/^[a-f0-9]{48}$/.test(actor.key)
    )
      throw new GrantError();
    const ticket = randomBytes(32).toString("base64url");
    const revokeToken = randomBytes(32).toString("base64url");
    const grant = {
      id: randomUUID(),
      actor: Object.freeze({
        tenant: actor.tenant,
        urn: actor.urn,
        key: actor.key,
      }),
      ticketHash: digest(ticket),
      revokeHash: digest(revokeToken),
      ticketExpires: this.#clock() + this.#ticketMs,
      sessionHash: null,
      expires: this.#clock() + this.#leaseMs,
    };
    this.#grants.set(grant.id, grant);
    this.#tickets.set(grant.ticketHash, grant);
    return { grantId: grant.id, ticket, key: actor.key, revokeToken };
  }

  exchange(ticket, key, existingSession) {
    this.sweep();
    const hash = digest(ticket);
    const grant = this.#tickets.get(hash);
    if (!grant || grant.actor.key !== key) throw new GrantError();
    let session = existingSession;
    let group =
      session === undefined ? undefined : this.#sessions.get(digest(session));
    if (group && !sameActor(group.actor, grant.actor)) throw new GrantError();
    if (!group) {
      session = randomBytes(32).toString("base64url");
      group = { actor: grant.actor, members: new Set(), listeners: new Set() };
    }
    // Browser cookies are shared by tabs, but not by separate browser profiles.
    // Joining requires BOTH the existing cookie and a fresh same-actor ticket.
    // No awaits between consume and issue: exactly one exchange wins.
    this.#tickets.delete(hash);
    grant.sessionHash = digest(session);
    group.members.add(grant);
    this.#sessions.set(grant.sessionHash, group);
    return { session, grantId: grant.id, actor: grant.actor };
  }

  authorize(session, key, grantId) {
    const group = this.#sessions.get(digest(session));
    if (!group || group.actor.key !== key) throw new GrantError();
    // ponytail: bounded by the grant limit; cache expiry only if measured traffic needs it.
    let expires = 0;
    for (const member of group.members) {
      if (grantId === undefined || member.id === grantId)
        expires = Math.max(expires, member.expires);
    }
    if (expires <= this.#clock()) throw new GrantError();
    return Object.freeze({ actor: group.actor, expires });
  }

  renew(grantId, actor, revokeToken) {
    this.sweep();
    const grant = this.#grants.get(grantId);
    if (!grant || !sameActor(grant.actor, actor)) throw new GrantError();
    if (revokeToken !== undefined && digest(revokeToken) !== grant.revokeHash)
      throw new GrantError();
    grant.expires = this.#clock() + this.#leaseMs;
  }

  // Stop-only proof, held by the trusted parent, never the runtime iframe.
  // Logout cleanup must still work after the DataHub session cookie is gone.
  release(grantId, revokeToken, wholeSession = false) {
    const grant = this.#grants.get(grantId);
    if (!grant) return;
    if (digest(revokeToken) !== grant.revokeHash) throw new GrantError();
    const group = this.#sessions.get(grant.sessionHash);
    if (wholeSession && group) {
      for (const member of [...group.members]) this.#remove(member);
    } else this.#remove(grant);
  }

  revoke(grantId, actor) {
    const grant = this.#grants.get(grantId);
    if (!grant) return;
    if (!sameActor(grant.actor, actor)) throw new GrantError();
    this.#remove(grant);
  }

  onRevoke(session, key, close) {
    if (typeof close !== "function") throw new GrantError();
    this.authorize(session, key);
    const group = this.#sessions.get(digest(session));
    if (group.listeners.size >= 32)
      throw new GrantError("connection_capacity_exhausted");
    group.listeners.add(close);
    return () => group.listeners.delete(close);
  }

  sweep() {
    // ponytail: bounded O(limit) sweep; use an expiry queue if grant volume grows.
    for (const grant of this.#grants.values()) {
      if (
        grant.expires <= this.#clock() ||
        (!grant.sessionHash && grant.ticketExpires <= this.#clock())
      ) {
        this.#remove(grant);
      }
    }
  }

  #remove(grant) {
    this.#grants.delete(grant.id);
    this.#tickets.delete(grant.ticketHash);
    const group = this.#sessions.get(grant.sessionHash);
    if (!group) return;
    group.members.delete(grant);
    if (group.members.size) return;
    this.#sessions.delete(grant.sessionHash);
    for (const close of group.listeners) {
      try {
        close();
      } catch {
        /* A broken socket must not prevent other revocations. */
      }
    }
    group.listeners.clear();
  }
}
