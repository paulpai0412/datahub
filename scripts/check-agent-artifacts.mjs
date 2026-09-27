import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

const [imageId, directory] = process.argv.slice(2);
assert.match(imageId ?? "", /^sha256:[a-f0-9]{64}$/);
assert.ok(directory);
const code = `
const fs=require('node:fs/promises'), path=require('node:path'), crypto=require('node:crypto');
(async()=>{
  const hash=async p=>crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');
  const root='/app/.next/static', assets={
    '/index.html':await hash('/app/.next/server/app/index.html'),
    '/_next/static/licenses/PHOSPHOR-LICENSE.txt':await hash('/app/public/licenses/PHOSPHOR-LICENSE.txt'),
  };
  for(const entry of await fs.readdir(root,{recursive:true,withFileTypes:true})) if(entry.isFile()) {
    const p=path.join(entry.parentPath,entry.name); assets['/_next/static/'+path.relative(root,p)]=await hash(p);
  }
  const operator={};
  for(const name of ['runtime-entry.mjs','runtime-relay.mjs']) operator[name]=await hash('/opt/datahub-agent/'+name);
  console.log(JSON.stringify({assets,operator,lock:await hash('/app/package-lock.json')}));
})().catch(()=>process.exit(1));`;
const { stdout } = await promisify(execFile)(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "128m",
    "--memory-swap",
    "128m",
    "--cpus",
    "1",
    "--entrypoint",
    "node",
    imageId,
    "-e",
    code,
  ],
  { timeout: 30000, maxBuffer: 1024 * 1024 },
);
let actual;
try {
  actual = JSON.parse(stdout);
} catch {
  throw new Error("invalid_image_artifact_report");
}
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const root = resolve(directory);
const names = (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => `/${relative(root, join(entry.parentPath, entry.name))}`)
  .sort();
assert.deepEqual(names, Object.keys(actual.assets).sort());
for (const [name, expected] of Object.entries(actual.assets))
  assert.equal(await digest(join(root, name)), expected, name);
for (const [name, expected] of Object.entries(actual.operator))
  assert.equal(
    await digest(`extensions/datahub-agent/integration/${name}`),
    expected,
    name,
  );
assert.equal(
  await digest("extensions/datahub-agent/pi-web/package-lock.json"),
  actual.lock,
);
console.log(
  JSON.stringify(
    { imageId, browserAssets: names.length, status: "PASS", ...actual },
    null,
    2,
  ),
);
