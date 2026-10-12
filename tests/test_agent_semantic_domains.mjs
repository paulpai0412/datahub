import test from "node:test";
import assert from "node:assert/strict";
import { applyCatalogCandidates } from "../extensions/datahub-agent/integration/semantic-catalog-contract.mjs";
import {
  compileSemanticPublication,
  recompileSemanticPublication,
} from "../extensions/datahub-agent/integration/semantic-publication.mjs";
import { readCatalogReviewContext } from "../extensions/datahub-agent/integration/semantic-catalog-publication.mjs";
import {
  makePublicationReview,
  canonicalPublicationJson as canonical,
} from "../extensions/datahub-agent/integration/publication-review.mjs";
import {
  semanticCatalogFixture,
  catalogEvidence,
} from "./fixtures/semantic-catalog-fixture.mjs";
import { semanticPublicationFixture } from "./fixtures/semantic-publication-fixture.mjs";
import { actor } from "./fixtures/semantic-fixture.mjs";

// Public Domains schemaVersion=2 and the real 2026-09-28 V3 readback add
// domainAssociations even when the submitted v1-shaped payload omitted it.
function nativeDomainReadback(aspect, value) {
  if (aspect === "domains" && !value.domainAssociations)
    value.domainAssociations = value.domains.map((domain) => ({ domain }));
}
const domainCandidate = (operation, values) => ({
  kind: "domain",
  operation,
  ...(operation === "set" ? { values } : { value: values }),
  ...catalogEvidence,
});
const A = "urn:li:domain:Manual",
  B = "urn:li:domain:New",
  P = "urn:li:domain:Propagated";
const apply = (before, candidate) =>
  applyCatalogCandidates(before, "domains", [candidate], {
    actor: actor.urn,
    time: 1,
  });

test("Catalog Domain publication matches the native V3 shape without weakening exact readback", async () => {
  const f = semanticCatalogFixture();
  delete f.state.dataset.domains;
  f.writes.afterTarget = nativeDomainReadback;
  const request = await f.request([
    domainCandidate("add", "urn:li:domain:Sales"),
  ]);
  const compiled = await compileSemanticPublication(request, f.context);
  assert.deepEqual(JSON.parse(compiled.changes[0].valueJson), {
    domains: ["urn:li:domain:Sales"],
    domainAssociations: [{ domain: "urn:li:domain:Sales" }],
  });
  const result = await f.command(await f.prepare(request), "approve_review");
  assert.equal(
    JSON.parse(result.attempt.outcomeJson).status,
    "VERIFIED_CURRENT_VALUES",
  );
  assert.equal(result.reconciliation.status, "MATCHED_CLAIMED_ATTEMPT");
  assert.equal(f.writes.targetWrites, 1);
  await f.command(result, "read_review");
  await assert.rejects(f.command(result, "approve_review"));
  assert.equal(f.writes.targetWrites, 1);
});

test("Domain add/set/remove preserve retained association notes, duplicates and native ordering", () => {
  const before = {
    domains: [A, P],
    domainAssociations: [
      { domain: A, context: "first human note", extension: { keep: true } },
      { domain: A, context: "second attribution" },
      {
        domain: P,
        attribution: {
          actor: actor.urn,
          time: 1,
          sourceDetail: { propagated: "TRUE", other: "keep" },
        },
      },
    ],
    unknown: { keep: [1, 2] },
  };
  const saved = structuredClone(before),
    added = apply(before, domainCandidate("add", B));
  assert.deepEqual(added.domains, [A, B, P]);
  assert.deepEqual(added.domainAssociations, [
    ...before.domainAssociations.slice(0, 2),
    { domain: B },
    before.domainAssociations[2],
  ]);
  assert.deepEqual(before, saved);
  assert.deepEqual(apply(added, domainCandidate("remove", B)), before);
  const selected = apply(added, domainCandidate("set", [P, B]));
  assert.deepEqual(selected.domains, [B, P]);
  assert.deepEqual(selected.domainAssociations, [
    { domain: B },
    before.domainAssociations[2],
  ]);
  assert.deepEqual(apply(selected, domainCandidate("set", [])), {
    domains: [],
    domainAssociations: [],
    unknown: before.unknown,
  });
});

test("pre-repair sealed Domain reviews remain readable but cannot acquire a new encoding without consent", async () => {
  const f = semanticCatalogFixture();
  delete f.state.dataset.domains;
  const request = await f.request([
    domainCandidate("add", "urn:li:domain:Sales"),
  ]);
  const current = await compileSemanticPublication(request, f.context);
  const saved = JSON.parse(current.semanticContextJson);
  delete saved.domainsAspectVersion;
  const { planDigest: ignored, ...input } = current;
  const historical = makePublicationReview({
    ...input,
    semanticContextJson: canonical(saved),
    changes: current.changes.map((c) => {
      const value = JSON.parse(c.valueJson);
      delete value.domainAssociations;
      return { ...c, valueJson: canonical(value) };
    }),
  });
  assert.equal(
    (await readCatalogReviewContext(historical, f.context)).stale,
    true,
  );
  await assert.rejects(
    recompileSemanticPublication(historical, f.context),
    /semantic_review_stale/,
  );
  assert.equal(f.writes.targetWrites, 0);
  assert.throws(
    () => makePublicationReview({ ...input, changes: historical.changes }),
    /outside_intent/,
  );
  const invalid = {
    ...JSON.parse(current.semanticContextJson),
    domainsAspectVersion: 3,
  };
  assert.throws(
    () =>
      makePublicationReview({
        ...input,
        semanticContextJson: canonical(invalid),
      }),
    /outside_intent/,
  );
});

test("legacy fill-only Domain compiler uses the same public shape without expanding consent", async () => {
  const f = semanticPublicationFixture();
  delete f.state.dataset.domains;
  f.writes.afterTarget = nativeDomainReadback;
  const prepared = await f.prepare([
    {
      kind: "domain",
      value: "urn:li:domain:Sales",
      reason: "Legacy Domain fill only",
      evidenceIds: ["dataset:source-description"],
    },
  ]);
  const result = await f.command(prepared, "approve_review");
  assert.equal(
    JSON.parse(result.attempt.outcomeJson).status,
    "VERIFIED_CURRENT_VALUES",
  );
  assert.equal(f.writes.targetWrites, 1);
  assert.deepEqual(f.state.dataset.domains.value.domainAssociations, [
    { domain: "urn:li:domain:Sales" },
  ]);
});
