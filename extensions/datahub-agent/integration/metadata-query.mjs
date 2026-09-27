import { createHash, randomUUID } from "node:crypto";
import {
  rejectQuery,
  exactKeys,
  queryUuid,
  isRecord,
  authorizeQueryMetadata,
} from "./query-metadata.mjs";
import { resolveQueryBinding } from "./query-source.mjs";
import { validateQueryChart } from "./query-grafana.mjs";
const hash = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const namespace = (id) => (id === 1 ? "default" : `org-${id}`);
const parse = (text) => {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text) > 32768)
      throw new Error();
    return JSON.parse(text);
  } catch {
    rejectQuery("query_invalid_request");
  }
};
const shape = (data) =>
  data.map(
    ({
      urn,
      qualifiedName,
      platform,
      platformInstanceUrn,
      environment,
      schemaVersion,
      fields,
    }) => ({
      urn,
      qualifiedName,
      platform,
      platformInstanceUrn,
      environment,
      schemaVersion,
      fields,
    }),
  );

function resultChecked(result, compiled) {
  if (
    !isRecord(result) ||
    JSON.stringify(result.columns) !== JSON.stringify(compiled.columns) ||
    !Array.isArray(result.rows) ||
    result.rows.length > compiled.limit ||
    typeof result.truncated !== "boolean" ||
    typeof result.observedAt !== "string" ||
    !Number.isFinite(Date.parse(result.observedAt)) ||
    result.sql !== compiled.sql
  )
    rejectQuery("query_result_invalid", 502);
  const names = compiled.columns.map((c) => c.name);
  for (const row of result.rows) {
    if (!exactKeys(row, names)) rejectQuery("query_result_invalid", 502);
    for (const c of compiled.columns) {
      const v = row[c.name];
      if (v === null) continue;
      if (
        !["string", "number", "boolean"].includes(typeof v) ||
        String(v).length > 8192 ||
        (typeof v === "number" && !Number.isFinite(v))
      )
        rejectQuery("query_result_invalid", 502);
      if (
        c.type === "number" &&
        !(
          typeof v === "number" ||
          (typeof v === "string" &&
            /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v) &&
            Number.isFinite(Number(v)))
        )
      )
        rejectQuery("query_result_invalid", 502);
      if (
        c.type === "time" &&
        (typeof v !== "string" || !Number.isFinite(Date.parse(v)))
      )
        rejectQuery("query_result_invalid", 502);
    }
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 1048576)
    rejectQuery("query_result_too_large", 502);
}

/** Query visibility comes entirely from DataHub, not a per-actor SQL policy.
 * Transient results are display data, not a new business datastore. */
export function createMetadataQueryHost({
  bindings,
  readMetadata,
  source,
  grafana,
  publishDashboard,
  verifyIdentity,
  now = Date.now,
  resultTtlMs = 900000,
}) {
  if (
    !Array.isArray(bindings) ||
    typeof readMetadata !== "function" ||
    typeof source?.compile !== "function" ||
    typeof source?.execute !== "function" ||
    typeof verifyIdentity !== "function" ||
    typeof publishDashboard !== "function" ||
    !Number.isSafeInteger(resultTtlMs) ||
    resultTtlMs < 60000 ||
    resultTtlMs > 3600000
  )
    throw new Error("query_configuration_invalid");
  const results = new Map(),
    requests = new Map(),
    displays = new Map(),
    active = new Map();
  let retainedBytes = 0;
  function prune() {
    for (const [ref, e] of results)
      if (e.expiresAt <= now()) {
        retainedBytes -= e.bytes;
        results.delete(ref);
      }
    for (const [ref, e] of displays)
      if (e.expiresAt <= now()) displays.delete(ref);
    for (const [key, e] of requests)
      if (e.until <= now() && e.settled) requests.delete(key);
  }
  async function checked(ref, context) {
    prune();
    const e = results.get(ref);
    if (
      !e ||
      e.actorKey !== context.actor.key ||
      e.tenant !== context.actor.tenant
    )
      rejectQuery("query_result_expired", 410);
    const snapshots = await authorizeQueryMetadata(
      e.plan,
      readMetadata,
      context,
    );
    if (
      e.expiresAt <= now() ||
      hash(shape(snapshots)) !== e.schemaHash ||
      resolveQueryBinding(snapshots, bindings, context.actor) !== e.binding
    )
      rejectQuery("query_metadata_changed", 409);
    context.assertActive();
    return e;
  }
  async function executeQuery(input, context) {
    const snapshots = await authorizeQueryMetadata(
      input.plan,
      readMetadata,
      context,
    );
    const binding = resolveQueryBinding(snapshots, bindings, context.actor);
    const compiled = await source.compile(
      input.plan,
      snapshots,
      binding,
      context,
    );
    validateQueryChart(input.chart, compiled.columns);
    context.assertActive();
    const busy = active.get(binding.id) ?? 0;
    if (busy >= 2 || results.size >= 64 || retainedBytes >= 32 * 1048576)
      rejectQuery("query_capacity_exhausted", 429);
    active.set(binding.id, busy + 1);
    try {
      const result = await source.execute(
        input.plan,
        snapshots,
        binding,
        context,
      );
      resultChecked(result, compiled);
      context.assertActive();
      const latest = await authorizeQueryMetadata(
        input.plan,
        readMetadata,
        context,
      );
      if (hash(shape(latest)) !== hash(shape(snapshots)))
        rejectQuery("query_metadata_changed", 409);
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (retainedBytes + bytes > 32 * 1048576)
        rejectQuery("query_capacity_exhausted", 429);
      const resultRef = randomUUID(),
        expiresAt = now() + resultTtlMs;
      results.set(resultRef, {
        actorKey: context.actor.key,
        tenant: context.actor.tenant,
        schemaHash: hash(shape(snapshots)),
        binding,
        plan: structuredClone(input.plan),
        chart: structuredClone(input.chart),
        result: structuredClone(result),
        bytes,
        expiresAt,
      });
      retainedBytes += bytes;
      // No SQL text, literals, business values, connection info or counts here.
      return {
        format: "datahub-query.receipt/1",
        action: "execute_query",
        requestId: input.requestId,
        resultRef,
        datasetUrns: snapshots.map((s) => s.urn),
        resultExpiresAt: expiresAt,
        state: result.rows.length ? "AVAILABLE" : "EMPTY",
      };
    } finally {
      active.set(binding.id, (active.get(binding.id) ?? 1) - 1);
    }
  }
  return {
    async execute(text, context) {
      const input = parse(text);
      if (
        !exactKeys(input, ["action", "requestId", "plan", "chart"]) ||
        input.action !== "execute_query" ||
        !queryUuid(input.requestId)
      )
        rejectQuery("query_invalid_request");
      context.assertActive();
      prune();
      const key = `${context.actor.key}:${input.requestId}`,
        digest = hash(input),
        prior = requests.get(key);
      if (prior) {
        if (prior.digest !== digest) rejectQuery("query_request_conflict", 409);
        const receipt = await prior.promise;
        await checked(receipt.resultRef, context);
        return receipt;
      }
      if (requests.size >= 256) rejectQuery("query_capacity_exhausted", 429);
      const entry = { digest, until: now() + resultTtlMs, settled: false };
      requests.set(key, entry);
      entry.promise = executeQuery(input, context).finally(() => {
        entry.settled = true;
      });
      return entry.promise;
    },
    async readResult(text, context) {
      const input = parse(text);
      if (
        !exactKeys(input, ["action", "resultRef"]) ||
        input.action !== "read_result" ||
        !queryUuid(input.resultRef)
      )
        rejectQuery("query_invalid_request");
      const e = await checked(input.resultRef, context);
      return {
        format: "datahub-query.result/1",
        resultRef: input.resultRef,
        ...structuredClone(e.result),
        resultExpiresAt: e.expiresAt,
      };
    },
    async request(text, context) {
      const input = parse(text),
        authorize = input?.action === "grafana_authorize";
      if (
        !exactKeys(
          input,
          authorize
            ? ["action", "resultRef", "requestId"]
            : ["action", "displayRef", "requestId"],
        ) ||
        !queryUuid(input.requestId) ||
        !queryUuid(authorize ? input.resultRef : input.displayRef) ||
        (!authorize && input.action !== "grafana_open") ||
        !queryUuid(context.grantId)
      )
        rejectQuery("query_invalid_request");
      if (authorize) {
        const e = await checked(input.resultRef, context);
        // Same SSO subject by default; operator identity aliases are NOT SQL
        // permissions. Neither the model nor metadata can choose a Viewer.
        const mapped = grafana.subjectLogins?.[context.actor.urn];
        const viewerLogin =
          mapped ?? context.actor.urn.slice("urn:li:corpuser:".length);
        if (
          !/^[A-Za-z0-9_.@-]{1,100}$/.test(viewerLogin) ||
          (!mapped &&
            Object.values(grafana.subjectLogins ?? {}).includes(viewerLogin))
        )
          rejectQuery("query_grafana_identity_unavailable", 403);
        if (!e.publication) {
          const displayRef = randomUUID(),
            uid = `dq-${displayRef.replaceAll("-", "")}`;
          e.publication = (async () => {
            await publishDashboard(
              {
                uid,
                displayRef,
                viewerLogin,
                chart: e.chart,
                columns: e.result.columns,
                rows: e.result.rows,
                observedAt: e.result.observedAt,
                truncated: e.result.truncated,
              },
              context,
            );
            context.assertActive();
            displays.set(displayRef, {
              entry: e,
              resultRef: input.resultRef,
              uid,
              viewerLogin,
              grantId: context.grantId,
              expiresAt: e.expiresAt,
            });
            return { displayRef, uid };
          })(); // Unknown write outcome is retained, never automatically replayed.
        }
        const { displayRef, uid } = await e.publication;
        const d = displays.get(displayRef);
        if (!d || d.grantId !== context.grantId || d.expiresAt <= now())
          rejectQuery("query_result_expired", 410);
        return {
          format: "datahub-grafana.embed/2",
          requestId: input.requestId,
          displayRef,
          dashboardUid: uid,
          orgId: grafana.orgId,
          title: e.chart.title,
          datasetUrns: e.plan.datasets.map((d) => d.urn),
          resultExpiresAt: e.expiresAt,
          status: e.result.rows.length ? "QUERY_RESULT" : "EMPTY",
        };
      }
      const d = displays.get(input.displayRef);
      if (!d || d.grantId !== context.grantId)
        rejectQuery("query_result_expired", 410);
      const e = await checked(d.resultRef, context);
      d.cookieHeader = context.cookieHeader;
      const url = new URL(`/d/${d.uid}`, grafana.origin);
      url.search = new URLSearchParams({
        orgId: String(grafana.orgId),
        "var-display": input.displayRef,
        theme: "light",
        kiosk: "",
      }).toString();
      return {
        format: "datahub-grafana.portal/2",
        requestId: input.requestId,
        displayRef: input.displayRef,
        dashboardUid: d.uid,
        orgId: grafana.orgId,
        url: url.href,
        expiresAt: Math.min(e.expiresAt, now() + 20000),
      };
    },
    async read(displayRef, { assertGrant, viewerLogin, orgId }) {
      prune();
      const d = displays.get(displayRef);
      if (
        !d?.cookieHeader ||
        viewerLogin !== d.viewerLogin ||
        orgId !== namespace(grafana.orgId)
      )
        rejectQuery("query_display_denied", 403);
      const assertActive = () => {
        assertGrant(d.grantId, d.entry.actorKey);
        if (d.expiresAt <= now()) rejectQuery("query_result_expired", 410);
      };
      assertActive();
      const actor = await verifyIdentity(d.cookieHeader);
      if (actor.key !== d.entry.actorKey || actor.tenant !== d.entry.tenant)
        rejectQuery("query_display_denied", 403);
      const e = await checked(d.resultRef, {
        actor,
        cookieHeader: d.cookieHeader,
        assertActive,
        signal: AbortSignal.timeout(20000),
      });
      assertActive();
      return structuredClone(e.result.rows);
    },
  };
}
