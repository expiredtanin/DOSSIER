// Erdarbeiten ([68]): Mengen der Baugruben aus dem Rust-Kern (`src-tauri/core/src/excavation.rs`).
// Abtrag/Auftrag je Baugrube gegen das gewachsene Terrain (Integral über ein feines Raster der exakten
// Böschungsfunktion), Hinterfüllung = Abtrag ausserhalb der Gebäude-Grundfläche.

import type { Project } from "../model/types";
import { documentFor } from "../core/document";

export interface ExcavationQuantity {
  id: string;
  name: string;
  /** Sohle (m, Modell ±0.00). */
  bottom: number;
  /** Sohlenfläche (m²). */
  bottomArea: number;
  /** Abtrag (m³). */
  cut: number;
  /** Auftrag/Schüttung (m³). */
  fill: number;
  /** Hinterfüllung (m³). */
  backfill: number;
}

export function excavationQuantities(project: Project): ExcavationQuantity[] {
  if (!(project.context ?? []).some((o) => o.type === "excavation")) return [];
  return documentFor(project).query<ExcavationQuantity[]>("excavationQuantities");
}
