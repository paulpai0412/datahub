import type {
  CatalogEntity,
  CatalogField,
  CatalogFieldSource,
} from "../lib/catalog-contract";
import { CatalogEntityIcon } from "./DataHubCatalogIcons";
import s from "./DataHubCatalog.module.css";

const sourceLabels: Record<CatalogFieldSource, string> = {
  SCHEMA_METADATA: "來源 schema",
  EDITABLE_SCHEMA: "DataHub 可編輯 metadata（精確 path）",
  SCHEMA_FIELD_ENTITY: "原生欄位實體",
};
export function CatalogFieldChips({
  field,
  kind,
  onEntity,
}: {
  field: CatalogField;
  kind?: "Tag" | "Term";
  onEntity?: (entity: CatalogEntity) => void;
}) {
  const refs = (field.references ?? []).filter(
    (ref) => kind === undefined || ref.kind === kind,
  );
  return (
    <>
      {refs.map((ref) => (
        <div key={`${ref.kind}:${ref.entity.urn}`} className={s.fieldReference}>
          <button
            className={s.chip}
            title={ref.entity.name}
            disabled={!onEntity}
            onClick={() => onEntity?.(ref.entity)}
          >
            <CatalogEntityIcon type={ref.entity.type} />
            <span className={s.chipLabel}>{ref.entity.name}</span>
          </button>
          <span className={s.secondary}>
            {ref.sources.map((source) => sourceLabels[source]).join(" · ")}
          </span>
        </div>
      ))}
      {!refs.length && (
        <span className={s.secondary}>
          {field.references === undefined
            ? "結果未提供；請重新查詢"
            : "未取得可呈現項目（非不存在）"}
        </span>
      )}
      {field.referenceTruncated && (
        <p className={s.secondary}>已達本次治理讀取上限；非完整清單。</p>
      )}
    </>
  );
}
export function CatalogFieldGovernance({
  field,
  onEntity,
}: {
  field: CatalogField;
  onEntity: (entity: CatalogEntity) => void;
}) {
  return (
    <section aria-label="欄位治理與描述來源">
      <details className={s.section}>
        <summary>描述來源</summary>
        {field.sourceDescription === undefined &&
        field.editedDescription === undefined ? (
          <p>這份結果未提供來源區分；請重新查詢。</p>
        ) : (
          <dl className={s.definition}>
            <dt>來源 schema 描述</dt>
            <dd className={s.description}>
              {field.sourceDescription ?? "未提供"}
            </dd>
            <dt>DataHub 可編輯 metadata 描述</dt>
            <dd className={s.description}>
              {field.editedDescription === ""
                ? "已明確設為空字串"
                : (field.editedDescription ?? "未提供")}
            </dd>
          </dl>
        )}
        <p className={s.secondary}>
          只核對精確 field path；沒有取得 Documentation
          aspect、推斷或傳播描述，不將缺值補成其他來源。
        </p>
      </details>
      {(["Tag", "Term"] as const).map((kind) => (
        <details className={s.section} open key={kind}>
          <summary>{kind === "Tag" ? "欄位標籤" : "欄位詞彙"}</summary>
          <CatalogFieldChips field={field} kind={kind} onEntity={onEntity} />
        </details>
      ))}
    </section>
  );
}
