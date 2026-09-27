import { datahubSessionCookie } from "./datahub-identity.mjs";
import { CATALOG_QUERIES } from "./native-catalog.mjs";
import { SqlError } from "./native-sql.mjs";

const denied = () => {
  throw new SqlError("sql_not_authorized", 403);
};
const unavailable = () => {
  throw new SqlError("sql_native_unavailable", 502);
};

/** Native DataHub read privileges are checked for this actor and the *exact*
 * source view, Chart and Dashboard, never inferred from a saved tool result.
 * Catalog visibility is necessary but does not grant SQL Server SELECT. */
export function sqlAssetAuthorizer({ frontendOrigin, fetchImpl = fetch }) {
  let endpoint;
  try {
    const origin = new URL(frontendOrigin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      unavailable();
    endpoint = new URL("/api/v2/graphql", origin);
  } catch {
    unavailable();
  }
  return async (context, policy) => {
    if (
      !context.actor?.urn ||
      !context.actor?.tenant ||
      !context.actor?.key ||
      !context.cookieHeader
    )
      denied();
    let cookie;
    try {
      cookie = datahubSessionCookie(context.cookieHeader);
    } catch {
      denied();
    }
    const call = async (query, variables) => {
      context.assertActive();
      const signals = [AbortSignal.timeout(5000)];
      if (context.signal) signals.push(context.signal);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.any(signals),
        });
        if (response.status === 401 || response.status === 403) denied();
        if (!response.ok || !response.body) unavailable();
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 16384) unavailable();
          chunks.push(chunk);
        }
        context.assertActive();
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          !value ||
          typeof value.data !== "object" ||
          !value.data ||
          Array.isArray(value.data) ||
          (value.errors !== undefined &&
            (!Array.isArray(value.errors) || value.errors.length > 0))
        )
          unavailable();
        return value.data;
      } catch (error) {
        if (error instanceof SqlError) throw error;
        unavailable(); // Never expose native response or cookies to the model.
      } finally {
        await response?.body?.cancel().catch(() => {});
      }
    };
    const me = await call(CATALOG_QUERIES.identity);
    if (me.me?.corpUser?.urn !== context.actor.urn) denied();
    const assets = [
      [policy.datasetUrn, "DATASET"],
      [policy.chartUrn, "CHART"],
      [policy.dashboardUrn, "DASHBOARD"],
    ];
    for (const [urn, type] of assets) {
      const grant = await call(CATALOG_QUERIES.privileges, {
        input: {
          actorUrn: context.actor.urn,
          resourceSpec: { resourceType: type, resourceUrn: urn },
        },
      });
      const privileges = grant.getGrantedPrivileges?.privileges;
      if (
        !Array.isArray(privileges) ||
        !privileges.some((p) => p === "GET_ENTITY" || p === "VIEW_ENTITY_PAGE")
      )
        denied();
      const entity = await call(
        "query SqlAsset($urn:String!){entity(urn:$urn){urn type}}",
        { urn },
      );
      if (entity.entity?.urn !== urn || entity.entity?.type !== type) denied();
    }
    context.assertActive();
    return true;
  };
}
