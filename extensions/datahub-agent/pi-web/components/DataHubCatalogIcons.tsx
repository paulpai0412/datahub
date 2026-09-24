import { catalogIconPaths } from "../lib/catalog-icon-paths";
import type { CatalogTab } from "../lib/catalog-context";
import type { CatalogEntity } from "../lib/catalog-contract";
import s from "./DataHubCatalog.module.css";

type IconName = keyof typeof catalogIconPaths;
// Pinned Core entityV2 icon selections; these are entity types, not business data.
const entityIcons: Partial<Record<string, IconName>> = {
  DATASET: "Table",
  SCHEMA_FIELD: "Rows",
  CONTAINER: "Folder",
  DATA_FLOW: "ShareNetwork",
  DATA_JOB: "Swap",
  CHART: "ChartLine",
  DASHBOARD: "ChartBar",
  TAG: "Tag",
  GLOSSARY_TERM: "BookmarkSimple",
  DOMAIN: "Globe",
  CORP_USER: "User",
  CORP_GROUP: "UsersThree",
};
const tabIcons: Record<CatalogTab, IconName> = {
  about: "BookOpen",
  schema: "Columns",
  lineage: "TreeStructure",
  properties: "ListBullets",
  sources: "Info",
};
function Icon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 256 256"
      width="20"
      height="20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {catalogIconPaths[name].map((path, index) => (
        <path key={index} d={path} />
      ))}
    </svg>
  );
}
export function CatalogTabIcon({ kind }: { kind: CatalogTab }) {
  return <Icon name={tabIcons[kind]} />;
}
export function CatalogEntityIcon({ type }: { type?: string }) {
  const name =
    type && Object.hasOwn(entityIcons, type) ? entityIcons[type] : undefined;
  // Unknown entity kinds retain their textual type; never pretend to be a table.
  return name ? (
    <span className={s.icon}>
      <Icon name={name} />
    </span>
  ) : null;
}
export function CatalogEntityVisual({ entity }: { entity: CatalogEntity }) {
  return entity.imageUrl ? (
    <span className={`${s.icon} ${s.entityImage}`} aria-hidden="true">
      {/* DataHub-managed runtime asset URL; next/image cannot predeclare it. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={entity.imageUrl}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
      />
    </span>
  ) : (
    <CatalogEntityIcon type={entity.type} />
  );
}
