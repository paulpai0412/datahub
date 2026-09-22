import assert from "node:assert/strict";
import { semanticFixture, sourceUrn, datasetUrn, executionUrn, requestId, actor } from "./semantic-fixture.mjs";
import { semanticHost } from "../../extensions/datahub-agent/integration/native-semantic-tasks.mjs";

/** Extends the existing semantic fixture with public versioned-record/CAS
 * semantics. Synthetic only; never a live DataHub/Composer acceptance receipt. */
export function semanticPublicationFixture() {
  const f = semanticFixture();
  Object.assign(f.policy, { semanticPublicationApproved: true, semanticAgentUrn: "urn:li:aiAgent:fixture-semantic", semanticAuditAudience: "EXISTING_TASK_RUN_ACL" });
  Object.assign(f.state.dataset.schemaMetadata.systemMetadata, { runId: executionUrn, pipelineName: sourceUrn });
  const journal = new Map();
  const state = { now: 1790056000000, submissions: 0, targetWrites: 0, recordWrites: 0, pending: null, lossAfter: 0, beforeTarget: null, afterTarget: null, afterRecord: null };
  const sessionId = "00000000-0000-4000-8000-000000000088";
  const baseFetch = f.context.fetchImpl;
  f.context.now = () => state.now;
  f.context.runtime = { state: async (id) => ({ running: true, state: { sessionId: id,
    extensionUiRequests: state.pending ? [{ id: "fixture-ui", method: "input", title: "DataHub semantic request", placeholder: JSON.stringify(state.pending) }] : [] } }) };
  f.context.fetchImpl = async (url, options) => {
    const input = options.body ? JSON.parse(options.body) : undefined;
    if (url.pathname === "/openapi/v3/entity/generic") {
      assert.equal(url.origin, "http://datahub.invalid");
      assert.equal(url.search, "?async=false&systemMetadata=true");
      const target = Object.values(input).some((rows) => rows.some((row) => Object.keys(row).some((name) => !["urn", "ekopAgentTask", "ekopAgentRun"].includes(name))));
      if (target) { state.submissions++; state.beforeTarget?.(input); }
      const result = {};
      for (const [entity, rows] of Object.entries(input)) {
        result[entity] = [];
        for (const row of rows) {
          const ack = { urn: row.urn };
          for (const [aspect, change] of Object.entries(row)) {
            if (aspect === "urn") continue;
            const key = `${row.urn}/${aspect}`;
            const isRecord = ["ekopAgentTask", "ekopAgentRun"].includes(aspect);
            const native = isRecord ? {} : row.urn === datasetUrn ? f.state.dataset : row.urn.startsWith("urn:li:schemaField:")
              ? (f.state.fields[row.urn] ??= {}) : (f.state.definitions[row.urn] ??= {});
            const old = isRecord ? journal.get(key)?.at(-1) : native[aspect];
            if (change.headers["If-Version-Match"] !== (old?.systemMetadata.version ?? "-1")) return Response.json({}, { status: 412 });
            const value = { value: structuredClone(change.value), systemMetadata: {
              ...old?.systemMetadata, ...change.systemMetadata,
              properties: old ? old.systemMetadata.properties : change.systemMetadata?.properties,
              version: String(Number(old?.systemMetadata.version ?? 0) + 1),
              aspectCreated: old?.systemMetadata.aspectCreated ?? { actor: actor.urn, time: state.now },
              aspectModified: { actor: actor.urn, time: state.now },
            } };
            if (isRecord) { const versions = journal.get(key) ?? []; versions.push(value); journal.set(key, versions); state.recordWrites++; await state.afterRecord?.(aspect, value.value); }
            else { native[aspect] = value; state.targetWrites++; state.afterTarget?.(aspect, value.value); }
            ack[aspect] = value;
            if (isRecord && state.recordLossAt === state.recordWrites) throw new Error("fixture lost record ACK");
            if (target && state.lossAfter === state.targetWrites) throw new Error("fixture lost target ACK");
          }
          result[entity].push(ack);
        }
      }
      return Response.json(result);
    }
    if (url.pathname.endsWith("/batchGet") && input.some((row) => row.ekopAgentTask || row.ekopAgentRun)) {
      const result = input.map(({ urn, ...aspects }) => {
        const row = { urn };
        for (const [aspect, headers] of Object.entries(aspects)) {
          const versions = journal.get(`${urn}/${aspect}`);
          const index = headers.headers?.["If-Version-Match"];
          const value = index ? versions?.[Number(index) - 1] : versions?.at(-1);
          if (value) row[aspect] = value;
        }
        return row;
      }).filter((row) => Object.keys(row).length > 1);
      return Response.json(result);
    }
    if (url.pathname.endsWith("/batchGet") && input[0].urn.includes(":ekop-semantic-") && !f.state.definitions[input[0].urn]) return Response.json([]);
    const response = await baseFetch(url, options);
    const value = await response.json();
    if (url.pathname === "/api/v2/graphql" && input.query.includes("getGrantedPrivileges") && value.data.getGrantedPrivileges.privileges.length) value.data.getGrantedPrivileges.privileges.push("EDIT_ENTITY");
    if (url.pathname.endsWith("/batchGet") && Array.isArray(value)) {
      return Response.json(value.map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => name === "urn" || Object.hasOwn(input.find((item) => item.urn === row.urn), name)))));
    }
    return Response.json(value);
  };
  const call = (input) => semanticHost(JSON.stringify(input), f.context);
  async function prepare(candidates = [{ kind: "tag", value: "urn:li:tag:Reviewed", reason: "Fixture evidence", evidenceIds: ["dataset:source-description"] }]) {
    const inspected = await f.run();
    state.pending = { action: "prepare_review", requestId, sessionId, sourceUrn, datasetUrn, snapshotDigest: inspected.snapshotDigest, candidates };
    return call({ ...state.pending, uiRequestId: "fixture-ui" });
  }
  const command = (view, action, extra = {}) => call({ action, ...view.reviewRef, ...(action === "read_review" ? {} : { version: view.runVersion, planDigest: view.planDigest }), ...extra });
  return { ...f, writes: state, journal, call, command, prepare, sessionId };
}
