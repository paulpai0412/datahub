import { createHash } from "node:crypto";

export class IdentityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function sessionCookie(header, name) {
  if (
    typeof header !== "string" ||
    header.length > 16384 ||
    /[\r\n]/.test(header)
  ) {
    throw new IdentityError("authentication_required");
  }
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.slice(0, part.indexOf("=")) === name);
  if (matches.length !== 1 || matches[0].length <= name.length + 1) {
    throw new IdentityError("authentication_required");
  }
  return matches[0];
}

async function identityBody(response) {
  if (!response.body) throw new IdentityError("identity_unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new IdentityError("identity_unavailable");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

export function datahubSessionCookie(header, cookieName = "PLAY_SESSION") {
  return `${sessionCookie(header, cookieName)}; ${sessionCookie(header, "actor")}`;
}

/** Deployment configuration only. Never accept endpoint/tenant/actor from a request. */
export function createIdentityVerifier({
  frontendOrigin,
  tenant,
  cookieName = "PLAY_SESSION",
}) {
  let origin;
  try {
    origin = new URL(frontendOrigin);
  } catch {
    throw new Error("invalid_identity_configuration");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    typeof tenant !== "string" ||
    !tenant ||
    tenant.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(cookieName) ||
    cookieName === "actor"
  ) {
    throw new Error("invalid_identity_configuration");
  }
  const endpoint = new URL("/api/v2/graphql", origin);
  return async function verifyIdentity(cookieHeader) {
    // DataHub checks the actor companion against its signed session. Forward the
    // required pair ONLY to that frontend; identity still comes exclusively from me.
    const cookie = datahubSessionCookie(cookieHeader, cookieName);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          query: "query AgentIdentity { me { corpUser { urn } } }",
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new IdentityError(
          [401, 403].includes(response.status)
            ? "authentication_required"
            : "identity_unavailable",
        );
      }
      const body = await identityBody(response);
      const urn = body?.data?.me?.corpUser?.urn;
      if (
        (body?.errors !== undefined &&
          (!Array.isArray(body.errors) || body.errors.length)) ||
        typeof urn !== "string" ||
        !urn.startsWith("urn:li:corpuser:") ||
        urn.length <= "urn:li:corpuser:".length ||
        urn.length > 1024 ||
        /[\x00-\x1f\x7f]/.test(urn)
      ) {
        throw new IdentityError("authentication_required");
      }
      // Stable opaque key for per-user volumes, runtime routing and browser origin.
      const key = createHash("sha256")
        .update(JSON.stringify([tenant, urn]))
        .digest("hex")
        .slice(0, 48);
      return Object.freeze({ tenant, urn, key });
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      // Never echo cookies, server error bodies, URLs or fetch exceptions.
      throw new IdentityError("identity_unavailable");
    }
  };
}
