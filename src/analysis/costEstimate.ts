// Kostenschätzung grob ([209]): Menge × Kennwert je eBKP-H-Hauptgruppe, Honorare, Reserve, MwSt. Rechnet der
// Kern auf dem Projekt-Dokument (`src-tauri/core/src/kosten.rs`; Mengen aus der SIA-416-Flächentabelle,
// Herkunft der Vorgabewerte im Modulkopf dort). Diese Datei ist nur die typisierte Fassade.

import type { CostBasis, CostEstimate, CostMethod, Project } from "../model/types";
import { documentFor } from "../core/document";

export type { CostBasis, CostEstimate, CostGroup, CostMethod } from "../model/types";

export interface CostQuantities {
  gv: number;
  gf: number;
  hnf: number;
  facade: number;
  roof: number;
  gvSource: "solids" | "levels" | null;
}

export interface CostRow {
  code: string;
  name: string | null;
  /** Aufgelöste Bezugsmenge (nie „method“). */
  basis: Exclude<CostBasis, "method">;
  quantity: number;
  /** „m³“, „m²“ oder leer (pauschal). */
  unit: string;
  rate: number;
  amount: number;
  /** Kennwert ist der Beispielwert. */
  example: boolean;
}

export interface CostResult {
  method: CostMethod;
  quantities: CostQuantities;
  rows: CostRow[];
  factor: number;
  regionFactor: number;
  indexFactor: number;
  subtotal: number;
  feesPct: number;
  fees: number;
  reservePct: number;
  reserve: number;
  net: number;
  vatPct: number;
  vat: number;
  gross: number;
  accuracyPct: number;
  low: number;
  high: number;
  perGv: number | null;
  perGf: number | null;
  priceBase: string;
  isDefault: boolean;
  hasExample: boolean;
  /** Hinweis-Schlüssel (`costs.note.*`). */
  notes: string[];
}

/** Kostenschätzung des Projekts (ohne `costEstimate` mit Beispielwerten). */
export function computeCostEstimate(project: Project): CostResult {
  return documentFor(project).query<CostResult>("costEstimate");
}

/** Beispielwerte (Kennwerte B–J, Zuschläge) für eine Methode. */
export function defaultCostEstimate(project: Project, method: CostMethod = "gv"): CostEstimate {
  return documentFor(project).query<CostEstimate>("costDefaults", [], method);
}

/** Schweizer Schreibweise mit Tausender-Apostroph (wie der Kern, `area_report::fmt_num`). */
export function formatChf(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "–";
  const s = n.toFixed(digits);
  const [int, frac] = s.split(".");
  const neg = int.startsWith("-");
  const grouped = (neg ? int.slice(1) : int).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${neg ? "-" : ""}${grouped}${frac !== undefined ? `.${frac}` : ""}`;
}
