import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { open, rename, unlink } from "node:fs/promises";
import { SemanticError } from "./semantic-native-client.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const requireValue = (value, code) => { if (!value) throw new SemanticError(code, 409); };

/** Single owner for both settings writers in the existing operator JSON.
 * Shares revision, lock and synchronous apply; never silently imports external edits. */
export async function createOperatorConfigStore(path, validate, apply) {
  requireValue(typeof path === "string" && path.startsWith("/"), "source_settings_configuration_path_required");
  async function bytes() {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      requireValue(stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size <= 1048576,
        "source_settings_configuration_not_protected");
      return await file.readFile();
    } finally { await file.close(); }
  }
  let raw = await bytes(), config;
  try { config = JSON.parse(raw); } catch { throw new SemanticError("source_settings_configuration_invalid", 409); }
  validate(config);
  let revision = hash(raw);
  const current = async () => {
    requireValue(hash(await bytes()) === revision, "source_settings_configuration_changed");
    return { revision, config: structuredClone(config) };
  };
  return { path, current, async save(expected, transform, authorize) {
    let lock;
    // Retain the existing lock path so old and new settings writers cannot race.
    const lockPath = `${path}.source-settings.lock`, temporary = `${path}.${randomUUID()}.tmp`;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") throw new SemanticError("source_settings_busy", 409); throw error; }
    let replaced = false;
    try {
      await current();
      requireValue(expected === revision, "source_settings_version_conflict");
      await authorize();
      const next = await transform(structuredClone(config));
      validate(next);
      const nextRaw = Buffer.from(JSON.stringify(next, null, 2) + "\n");
      requireValue(nextRaw.length <= 1048576, "source_settings_configuration_invalid");
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(nextRaw); await file.sync(); } finally { await file.close(); }
      await authorize(); await current();
      await rename(temporary, path); replaced = true;
      raw = nextRaw; config = next; revision = hash(raw);
      apply(structuredClone(next));
      const directory = await open(dirname(path), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      requireValue(hash(await bytes()) === revision, "source_settings_save_unconfirmed");
      return { revision };
    } catch (error) {
      if (replaced) throw new SemanticError("source_settings_save_unconfirmed", 409);
      throw error;
    } finally {
      if (!replaced) await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await lock.close(); await unlink(lockPath);
    }
  } };
}
