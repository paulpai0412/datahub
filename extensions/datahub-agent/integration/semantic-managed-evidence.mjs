import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { SemanticError } from "./semantic-native-client.mjs";

const salesSource =
  "urn:li:dataHubIngestionSource:c382a4fe-48a9-4a0b-893a-95029a74b25f";
const contract = new URL(
  "../../sales-datamart/metadata/metrics.md",
  import.meta.url,
);

const sourceFiles = new Map([
  ["extensions/sales-datamart/sql/001_create_sales_datamart.sql", new URL("../../sales-datamart/sql/001_create_sales_datamart.sql", import.meta.url)],
  ["extensions/sales-datamart/sql/004_create_monthly_category_summary.sql", new URL("../../sales-datamart/sql/004_create_monthly_category_summary.sql", import.meta.url)],
  ["extensions/sales-datamart/src/sales_datamart/etl.py", new URL("../../sales-datamart/src/sales_datamart/etl.py", import.meta.url)],
  ["extensions/sales-datamart/src/sales_datamart/summary.py", new URL("../../sales-datamart/src/sales_datamart/summary.py", import.meta.url)],
]);
const salesAssets = new Set([
  "dm.dim_date", "dm.dim_product", "dm.dim_customer", "dm.dim_territory",
  "dm.fact_sales_order_line", "dm.monthly_category_summary", "reporting.v_sales_order_line",
].map((name) => `urn:li:dataset:(urn:li:dataPlatform:mssql,salesdatamart.${name},PROD)`));
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const invalid = () => { throw new SemanticError("semantic_contract_invalid", 409); };

/** Pure projection of the SAME fixed first-party document. The Host alone reads
 * it; no caller-supplied path/URL, source description mutation or new state store.
 * The explicit scoped block replaces legacy formula projection for this revision,
 * not a silent ranking of conflicting statements. Legacy pinned bytes are unchanged.
 */
export function projectManagedContractEvidence(policy, assetUrn, fields, bytes) {
  if (policy?.semanticEvidenceSha256 === undefined) return [];
  if (policy.urn !== salesSource || !/^[a-f0-9]{64}$/.test(policy.semanticEvidenceSha256))
    throw new SemanticError("semantic_contract_not_authorized", 403);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 65536 ||
      createHash("sha256").update(bytes).digest("hex") !== policy.semanticEvidenceSha256)
    throw new SemanticError("semantic_contract_changed", 409);
  const content = bytes.toString("utf8");
  if (content.includes("ekop-semantic-catalog-evidence/")) {
    const blocks = [...content.matchAll(/<!-- ekop-semantic-catalog-evidence\/1 -->\r?\n```json\r?\n([\s\S]*?)\r?\n```/g)];
    if (blocks.length !== 1 || content.split("ekop-semantic-catalog-evidence/").length !== 2) invalid();
    let scoped;
    try { scoped = JSON.parse(blocks[0][1]); } catch { invalid(); }
    if (!keys(scoped, ["format", "sources", "statements"]) || scoped.format !== "salesdatamart.semantic-evidence/1" ||
        !object(scoped.sources) || Object.keys(scoped.sources).length === 0 ||
        Object.entries(scoped.sources).some(([file, digest]) => !sourceFiles.has(file) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) ||
        !Array.isArray(scoped.statements) || scoped.statements.length === 0 || scoped.statements.length > 128) invalid();
    const slots = new Set(), result = [];
    for (const [index, statement] of scoped.statements.entries()) {
      if (!keys(statement, ["assetUrn", "fieldPath", "text", "references"]) || !salesAssets.has(statement.assetUrn) ||
          (Object.hasOwn(statement, "fieldPath") && (typeof statement.fieldPath !== "string" || !statement.fieldPath || statement.fieldPath.length > 500)) ||
          typeof statement.text !== "string" || !statement.text.trim() || statement.text.length > 1200 ||
          !Array.isArray(statement.references) || statement.references.length === 0 || statement.references.length > 6 ||
          statement.references.some((ref) => !keys(ref, ["file", "startLine", "endLine"]) || !Object.hasOwn(scoped.sources, ref.file) ||
            !Number.isSafeInteger(ref.startLine) || !Number.isSafeInteger(ref.endLine) || ref.startLine < 1 || ref.endLine < ref.startLine || ref.endLine > 4000)) invalid();
      const slot = JSON.stringify([statement.assetUrn, statement.fieldPath ?? null]);
      if (slots.has(slot)) invalid();
      slots.add(slot);
      if (statement.assetUrn !== assetUrn || !Array.isArray(fields)) continue;
      const fieldIndex = statement.fieldPath === undefined ? null : fields.findIndex((field) => field?.fieldPath === statement.fieldPath);
      if (fieldIndex === -1) continue;
      result.push({
        id: `${fieldIndex === null ? "asset" : `field:${fieldIndex}`}:contract-statement-${index + 1}`,
        text: statement.text.trim(),
        provenance: { file: "extensions/sales-datamart/metadata/metrics.md", sha256: policy.semanticEvidenceSha256,
          pointer: `/statements/${index}`, basis: "pinned_first_party_contract",
          references: statement.references.map((ref) => ({ ...ref, sha256: scoped.sources[ref.file] })),
        },
      });
    }
    return result;
  }
  if (bytes.length > 8192) throw new SemanticError("semantic_contract_changed", 409);
  if (typeof assetUrn !== "string" || !assetUrn.startsWith("urn:li:dataset:") || !Array.isArray(fields)) return [];
  const result = [], lines = content.split(/\r?\n/);
  for (const [index, field] of fields.entries()) {
    if (typeof field?.fieldPath !== "string") continue;
    for (const [lineIndex, line] of lines.entries()) {
      const match = /^- `(?<subject>[A-Za-z][A-Za-z0-9_]*) = [^`]{3,300}`/.exec(
        line,
      );
      if (
        !match ||
        match.groups.subject.toLowerCase() !== field.fieldPath.toLowerCase()
      )
        continue;
      const statement = match[0].slice(3, -1);
      result.push({
        id: `field:${index}:contract-metric-${lineIndex + 1}`,
        text: statement,
        provenance: {
          file: "extensions/sales-datamart/metadata/metrics.md",
          sha256: policy.semanticEvidenceSha256,
          line: lineIndex + 1,
        },
      });
    }
  }
  return result;
}

/** File access stays in the trusted Host and is restricted to fixed deployment
 * sources. Referenced implementation drift invalidates evidence, not its pin.
 */
export async function managedContractEvidence(policy, assetUrn, fields, assertActive = () => {}) {
  if (policy?.semanticEvidenceSha256 === undefined) return [];
  if (policy.urn !== salesSource || !/^[a-f0-9]{64}$/.test(policy.semanticEvidenceSha256))
    throw new SemanticError("semantic_contract_not_authorized", 403);
  assertActive();
  let bytes;
  try { bytes = await readFile(contract); } catch { throw new SemanticError("semantic_contract_unavailable", 409); }
  const result = projectManagedContractEvidence(policy, assetUrn, fields, bytes);
  const references = result.flatMap((item) => item.provenance.references ?? []);
  for (const file of new Set(references.map((ref) => ref.file))) {
    assertActive();
    let source;
    try { source = await readFile(sourceFiles.get(file)); } catch { throw new SemanticError("semantic_contract_unavailable", 409); }
    const digest = createHash("sha256").update(source).digest("hex"), lineCount = source.toString("utf8").split(/\r?\n/).length;
    if (references.some((ref) => ref.file === file && (ref.sha256 !== digest || ref.endLine > lineCount)))
      throw new SemanticError("semantic_contract_changed", 409);
  }
  assertActive();
  return result;
}
