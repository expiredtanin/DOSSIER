// Flächentabelle und IVHB-Kennziffern ([70]). Rechnet der Kern auf dem Projekt-Dokument
// (`src-tauri/core/src/flaechen.rs`; Herleitung und Quellen stehen dort im Modulkopf).
// Diese Datei ist nur die typisierte Fassade.

import type { Project } from "../model/types";
import { documentFor } from "../core/document";

/** Eine Zeile der Flächentabelle: ein Geschoss oder die Summe (Flächenarten nach SIA 416). */
export interface AreaRow {
  levelId: string;
  name: string;
  /** Oberkante ≤ ±0.00. */
  underground: boolean;
  hnf: number;
  nnf: number;
  /** NF = HNF + NNF. */
  nf: number;
  vf: number;
  ff: number;
  /** NGF = NF + VF + FF. */
  ngf: number;
  /** Konstruktionsfläche (aus Wandgrundrissen und KGF-Räumen). */
  kf: number;
  /** GF = NGF + KF. */
  gf: number;
  /** Aussengeschossfläche — nicht Teil der GF. */
  agf: number;
  height: number;
  /** GF × Geschosshöhe. */
  gv: number;
  rooms: number;
}

export type GvSource = "solids" | "levels";

export interface AreaTable {
  levels: AreaRow[];
  total: AreaRow;
  /** Gebäudevolumen (m³) gemäss `gvSource`. */
  gv: number;
  gvSource: GvSource;
  /** Hinweis-Schlüssel (Annahmen der Rechnung). */
  notes: string[];
}

/** Welche Fläche als „anrechenbare Geschossfläche" der AZ zählt (kantonal verschieden). */
export type AgfBasis = "gf" | "ngf" | "nf";

/** Eingaben, die das Modell nicht hergibt. */
export interface IvhbOptions {
  /** Anrechenbare Grundstücksfläche (m²); sonst Parzellenfläche / Parzellengrenze. */
  agsf?: number;
  /** Anrechenbare Grünfläche (m²). */
  greenArea?: number;
  agfBasis?: AgfBasis;
  /** Unterirdische Geschosse mitrechnen. */
  includeUnderground?: boolean;
}

export type AgsfSource = "input" | "parcelArea" | "parcelRing" | "none";

export interface Ivhb {
  agsf: number | null;
  agsfSource: AgsfSource;
  agfBasis: AgfBasis;
  includeUnderground: boolean;
  gfSum: number;
  agf: number;
  baumasse: number;
  agbf: number;
  greenArea: number | null;
  az: number | null;
  gfz: number | null;
  bmz: number | null;
  uz: number | null;
  gz: number | null;
  totalHeight: number | null;
  facadeHeight: number | null;
  notes: string[];
}

/** SIA-416-Flächentabelle je Geschoss und total. */
export function computeAreaTable(project: Project): AreaTable {
  return documentFor(project).query<AreaTable>("areaTable");
}

/** IVHB-Kennziffern (GFZ, AZ, BMZ, ÜZ, GZ, Höhen). */
export function computeIvhb(project: Project, options: IvhbOptions = {}): Ivhb {
  return documentFor(project).query<Ivhb>("ivhb", [], JSON.stringify(options));
}
