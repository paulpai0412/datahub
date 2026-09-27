#!/usr/bin/env node
// Compare vendored geometry to the pinned public archive. Never execute package code.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { catalogIconPaths } from "../extensions/datahub-agent/pi-web/lib/catalog-icon-paths.ts";

const { values } = parseArgs({
  options: { archive: { type: "string" }, output: { type: "string" } },
  strict: true,
});
assert.ok(
  values.archive,
  "--archive must point to the original pinned Phosphor .tgz",
);
const require = createRequire(
  new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url),
);
const ts = require("typescript");
const assets = "extensions/datahub-agent/design/assets/";
let manifest;
try {
  manifest = JSON.parse(
    await readFile(assets + "catalog-icons.provenance.json", "utf8"),
  );
} catch {
  throw new Error("Icon provenance manifest is unreadable or invalid JSON");
}
const lock = await readFile(
  "upstream/datahub/datahub-web-react/yarn.lock",
  "utf8",
);
const block = lock.match(
  /^"@phosphor-icons\/react@[^\n]+\n(?:[^\n]+\n)+/m,
)?.[0];
assert.ok(block, "Pinned upstream icon dependency missing");
assert.ok(block.includes(`version "${manifest.package.split("@").at(-1)}"`));
assert.ok(block.includes(`resolved "${manifest.url}"`));
assert.ok(block.includes(`integrity ${manifest.integrity}`));
const archive = await readFile(values.archive);
assert.equal(
  "sha512-" + createHash("sha512").update(archive).digest("base64"),
  manifest.integrity,
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const extract = (name) =>
  execFileSync("tar", ["-xOzf", resolve(values.archive), `package/${name}`], {
    maxBuffer: 1048576,
  });
const license = extract("LICENSE");
assert.deepEqual(await readFile(assets + "PHOSPHOR-LICENSE"), license);
assert.deepEqual(
  await readFile(
    "extensions/datahub-agent/pi-web/public/licenses/PHOSPHOR-LICENSE.txt",
  ),
  license,
);
const canonical = {};
for (const name of Object.keys(catalogIconPaths).sort()) {
  assert.match(name, /^[A-Z][A-Za-z]+$/);
  const source = extract(`dist/defs/${name}.mjs`);
  assert.equal(sha(source), manifest.sourceDefinitions[name]);
  const tree = ts.createSourceFile(
    name,
    source.toString(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let regular;
  function findWeight(node) {
    if (
      ts.isArrayLiteralExpression(node) &&
      node.elements[0] &&
      ts.isStringLiteral(node.elements[0]) &&
      node.elements[0].text === "regular"
    )
      regular = node.elements[1];
    ts.forEachChild(node, findWeight);
  }
  findWeight(tree);
  assert.ok(regular, `Missing regular weight: ${name}`);
  const paths = [];
  function readPaths(node) {
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      assert.equal(node.arguments[0].text, "path");
      assert.ok(ts.isObjectLiteralExpression(node.arguments[1]));
      const props = node.arguments[1].properties;
      assert.equal(props.length, 1);
      assert.equal(props[0].name.getText(tree), "d");
      assert.ok(ts.isStringLiteral(props[0].initializer));
      paths.push(props[0].initializer.text);
    }
    ts.forEachChild(node, readPaths);
  }
  readPaths(regular);
  assert.deepEqual(
    [...catalogIconPaths[name]],
    paths,
    `Geometry mismatch: ${name}`,
  );
  canonical[name] = paths;
}
assert.equal(sha(JSON.stringify(canonical)), manifest.pathsCanonicalSha256);
const result = {
  scope: "PINNED_STATIC_ICON_SOURCE_AND_LICENSE_NOT_BROWSER_ACCEPTANCE",
  icons: Object.keys(canonical).length,
  package: manifest.package,
  pathsCanonicalSha256: manifest.pathsCanonicalSha256,
  checkedAt: new Date().toISOString(),
};
if (values.output)
  await writeFile(values.output, JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
console.log(JSON.stringify(result));
