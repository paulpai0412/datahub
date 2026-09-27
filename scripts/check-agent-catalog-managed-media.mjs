/** Fixed-version source/readback check for Catalog-managed visual assets.
 * No browser, network, credentials, fixtures, metadata writes or deployment. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { managedCatalogImageUrl } from "../extensions/datahub-agent/integration/native-catalog.mjs";
import { catalogNativeUrl } from "../extensions/datahub-agent/pi-web/lib/catalog-contract.ts";

const { values } = parseArgs({
  options: {
    origin: { type: "string" },
    "entity-result": { type: "string" },
    output: { type: "string" },
  },
  strict: true,
});
for (const key of ["origin", "entity-result", "output"])
  assert.ok(values[key], `Required --${key}`);
let origin;
try {
  origin = new URL(values.origin);
} catch {
  throw new Error("Invalid --origin");
}
assert.equal(origin.origin, values.origin, "--origin must be an exact origin");
const require = createRequire(
  new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url),
);
const { parse } = require("yaml");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bootstrapPath = resolve(
  root,
  "upstream/datahub/metadata-service/configuration/src/main/resources/bootstrap_mcps/data-platforms.yaml",
);
const images = resolve(root, "upstream/datahub/datahub-web-react/src/images");
const sourceBytes = await readFile(bootstrapPath);
const records = parse(sourceBytes.toString("utf8"));
assert.ok(Array.isArray(records), "Pinned platform bootstrap is not a list");
const withLogo = records.filter(
  (record) => typeof record?.aspect?.logoUrl === "string",
);
assert.ok(
  withLogo.length > 0,
  "Pinned platform bootstrap has no logo contracts",
);
const projected = withLogo.map((record) => ({
  urn: record.entityUrn,
  source: record.aspect.logoUrl,
  browserUrl: managedCatalogImageUrl(record.aspect.logoUrl, origin),
}));
assert.ok(
  projected.every((entry) => entry.browserUrl),
  "A pinned platform logo would escape the managed asset boundary",
);
let realResult;
try {
  realResult = JSON.parse(
    await readFile(resolve(values["entity-result"]), "utf8"),
  );
} catch {
  throw new Error("Entity result is unavailable or invalid JSON");
}
assert.equal(realResult?.format, "datahub-catalog/1");
assert.equal(realResult?.entity?.type, "DATASET");
const firstField = realResult.fields?.[0]?.path;
assert.ok(
  firstField,
  "Real selected Dataset has no field for navigation check",
);
let schemaUrl, lineageUrl;
try {
  const schemaHref = catalogNativeUrl(realResult.entity, "schema", firstField);
  const lineageHref = catalogNativeUrl(realResult.entity, "lineage");
  assert.ok(schemaHref && lineageHref, "Native navigation unavailable");
  schemaUrl = new URL(schemaHref);
  lineageUrl = new URL(lineageHref);
} catch {
  throw new Error("Pinned native navigation could not be constructed");
}
assert.ok(schemaUrl.pathname.endsWith("/Columns"));
assert.equal(schemaUrl.searchParams.get("highlightedPath"), firstField);
assert.ok(lineageUrl.pathname.endsWith("/Lineage"));
const selected = withLogo.find(
  (record) => record.entityUrn === realResult.entity.platformUrn,
);
assert.ok(selected, "Real selected platform is absent from pinned bootstrap");
assert.equal(
  realResult.entity.platformDisplayName,
  selected.aspect.displayName,
  "Real platform display name differs from pinned public metadata",
);
const sourceImage = resolve(images, basename(selected.aspect.logoUrl));
const imageBytes = await readFile(sourceImage);
assert.ok(imageBytes.length > 0, "Pinned selected platform image is empty");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const receipt = {
  scope:
    "PINNED_MANAGED_PLATFORM_MEDIA_AND_NATIVE_NAVIGATION_NOT_BROWSER_ACCEPTANCE",
  checkedAt: new Date().toISOString(),
  origin: origin.origin,
  source: {
    path: bootstrapPath.slice(root.length + 1),
    sha256: digest(sourceBytes),
    logoContracts: withLogo.length,
  },
  selected: {
    platformUrn: selected.entityUrn,
    displayName: selected.aspect.displayName,
    managedUrl: managedCatalogImageUrl(selected.aspect.logoUrl, origin),
    sourceImage: sourceImage.slice(root.length + 1),
    sourceImageSha256: digest(imageBytes),
    schemaUrl: schemaUrl.href,
    lineageUrl: lineageUrl.href,
    fieldPath: firstField,
  },
  checks: [
    "all pinned bootstrap logo URLs stay under the DataHub-managed assets boundary",
    "selected platform is derived from a real prior adapter result, not a named fixture",
    "selected platform display name matches pinned metadata",
    "selected fixed-version source image exists and is nonempty",
    "real selected Dataset and field produce pinned Columns/highlightedPath navigation",
    "real selected Dataset produces pinned Lineage navigation",
  ],
  limitations: [
    "No network request or browser rendering was performed.",
    "The prior authorized result did not query logoUrl; live returned logo equality remains unverified.",
    "External profile pictures and external platform logos are intentionally not projected.",
  ],
};
await mkdir(resolve(values.output), { recursive: true, mode: 0o700 });
await writeFile(
  resolve(values.output, "receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
  { mode: 0o600 },
);
process.stdout.write(
  JSON.stringify({
    logoContracts: withLogo.length,
    selectedPlatform: receipt.selected.platformUrn,
    managedUrl: receipt.selected.managedUrl,
  }) + "\n",
);
