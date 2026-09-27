import type {
  CatalogFieldEndpoint,
  CatalogEntity,
  CatalogResult,
} from "../lib/catalog-contract";
import s from "./DataHubCatalog.module.css";

/** Native mapping sets, not pairwise/cartesian edges or inferred SQL transforms. */
export function DataHubCatalogFieldLineage({
  result,
  graph,
  onField,
  onEntity,
}: {
  result: CatalogResult;
  graph: boolean;
  onField: (field: CatalogFieldEndpoint) => void;
  onEntity: (entity: CatalogEntity) => void;
}) {
  function members(fields: CatalogFieldEndpoint[]) {
    return (
      <ul className={s.mappingMembers}>
        {fields.map((field, index) => {
          const selected =
            field.dataset.urn === result.entity?.urn &&
            field.path === result.fieldPath;
          return (
            <li key={`${field.urn}:${index}`}>
              <button
                className={s.mappingField}
                data-selected={selected}
                aria-current={selected ? "true" : undefined}
                onClick={() => onField(field)}
                aria-label={`查看 ${field.dataset.qualifiedName ?? field.dataset.urn} 的欄位 ${field.path}`}
              >
                <span className={s.secondary}>{field.dataset.name}</span>
                <strong>{field.path}</strong>
                {selected && <span className={s.chip}>目前欄位</span>}
                <span className={s.secondary}>
                  {field.dataset.qualifiedName ?? field.dataset.urn}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <section aria-label="原生欄位映射群組">
      <h3>
        {result.fieldPath} ·{" "}
        {result.direction === "UPSTREAM" ? "上游來源" : "下游去向"}
      </h3>
      <p className={s.secondary}>
        本頁 {result.groups?.length ?? 0} 組可見映射。每組保留本次原生 API
        返回的全部欄位端點；箭頭連接輸入／輸出集合，不代表任意兩欄之間都有獨立邊，也不推測轉換公式。
      </p>
      {result.groups?.map((group, index) => (
        <article key={`${group.recordedOn.urn}:${index}`} className={s.section}>
          <h4>
            本頁第 {index + 1} 組 · {group.upstreams.length} 個輸入／
            {group.downstreams.length} 個輸出
          </h4>
          {graph ? (
            <div className={s.mappingGraph}>
              <section aria-label="完整輸入集合">
                <h5>輸入</h5>
                {members(group.upstreams)}
              </section>
              <span className={s.mappingArrow} aria-hidden="true">
                →
              </span>
              <section aria-label="完整輸出集合">
                <h5>輸出</h5>
                {members(group.downstreams)}
              </section>
            </div>
          ) : (
            <div className={s.scroll}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>輸入集合</th>
                    <th>輸出集合</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{members(group.upstreams)}</td>
                    <td>{members(group.downstreams)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <details>
            <summary>群組記錄來源</summary>
            <button
              className={s.link}
              onClick={() => onEntity(group.recordedOn)}
            >
              查看記錄來源：{group.recordedOn.name}
            </button>
            <p>{group.recordedOn.urn}</p>
            <p className={s.secondary}>
              來自此資產的 fineGrainedLineages；不是新增的 Join、持久化群組 ID
              或新核准。未提供群組觀測時間。
            </p>
          </details>
        </article>
      ))}
      {!result.groups?.length && (
        <p>
          本頁未取得端點完整、精確 schema
          可核對且可讀的群組。請查看分頁與限制；這不代表沒有欄位映射。
        </p>
      )}
    </section>
  );
}
