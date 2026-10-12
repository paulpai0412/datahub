import { createContext } from "react";

/** Workspace presentation only. No consent, selection or mutation authority. */
export const MaintenancePanelContext = createContext<((root: string | null) => void) | null>(null);
