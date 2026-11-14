// Baurecht-Nachweis ([255]): Vorgaben der Parzelle (`Project.siteRules`) gegen die Kennzahlen des Modells —
// zulässig · Projekt · Reserve/Überschreitung · erfüllt, dazu die Grundlagen mit Quelle. Rechnet der Kern
// (`src-tauri/core/src/site_proof.rs`) auf dem Projekt-Dokument; diese Datei ist die typisierte Fassade.

import type { Project } from "../model/types";
import { documentFor } from "../core/document";
import type { IvhbOptions } from "./areaTable";

export interface ProofRow {
  /** gfz, az, bmz, uz, gz, totalHeight, facadeHeight, setback, profile. */
  key: string;
  /** `max`: Projekt ≤ zulässig; `min`: Projekt ≥ zulässig. */
  limit: "max" | "min";
  /** `null` = keine Vorgabe im Projekt. */
  allowed: number | null;
  actual: number | null;
  /** Positiv = Reserve, negativ = Überschreitung (Unterschreitung bei `min`). */
  reserve: number | null;
  /** `null` = nicht prüfbar (Vorgabe oder Projektwert fehlt). */
  ok: boolean | null;
  decimals: number;
  unit: string;
}

export interface ProofBasis {
  /** agsf, allowedArea, gf, agf, agbf, baumasse, greenArea. */
  key: string;
  value: number | null;
  decimals: number;
  unit: string;
  /** Schlüssel der Quelle (`siteProof.src.<source>`). */
  source: string;
}

export interface SiteProof {
  rows: ProofRow[];
  basis: ProofBasis[];
  /** Hinweis-Schlüssel (`siteProof.note.<key>`). */
  notes: string[];
  hasLimits: boolean;
  /** Alle prüfbaren Vorgaben erfüllt; `null` ohne prüfbare Vorgabe. */
  allOk: boolean | null;
}

/** Baurecht-Nachweis; die Optionen wie bei {@link computeIvhb} (aGSF, Grünfläche, Basis der aGF). */
export function computeSiteProof(project: Project, options: IvhbOptions = {}): SiteProof {
  return documentFor(project).query<SiteProof>("siteProof", [], JSON.stringify(options));
}
