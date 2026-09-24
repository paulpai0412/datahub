import { createContext } from "react";
import type { CatalogRequest } from "./catalog-contract";

export type CatalogTab =
 | "about"
 | "schema"
 | "lineage"
 | "properties"
 | "sources";
export type CatalogSelection = {
 request: CatalogRequest;
 tab: CatalogTab;
 title: string;
};

/** Existing workspace panel control only. Null closes Catalog; a trusted dialog
 * passes restoreFocus=false so focus is not pulled behind the dialog. No read,
 * approval or write authority is carried by this context. */
export const CatalogContext = createContext<
 ((selection: CatalogSelection | null, restoreFocus?: boolean) => void) | null
>(null);
