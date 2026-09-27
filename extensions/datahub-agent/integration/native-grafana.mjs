import { randomUUID } from "node:crypto";
import { SqlError } from "./native-sql.mjs";

/** A display lease cannot authorize SQL. Data is served only from a prior,
 * actor-checked, transient SQL result, never by executing on a Grafana GET. */
export class GrafanaError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.status = status;
  }
}
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const keys = (x, expected) =>
  object(x) && Object.keys(x).sort().join() === [...expected].sort().join();
const uuid = (x) =>
  typeof x === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
// Infinity 3.11.2 expands ${__org.id} from PluginContext.Namespace, not the
// numeric OrgID. Grafana OSS 13.1.2 names org 1 "default" and org N "org-N".
const grafanaNamespace = (orgId) => (orgId === 1 ? "default" : `org-${orgId}`);
const deny = (code = "grafana_scope_denied", status = 403) => {
  throw new GrafanaError(code, status);
};

export function grafanaPolicies(value = {}, { datahubOrigin } = {}) {
  if (!object(value)) throw new Error("invalid_grafana_policy");
  let frontend;
  try {
    frontend = new URL(datahubOrigin);
  } catch {
    throw new Error("invalid_grafana_policy");
  }
  const policies = new Map();
  for (const [actor, entry] of Object.entries(value)) {
    if (
      !/^[a-f0-9]{48}$/.test(actor) ||
      !keys(entry, [
        "dashboardUid",
        "datasetUrn",
        "title",
        "viewerLogin",
        "orgId",
        "grafanaOrigin",
        "expiresAt",
      ]) ||
      typeof entry.dashboardUid !== "string" ||
      !/^[a-z0-9_-]{1,40}$/.test(entry.dashboardUid) ||
      typeof entry.datasetUrn !== "string" ||
      !/^urn:li:dataset:[^\x00-\x1f]{1,1000}$/.test(entry.datasetUrn) ||
      typeof entry.title !== "string" ||
      !entry.title.trim() ||
      entry.title.length > 200 ||
      /[\x00-\x1f]/.test(entry.title) ||
      typeof entry.viewerLogin !== "string" ||
      !/^[A-Za-z0-9_.@-]{1,100}$/.test(entry.viewerLogin) ||
      !Number.isSafeInteger(entry.orgId) ||
      entry.orgId <= 0 ||
      !Number.isSafeInteger(entry.expiresAt) ||
      entry.expiresAt <= 0
    )
      throw new Error("invalid_grafana_policy");
    let origin;
    try {
      origin = new URL(entry.grafanaOrigin);
    } catch {
      throw new Error("invalid_grafana_policy");
    }
    if (
      origin.hostname !== frontend.hostname ||
      origin.protocol !== frontend.protocol ||
      !origin.port ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password ||
      origin.origin === frontend.origin ||
      !["http:", "https:"].includes(origin.protocol)
    )
      throw new Error("invalid_grafana_policy");
    policies.set(
      actor,
      Object.freeze({ ...entry, grafanaOrigin: origin.origin }),
    );
  }
  return policies;
}

/** A displayRef is an opaque reference, not a query bearer token. The
 * Grafana backend authenticates separately using its server-only secret and
 * signed-in viewer metadata; neither credential is present in the URL. */
export function createGrafanaHost({
  policies,
  readSqlResult,
  verifyIdentity,
  now = Date.now,
} = {}) {
  if (
    !(policies instanceof Map) ||
    typeof readSqlResult !== "function" ||
    typeof verifyIdentity !== "function"
  )
    throw new Error("invalid_grafana_host");
  const displays = new Map();
  const prune = () => {
    for (const [ref, value] of displays)
      if (now() >= value.expiresAt) displays.delete(ref);
  };
  const readChecked = async (resultRef, context, policy) => {
    context.assertActive();
    if (now() >= policy.expiresAt || policies.get(context.actor.key) !== policy)
      deny();
    let card;
    try {
      card = await readSqlResult(
        JSON.stringify({ action: "read_result", resultRef }),
        context,
      );
    } catch (error) {
      if (error instanceof SqlError)
        deny("grafana_result_unavailable", error.status);
      throw error;
    }
    context.assertActive();
    if (
      policies.get(context.actor.key) !== policy ||
      now() >= policy.expiresAt ||
      card?.datasetUrn !== policy.datasetUrn ||
      card?.format !== "datahub-sql.source-card/1" ||
      card?.metric !== "sales_by_category" ||
      !Array.isArray(card.points)
    )
      deny();
    return card;
  };
  return {
    async request(text, context) {
      let input;
      try {
        if (typeof text !== "string" || text.length > 2048) throw new Error();
        input = JSON.parse(text);
      } catch {
        deny("grafana_invalid_request", 400);
      }
      if (!uuid(input?.requestId)) deny("grafana_invalid_request", 400);
      const authorize = input.action === "grafana_authorize";
      if (
        !keys(
          input,
          authorize
            ? ["action", "resultRef", "requestId"]
            : ["action", "displayRef", "requestId"],
        ) ||
        !(authorize || input.action === "grafana_open") ||
        !uuid(authorize ? input.resultRef : input.displayRef)
      )
        deny("grafana_invalid_request", 400);
      const policy = policies.get(context.actor.key);
      if (!policy || !context.cookieHeader || !uuid(context.grantId)) deny();
      prune();
      if (authorize) {
        const card = await readChecked(input.resultRef, context, policy);
        if (displays.size >= 64) deny("grafana_capacity_exhausted", 429);
        const displayRef = randomUUID();
        displays.set(
          displayRef,
          Object.freeze({
            actorKey: context.actor.key,
            grantId: context.grantId,
            resultRef: input.resultRef,
            policy,
            expiresAt: Math.min(card.resultExpiresAt ?? 0, policy.expiresAt),
          }),
        );
        const display = displays.get(displayRef);
        if (display.expiresAt <= now()) {
          displays.delete(displayRef);
          deny("grafana_result_unavailable", 410);
        }
        return {
          format: "datahub-grafana.embed/1",
          requestId: input.requestId,
          displayRef,
          dashboardUid: policy.dashboardUid,
          orgId: policy.orgId,
          title: policy.title,
          datasetUrn: policy.datasetUrn,
          from: card.from,
          to: card.through,
          resultExpiresAt: display.expiresAt,
          status: "SOURCE_ONLY_NOT_RECONCILED",
        };
      }
      const display = displays.get(input.displayRef);
      if (
        !display ||
        display.actorKey !== context.actor.key ||
        display.grantId !== context.grantId ||
        display.policy !== policy ||
        now() >= display.expiresAt
      )
        deny("grafana_result_unavailable", 410);
      const card = await readChecked(display.resultRef, context, policy);
      // A portal opening binds the previously authorized result to the fresh
      // DataHub session. A Grafana GET can never create this binding itself.
      displays.set(
        input.displayRef,
        Object.freeze({
          ...display,
          cookieHeader: context.cookieHeader,
        }),
      );
      const url = new URL(`/d/${policy.dashboardUid}`, policy.grafanaOrigin);
      url.search = new URLSearchParams({
        orgId: String(policy.orgId),
        from: card.from,
        to: card.through,
        "var-display": input.displayRef,
        kiosk: "",
      }).toString();
      return {
        format: "datahub-grafana.portal/1",
        requestId: input.requestId,
        displayRef: input.displayRef,
        dashboardUid: policy.dashboardUid,
        orgId: policy.orgId,
        url: url.href,
        expiresAt: Math.min(display.expiresAt, now() + 20_000),
      };
    },
    async read(displayRef, { assertGrant, viewerLogin, orgId } = {}) {
      if (!uuid(displayRef) || typeof assertGrant !== "function") deny();
      prune();
      const entry = displays.get(displayRef);
      if (
        !entry?.cookieHeader ||
        now() >= entry.expiresAt ||
        policies.get(entry.actorKey) !== entry.policy ||
        viewerLogin !== entry.policy.viewerLogin ||
        orgId !== grafanaNamespace(entry.policy.orgId)
      )
        deny();
      const assertActive = () => {
        assertGrant(entry.grantId, entry.actorKey);
        if (
          now() >= entry.expiresAt ||
          policies.get(entry.actorKey) !== entry.policy
        )
          deny();
      };
      assertActive();
      let actor;
      try {
        actor = await verifyIdentity(entry.cookieHeader);
      } catch {
        deny();
      }
      if (actor.key !== entry.actorKey) deny();
      const card = await readChecked(
        entry.resultRef,
        {
          actor,
          cookieHeader: entry.cookieHeader,
          assertActive,
          signal: AbortSignal.timeout(10000),
        },
        entry.policy,
      );
      assertActive();
      if (card.resultExpiresAt <= now() || card.points.length > 201) deny();
      // Data is limited to the already executed aggregate, not arbitrary source rows.
      return card.points.map((p) => ({
        month: p.month,
        category: p.category,
        salesAmount: p.salesAmount,
        from: card.from,
        through: card.through,
        observedAt: card.observedAt,
        status: "SOURCE_ONLY_NOT_RECONCILED",
      }));
    },
  };
}
