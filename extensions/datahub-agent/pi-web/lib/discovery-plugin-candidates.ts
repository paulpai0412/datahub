import { constants } from "node:fs";
import { mkdir, open, readdir, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

// Code artifacts under existing per-actor Pi HOME, not a registry or approval DB.
// Every save creates a NEW immutable revision. No writer-controlled Host path,
// command, contract, acceptance suite, receipt or activation list is accepted.
const NAMES = ["README.md", "manifest.json", "plugin.py", "tests.py"] as const;
const REQUIRED = ["manifest.json", "plugin.py"];
const MAX_BYTES = 48_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const fdPath = (directory: FileHandle) => `/proc/self/fd/${directory.fd}`;

export type CandidateFiles = Record<string, string>;

export function candidateFiles(value: unknown): CandidateFiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("candidate_files_invalid");
  const names = Object.keys(value).sort();
  if (!REQUIRED.every(name => names.includes(name)) || names.some(name => !(NAMES as readonly string[]).includes(name))) {
    throw new Error("candidate_files_invalid");
  }
  const files: CandidateFiles = {};
  let bytes = 0;
  for (const name of names) {
    const content = (value as Record<string, unknown>)[name];
    if (typeof content !== "string" || content.includes("\0") || !content.isWellFormed()) throw new Error("candidate_files_invalid");
    bytes += Buffer.byteLength(content, "utf8");
    if (bytes > MAX_BYTES) throw new Error("candidate_files_too_large");
    files[name] = content;
  }
  // Reserve space for native request metadata; quoting must not make a saved
  // candidate impossible to read/submit through the unchanged 60KB channel.
  if (Buffer.byteLength(JSON.stringify(files), "utf8") > MAX_BYTES) throw new Error("candidate_files_too_large");
  return files;
}

export function candidateDigest(files: CandidateFiles): string {
  return hash(JSON.stringify(candidateFiles(files)));
}

/** Linux-only DataHub runtime. Pinned dirfds avoid symlink/rename traversal.
 * root is operator/server configuration, NEVER a tool argument. No generic FS API.
 */
async function directory(root: string, sessionId: string, create: boolean): Promise<FileHandle> {
  if (process.platform !== "linux" || !isAbsolute(root) || !UUID.test(sessionId)) throw new Error("candidate_workspace_invalid");
  const parts = root.slice(1).split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error("candidate_workspace_invalid");
  let handle = await open("/", DIRECTORY_FLAGS);
  try {
    for (const part of [...parts, sessionId]) {
      const name = `${fdPath(handle)}/${part}`;
      if (create) {
        try { await mkdir(name, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const next = await open(name, DIRECTORY_FLAGS);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch { await handle.close(); throw new Error("candidate_workspace_unavailable"); }
}

/** Store source text only. Does NOT parse/import/execute the plugin or its tests. */
export async function saveCandidate(root: string, sessionId: string, submitted: unknown) {
  const files = candidateFiles(submitted);
  const candidateId = randomUUID();
  const parent = await directory(root, sessionId, true);
  let target: FileHandle | undefined;
  try {
    const path = `${fdPath(parent)}/${candidateId}`;
    await mkdir(path, { mode: 0o700 }); // Never reuse an existing revision.
    target = await open(path, DIRECTORY_FLAGS);
    for (const [name, content] of Object.entries(files)) {
      const file = await open(`${fdPath(target)}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(content, "utf8"); } finally { await file.close(); }
    }
    return { candidateId, candidateDigest: candidateDigest(files),
      files: Object.entries(files).map(([name, content]) => ({ name, sha256: hash(content), bytes: Buffer.byteLength(content, "utf8") })),
      verified: false, activationAuthorized: false };
  } catch { throw new Error("candidate_save_failed"); }
  finally { await target?.close(); await parent.close(); }
}

export async function readCandidate(root: string, sessionId: string, candidateId: string) {
  if (!UUID.test(candidateId)) throw new Error("candidate_id_invalid");
  const parent = await directory(root, sessionId, false);
  let target: FileHandle | undefined;
  try {
    target = await open(`${fdPath(parent)}/${candidateId}`, DIRECTORY_FLAGS);
    const names = await readdir(fdPath(target));
    if (names.some(name => !(NAMES as readonly string[]).includes(name))) throw new Error("inventory");
    const files: CandidateFiles = {};
    for (const name of names.sort()) {
      const file = await open(`${fdPath(target)}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error("file");
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset > MAX_BYTES) throw new Error("size");
        files[name] = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
      } finally { await file.close(); }
    }
    const checked = candidateFiles(files);
    return { candidateId, candidateDigest: candidateDigest(checked), files: checked,
      verified: false, activationAuthorized: false };
  } catch { throw new Error("candidate_read_failed"); }
  finally { await target?.close(); await parent.close(); }
}
