// Anonymitäts-Prüfung des Freitexts ([208]): dünne Fassade über den Kern (`src-tauri/core/src/competition.rs`).
// Vor dem Export einer anonymen Abgabe sucht sie identifizierende Angaben (Projektname, -nummer, Büro/Bearbeiter
// des Titelblocks, Adresse, Angaben unter `competition.identifiers`, Dateiname, E-Mail, Telefon) in allen frei
// eingegebenen Texten des Projekts. Die Kopfdaten der Ausgaben leert `competitionIdentity.ts` selbst.
//
// Bezeichner englisch, Kommentare deutsch.

import { core } from "../engine/coreWasm";
import type { Project } from "../model/types";
import { isAnonymous } from "./competitionIdentity";

/** Herkunft des gefundenen Begriffs. */
export type AnonymityKind = "name" | "number" | "titleBlock" | "address" | "identifier" | "file" | "email" | "phone";

export interface AnonymityFinding {
  /** Oberste Projekt-Liste (`rooms`, `drawingLevels` …) bzw. Bereich eines Zusatztexts (`export`). */
  area: string;
  /** Fundstelle: Elementname und Feld. */
  place: string;
  /** Der Text (gekürzt). */
  text: string;
  /** Der gefundene Begriff. */
  term: string;
  kind: AnonymityKind;
}

export interface AnonymityExtraText {
  area: string;
  place: string;
  text: string;
}

export interface AnonymityOptions {
  /** Dateiname des Projekts (als Begriff gesucht). */
  fileName?: string;
  /** Weitere zu prüfende Texte, z. B. der Dateiname der Ausgabe. */
  texts?: AnonymityExtraText[];
}

/** Treffer im Freitext; leer bei nicht anonymer Abgabe und wenn alles sauber ist. */
export function anonymityFindings(project: Project, options: AnonymityOptions = {}): AnonymityFinding[] {
  if (!isAnonymous(project)) return [];
  const out = core().anonymity_findings(JSON.stringify(project), JSON.stringify({ fileName: options.fileName ?? "", texts: options.texts ?? [] }));
  try {
    const parsed: unknown = JSON.parse(out);
    return Array.isArray(parsed) ? (parsed as AnonymityFinding[]) : [];
  } catch {
    return [];
  }
}
