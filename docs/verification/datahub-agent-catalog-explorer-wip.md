# Catalog Explorer — public WIP branch handoff

This branch contains a **Catalog-scoped work-in-progress snapshot**, not a release or a deployed artifact. The Host's `datahub_catalog` operation uses the existing authenticated, read-only DataHub API boundary; no source SQL, ingestion or Catalog metadata mutation is part of this branch. Per-Actor Catalog access is operator-configured and off unless explicitly enabled.

## Scope and checks

- Taken from the current development checkout onto a fresh branch based on `master`; shared `useAgentSession.ts` and `server.mjs` contain only the Catalog submission-recovery and Host activation changes, not unrelated ongoing refactors. The independent process-details expansion change, Semantic Steward edits, private presentations, runtime credentials and `.local/` evidence are excluded.
- TypeScript `tsc --noEmit --incremental false`: PASS using the already-installed pinned local dependencies linked solely for this isolated check. MFE webpack build: PASS. Catalog / gateway / renderer / composer / MFE synthetic tests: **82 PASS, 0 FAIL**. The first run failed because this new worktree had no generated MFE `dist/`; after building the MFE, the source-bound suite passed. These are not real browser or DataHub acceptance checks.
- The existing formal downstream patch and lock remain unchanged. A clean standard-Dockerfile npm dependency installation, cross-work independent review and full B1+B2 acceptance have **not** passed. The local development deployment and its private live evidence were produced from a different, mixed-source checkout: they must not be attributed to this branch.

## Remaining before integration

Review the complete feature and cross-work interactions independently; obtain a reliable clean build and update the downstream lock only against the reviewed exact source; verify the real Agent entrypoint, authorized actor differences, nonempty governance/cycle examples and full native UI/panel behavior in an approved environment. Do not merge or deploy this WIP branch as if these gates had passed.
