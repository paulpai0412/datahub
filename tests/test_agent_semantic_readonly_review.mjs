import test from "node:test";
import assert from "node:assert/strict";
import { semanticPublicationFixture } from "./fixtures/semantic-publication-fixture.mjs";
import { semanticCatalogFixture, catalogEvidence } from "./fixtures/semantic-catalog-fixture.mjs";
import { actor, datasetUrn } from "./fixtures/semantic-fixture.mjs";
import { approveSemanticReviewBatch } from "../extensions/datahub-agent/mfe/semantic-batch-review.js";

async function preparedFixture(catalog) {
  const f = catalog ? semanticCatalogFixture() : semanticPublicationFixture();
  const review = catalog
    ? await f.prepare(await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence }]))
    : await f.prepare();
  return { f, review };
}
function snapshot(f) {
  return JSON.stringify({ records: [...f.journal], dataset: f.state.dataset, definitions: f.state.definitions,
    fields: f.state.fields, submissions: f.writes.submissions, recordWrites: f.writes.recordWrites, targetWrites: f.writes.targetWrites });
}

for (const catalog of [false, true]) {
  const kind = catalog ? "Catalog" : "legacy Steward";
  for (const outcome of ["PENDING", "REJECT", "VERIFIED", "UNKNOWN"]) {
    test(`${kind}: publication disabled preserves ${outcome} history without mutation or retroactive success`, async () => {
      const { f, review } = await preparedFixture(catalog);
      if (outcome === "REJECT") await f.command(review, "reject_review");
      if (outcome === "VERIFIED") await f.command(review, "approve_review");
      if (outcome === "UNKNOWN") {
        f.writes.lossAfter = 1;
        await assert.rejects(f.command(review, "approve_review"), /publication_write_unconfirmed/);
      }
      const before = await f.command(review, "read_review");
      f.policy.semanticPublicationApproved = false;
      const bytes = snapshot(f);
      const after = await f.command(review, "read_review");
      assert.equal(after.readOnly, true);
      assert.equal(after.publicationAuthorized, false);
      for (const field of ["reviewRef", "taskUrn", "runVersion", "planDigest", "candidateIds", "preview", "state", "history", "attempt", "reconciliation"])
        assert.deepEqual(after[field], before[field], field);
      if (outcome === "UNKNOWN" || outcome === "VERIFIED") {
        assert.equal(after.reconciliation.status, "MATCHED_CLAIMED_ATTEMPT");
        assert.equal(JSON.parse(after.attempt.outcomeJson).status, outcome === "UNKNOWN" ? "UNKNOWN_OR_CONTEXT_CHANGED" : "VERIFIED_CURRENT_VALUES");
        assert.equal(after.currentContext.status, "CONTEXT_CHANGED_OR_UNVERIFIED");
      }
      for (const action of ["select_review", "approve_review", "reject_review", "publish_review"])
        await assert.rejects(f.command(after, action, action === "select_review" ? { candidateIds: after.candidateIds } : {}), /semantic_publication_not_authorized/);
      await assert.rejects(f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" }), /semantic_publication_not_authorized/);
      assert.equal(snapshot(f), bytes);
    });
  }
  for (const revoke of ["actor", "identity", "source ACL", "asset ACL", "Run API ACL", "model context", "audit audience", "source scope"]) {
    test(`${kind}: publication disabled does not bypass revoked ${revoke}`, async () => {
      const { f, review } = await preparedFixture(catalog);
      f.policy.semanticPublicationApproved = false;
      // Establish an authorized successful read before changing only read authority.
      await f.command(review, "read_review");
      const bytes = snapshot(f);
      if (revoke === "actor") f.context.actor = { ...actor, key: "b".repeat(48) };
      if (revoke === "identity") f.state.meUrn = "urn:li:corpuser:someone-else";
      if (revoke === "source ACL") f.state.manageIngestion = false;
      if (revoke === "asset ACL") f.state.denied.add(datasetUrn);
      if (revoke === "Run API ACL") {
        const fetchImpl = f.context.fetchImpl;
        f.context.fetchImpl = (url, options) => url.pathname === "/openapi/v3/entity/dataprocessinstance/batchGet"
          ? Promise.resolve(Response.json({}, { status: 403 })) : fetchImpl(url, options);
      }
      if (revoke === "model context") f.policy.semanticModelContextApproved = false;
      if (revoke === "audit audience") delete f.policy.semanticAuditAudience;
      if (revoke === "source scope") f.context.sources = [];
      await assert.rejects(f.command(review, "read_review"), /actor_scope_mismatch|identity_denied|denied|forbidden|not_authorized|not_approved|scope|unavailable/);
      assert.equal(snapshot(f), bytes);
    });
  }
}

test("batch review refuses both an already-readonly selection and a newly revoked publication without dispatch", async () => {
  const { f, review } = await preparedFixture(true);
  const selected = [JSON.stringify([review.reviewRef.runUrn, review.reviewRef.decisionId])];
  const cycle = { closed: false, sourceUrn: f.policy.urn };
  f.policy.semanticPublicationApproved = false;
  const readonly = await f.command(review, "read_review"), bytes = snapshot(f), actions = [];
  const send = (input) => { actions.push(input.action); return f.call(input); };
  await assert.rejects(approveSemanticReviewBatch({ cycle, reviews: [readonly] }, selected, send, new AbortController().signal), /semantic_batch_selection_invalid/);
  assert.deepEqual(actions, []);
  const stopped = await approveSemanticReviewBatch({ cycle, reviews: [review] }, selected, send, new AbortController().signal);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.results[0].status, "NOT_ATTEMPTED");
  assert.equal(stopped.results[0].error, "semantic_batch_review_changed");
  assert.deepEqual(actions, ["read_review", "read_review_detail", "read_review"]);
  assert.equal(snapshot(f), bytes);
});

for (const operation of ["create", "update"]) test(`Catalog: history read does not restore revoked definition ${operation} authority`, async () => {
  const f = semanticCatalogFixture();
  const definition = operation === "create"
    ? { kind: "tag", operation, name: "Revoked create fixture", description: "Synthetic only" }
    : { kind: "tag", operation, urn: "urn:li:tag:Reviewed", version: "1", description: "Synthetic update" };
  const review = await f.prepare(await f.definitionRequest(definition));
  f.policy[operation === "create" ? "semanticDefinitionCreationApproved" : "semanticDefinitionUpdatesApproved"] = false;
  const bytes = snapshot(f);
  await f.command(review, "read_review");
  for (const action of ["reject_review", "approve_review", "publish_review"])
    await assert.rejects(f.command(review, action), /semantic_definition_(creation|updates)_not_authorized/);
  assert.equal(snapshot(f), bytes);
});

test("Catalog: created definition history survives revocation of publication and definition mutation grants", async () => {
  const f = semanticCatalogFixture();
  const review = await f.prepare(await f.definitionRequest({ kind: "tag", operation: "create", name: "Readonly history fixture", description: "Synthetic only" }));
  const published = await f.command(review, "approve_review");
  f.policy.semanticPublicationApproved = false;
  f.policy.semanticDefinitionCreationApproved = false;
  f.policy.semanticDefinitionUpdatesApproved = false;
  const bytes = snapshot(f), history = await f.command(review, "read_review");
  assert.equal(history.readOnly, true);
  assert.deepEqual(history.preview, published.preview);
  assert.deepEqual(history.attempt, published.attempt);
  assert.equal(history.reconciliation.status, "MATCHED_CLAIMED_ATTEMPT");
  assert.equal(snapshot(f), bytes);
});
