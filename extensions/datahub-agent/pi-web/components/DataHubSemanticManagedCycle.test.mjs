import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const output = await build({
  entryPoints: [
    new URL("./DataHubSemanticManagedCycle.tsx", import.meta.url).pathname,
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  write: false,
  jsx: "automatic",
});
const compiled = { exports: {} };
runInNewContext(output.outputFiles[0].text, { module: compiled, exports: compiled.exports, require: createRequire(import.meta.url), TextEncoder });
const { DataHubSemanticManagedCycle, isManagedScope, isManagedCycle } = compiled.exports;

const scope = {
  format: "datahub-semantic.preview/1",
  action: "inspect_managed_scope",
  publicationAuthorized: false,
  scope: {
    sourceUrn: "urn:li:dataHubIngestionSource:test",
    sourceName: "<unsafe & name>",
    executionUrn: "urn:li:dataHubExecutionRequest:test",
    datasetCount: 1,
    fieldCount: 2,
    fingerprint: "a".repeat(64),
    checkpointVerified: false,
    completeEnumeratedRecipeScope: true,
    datasets: [
      { urn: "urn:li:dataset:test", fields: ["LineNetAmount", "OrderQty"] },
    ],
  },
  managedCycle: null,
};

test("managed scope is a bounded, non-publishing, escaped user-visible card", () => {
  assert.equal(isManagedScope(scope), true);
  const html = renderToStaticMarkup(
    createElement(DataHubSemanticManagedCycle, { result: scope }),
  );
  assert.match(html, /唯讀快照/);
  assert.match(html, /未配置輪次寫政策/);
  assert.match(html, /&lt;unsafe &amp; name&gt;/);
  assert.doesNotMatch(html, /<unsafe/);
  assert.equal(
    isManagedScope({ ...scope, publicationAuthorized: true }),
    false,
  );
  assert.equal(
    isManagedScope({
      ...scope,
      scope: { ...scope.scope, checkpointVerified: true },
    }),
    false,
  );
});

test("cycle card reports UNKNOWN and exceptions without exposing approval controls", () => {
  const cycle = {
    format: "datahub-semantic.managed-cycle/1",
    action: "read_managed_cycle",
    publicationAuthorized: false,
    runUrn: "urn:li:dataProcessInstance:test",
    sourceUrn: scope.scope.sourceUrn,
    executionUrn: scope.scope.executionUrn,
    status: "INCOMPLETE_OR_UNVERIFIED",
    datasetCount: 1,
    fieldCount: 2,
    targetCount: 3,
    accountedCount: 1,
    missingCount: 2,
    exceptionCount: 1,
    publicationCount: 1,
    pendingCount: 1,
    closed: false,
    offset: 0,
    nextMissingOffset: null,
    nextReceiptOffset: null,
    missing: [["urn:li:dataset:test", "OrderQty"]],
    exceptions: [
      {
        decisionId: "1",
        assetUrn: "urn:li:dataset:test",
        fieldPath: "LineNetAmount",
        code: "NO_EVIDENCE",
      },
    ],
    publications: [
      {
        decisionId: "2",
        status: "UNKNOWN_OR_CHANGED",
        targets: [["urn:li:dataset:test", null]],
      },
    ],
    pending: [{ decisionId: "2", status: "UNKNOWN_OR_CHANGED" }],
    definitionCount: 1,
    definitions: [{ decisionId: "child-decision", runUrn: "urn:li:dataProcessInstance:child", definitionUrn: "urn:li:tag:<unsafe>", kind: "tag", status: "PENDING" }],
    retentionCount: 1,
    retentions: [{ decisionId: "keep", assetUrn: "urn:li:dataset:test", fieldPaths: [null], observedAt: 123, status: "OBSERVED_NO_CHANGE" }],
  };
  assert.equal(isManagedCycle(cycle), true);
  const html = renderToStaticMarkup(
    createElement(DataHubSemanticManagedCycle, { result: cycle }),
  );
  for (const text of [
    "尚未確認",
    "不得重送",
    "NO_EVIDENCE",
    "UNKNOWN_OR_CHANGED",
    "OrderQty",
    "共用定義獨立審核",
    "不計入 Dataset",
    "urn:li:tag:&lt;unsafe&gt;",
    "OBSERVED_NO_CHANGE",
  ])
    assert(html.includes(text), text);
  assert.match(html, /在 Host 開啟批次審核/);
  assert.equal((html.match(/<button/g) ?? []).length, 1, "only a locator opener, never approval controls");
  assert.doesNotMatch(html, /Approve|確認選取提案並循序發布|<unsafe>/);
  assert.equal(isManagedCycle({ ...cycle, definitions: [{ ...cycle.definitions[0], status: "AUTO_APPROVED" }] }), false);
  assert.equal(
    isManagedCycle({ ...cycle, missing: Array(21).fill(cycle.missing[0]) }),
    false,
  );
});
