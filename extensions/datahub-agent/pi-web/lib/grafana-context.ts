"use client";
import { createContext } from "react";
import type { GrafanaEmbed } from "./grafana-embed-contract";
export const GrafanaContext = createContext<((value: GrafanaEmbed) => void) | null>(null);
