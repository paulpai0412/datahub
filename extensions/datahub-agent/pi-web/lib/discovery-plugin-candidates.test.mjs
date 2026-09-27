/** Actual local filesystem unit tests. Never execute candidate text. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, symlink, unlink, link, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { candidateFiles, candidateDigest, saveCandidate, readCandidate } from "./discovery-plugin-candidates.ts";

const source = { "plugin.py": "raise RuntimeError('THIS TEXT MUST NEVER EXECUTE IN THE MODEL RUNTIME')\n", "manifest.json": "{}" };

async function workspace(t) {
  const base = await mkdtemp(join(tmpdir(), "discovery-code-artifacts-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root: join(base, "candidates"), sessionId: randomUUID() };
}

test("save/read are source-only, new immutable revisions and session-scoped", async t => {
  const { root, sessionId } = await workspace(t);
  const first = await saveCandidate(root, sessionId, source);
  assert.equal(first.verified, false);
  assert.equal(first.activationAuthorized, false);
  assert.equal(first.candidateDigest, candidateDigest(source));
  assert.deepEqual((await readCandidate(root, sessionId, first.candidateId)).files, source);
  const updated = { ...source, "README.md": "changed source revision" };
  const second = await saveCandidate(root, sessionId, updated);
  assert.notEqual(second.candidateId, first.candidateId);
  assert.notEqual(second.candidateDigest, first.candidateDigest);
  assert.deepEqual((await readCandidate(root, sessionId, first.candidateId)).files, source);
  await assert.rejects(readCandidate(root, randomUUID(), first.candidateId), /candidate_workspace_unavailable/);
});

test("writer inventory is closed and size/encoding bounds apply before saving", () => {
  for (const files of [
    {}, [], null, { ...source, "../plugin.py": "escape" },
    { ...source, "contract.json": "replace host policy" },
    { ...source, "receipt.json": '{"status":"PASS"}' },
    { ...source, "plugin.py": "x".repeat(48_001) },
    { ...source, "plugin.py": '"'.repeat(24_000) },
    { ...source, "plugin.py": "\u0000" },
    { ...source, "plugin.py": "\ud800" },
  ]) assert.throws(() => candidateFiles(files), /candidate_files_/);
  assert.equal(candidateDigest({ "manifest.json": "{}", "plugin.py": source["plugin.py"] }), candidateDigest(source));
});

test("parent and leaf symlinks cannot redirect the scoped workspace", async t => {
  const { base, root, sessionId } = await workspace(t);
  const outside = join(base, "outside");
  await mkdir(outside); await mkdir(root);
  const sentinel = join(outside, "sentinel.txt");
  await writeFile(sentinel, "CANARY ONLY");
  await symlink(outside, join(root, sessionId));
  await assert.rejects(saveCandidate(root, sessionId, source), /candidate_workspace_unavailable/);
  await unlink(join(root, sessionId));
  const candidate = await saveCandidate(root, sessionId, source);
  const file = join(root, sessionId, candidate.candidateId, "plugin.py");
  await unlink(file); await symlink(sentinel, file);
  await assert.rejects(readCandidate(root, sessionId, candidate.candidateId), /candidate_read_failed/);
  assert.equal(await readFile(sentinel, "utf8"), "CANARY ONLY");
  await unlink(file);
  execFileSync("mkfifo", [file], { timeout: 1000 });
  await assert.rejects(readCandidate(root, sessionId, candidate.candidateId), /candidate_read_failed/);
});

test("hardlinks, unexpected files and invalid IDs are not candidate access", async t => {
  const { base, root, sessionId } = await workspace(t);
  const candidate = await saveCandidate(root, sessionId, source);
  const folder = join(root, sessionId, candidate.candidateId);
  const canary = join(base, "not-a-candidate.txt");
  await writeFile(canary, "CANARY ONLY");
  await unlink(join(folder, "plugin.py")); await link(canary, join(folder, "plugin.py"));
  await assert.rejects(readCandidate(root, sessionId, candidate.candidateId), /candidate_read_failed/);
  await writeFile(join(folder, "host-policy.json"), "{}");
  await assert.rejects(readCandidate(root, sessionId, candidate.candidateId), /candidate_read_failed/);
  await assert.rejects(readCandidate(root, sessionId, "../../outside"), /candidate_id_invalid/);
});
