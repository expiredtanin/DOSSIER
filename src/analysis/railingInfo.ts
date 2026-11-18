// Geländer ([279]): Kennzahlen aus dem Rust-Kern (`railing.rs::info`) für die Objekt-Info — Länge der Achse, absolute
// Fuss- und Oberkante, Zahl der Stäbe und Pfosten, Ansichtsfläche. Die Teilung rechnet der Kern (eine Quelle für
// 3D, Schnitt, Ansicht, IFC).

import type { Project } from "../model/types";
import { documentFor } from "../core/document";

export interface RailingInfo {
  /** Länge der Achse (m). */
  length: number;
  /** Absolute Fuss- und Oberkante (m). */
  baseZ: number;
  topZ: number;
  height: number;
  /** Stäbe und Pfosten (nur Art „Stäbe"). */
  bars: number;
  posts: number;
  /** Ansichtsfläche Länge × Höhe (m²). */
  area: number;
  closed: boolean;
}

/** Kennzahlen eines Geländers; `null` bei unbekannter Id oder unsinnigen Massen. */
export function railingInfo(project: Project, id: string): RailingInfo | null {
  if (!(project.railings ?? []).some((r) => r.id === id)) return null;
  return documentFor(project).query<RailingInfo | null>("railingInfo", [], id);
}
