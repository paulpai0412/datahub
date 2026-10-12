import { datahubSessionCookie } from "./datahub-identity.mjs";

export class SemanticError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.status = status;
  }
}

/** Operator eligibility is not per-proposal consent or proof of a successful
 * native write. Keep publicationAuthorized:false on all read/preview replies. */
export function semanticReviewPolicy(policy, { catalog = false } = {}) {
  const canPrepareReview = policy?.semanticModelContextApproved === true &&
    (!catalog || policy.semanticCatalogUpdatesApproved === true) &&
    policy.semanticPublicationApproved === true && Boolean(policy.semanticAgentUrn) &&
    policy.semanticAuditAudience === "EXISTING_TASK_RUN_ACL";
  return {
    basis: "current_host_source_policy_not_human_consent",
    canPrepareReview,
    canPrepareDefinitionCreation: canPrepareReview && policy.semanticDefinitionCreationApproved === true,
    canPrepareDefinitionUpdate: canPrepareReview && policy.semanticDefinitionUpdatesApproved === true,
    humanApprovalRequired: true,
    directPublicationAuthorized: false,
  };
}

// Shared public read boundary for legacy Source and Catalog semantic contracts.
// Callers supply fixed API paths; model requests never contain an endpoint.
export function semanticNativeClient(context) {
  const { actor, assertActive, frontendOrigin, cookieHeader, fetchImpl = fetch } = context;
  const cookie = datahubSessionCookie(cookieHeader);
  const signal = AbortSignal.timeout(20000);
  const fail = (code, status = 409) => { throw new SemanticError(code, status); };
  async function call(path, body) {
    assertActive();
    try {
      const response = await fetchImpl(new URL(path, frontendOrigin), {
        method: body === undefined ? "GET" : "POST", redirect: "manual", signal,
        headers: { "content-type": "application/json", cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error();
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1048576) throw new Error();
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value?.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length)) throw new Error();
      assertActive();
      return value;
    } catch {
      fail("semantic_catalog_unavailable");
    }
  }
  async function canRead(urn, type) {
    const data = await call("/api/v2/graphql", {
      query: "query($input:GetGrantedPrivilegesInput!){getGrantedPrivileges(input:$input){privileges}}",
      variables: { input: { actorUrn: actor.urn, resourceSpec: { resourceType: type, resourceUrn: urn } } },
    });
    const privileges = data.data?.getGrantedPrivileges?.privileges;
    return Array.isArray(privileges) && privileges.some((p) => ["GET_ENTITY", "VIEW_ENTITY_PAGE", "EDIT_ENTITY"].includes(p));
  }
  async function authorize(urn, type) {
    if (!(await canRead(urn, type))) fail("semantic_read_forbidden", 403);
  }
  async function identity() {
    const value = await call("/api/v2/graphql", {
      query: "query { me { corpUser { urn } platformPrivileges { manageIngestion } } }",
    });
    if (value.data?.me?.corpUser?.urn !== actor.urn) fail("semantic_identity_required", 403);
    // Source-bound semantic policies still follow the public Source privilege.
    if (value.data.me.platformPrivileges?.manageIngestion !== true) fail("semantic_source_forbidden", 403);
  }
  async function entity(urn, type, names, allowAbsent = false, onMissing) {
    const rows = await call(`/openapi/v3/entity/${type.toLowerCase()}/batchGet?systemMetadata=true`, [
      { urn, ...Object.fromEntries(names.map((name) => [name, {}])) },
    ]);
    if (Array.isArray(rows) && rows.length === 0) {
      if (allowAbsent) return { urn };
      // Only a successful, exact empty public-API result reaches this hook.
      // Transport/auth/malformed responses never do. A returning hook cannot
      // turn a missing entity into a usable native row.
      onMissing?.();
    }
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.urn !== urn) fail("semantic_catalog_invalid");
    return rows[0];
  }
  return { call, canRead, authorize, identity, entity };
}
