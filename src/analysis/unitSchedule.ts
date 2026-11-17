// Wohnungsspiegel ([278]): Nutzungseinheiten mit Geschoss, Typ, Zimmerzahl und Flächen nach SIA 416.
// Rechnet der Kern auf dem Projekt-Dokument (`src-tauri/core/src/unit_schedule.rs`; Annahmen stehen im Modulkopf).
// Diese Datei ist nur die typisierte Fassade plus kleine Helfer der Oberfläche.

import type { Project, Unit, UnitUsage } from "../model/types";
import { documentFor } from "../core/document";

/** Flächen einer Einheit (m²). */
export interface UnitAreas {
  hnf: number;
  nnf: number;
  /** NF = HNF + NNF. */
  nf: number;
  vf: number;
  ff: number;
  /** Aussenraum (Balkon, Loggia): Flächenart AGF. */
  agf: number;
}

export interface UnitRow extends UnitAreas {
  id: string;
  name: string;
  /** Typ (eingegeben oder aus der Zimmerzahl abgeleitet, z. B. „3.5-Zi-Whg“; leer ohne beides). */
  typeLabel: string;
  usage: UnitUsage;
  /** Namen der Geschosse (unten → oben). */
  floors: string[];
  floorIds: string[];
  /** Zahl der Räume. */
  rooms: number;
  /** Zimmerzahl (nur Wohnnutzung). */
  roomCount: number;
  color: string | null;
  note: string;
}

export interface UnitTypeSum extends UnitAreas {
  typeLabel: string;
  count: number;
  roomCount: number;
  avgHnf: number;
}

export interface UnitLevelSum extends UnitAreas {
  levelId: string;
  name: string;
  count: number;
}

export interface UnitSchedule {
  units: UnitRow[];
  byType: UnitTypeSum[];
  byLevel: UnitLevelSum[];
  total: UnitTypeSum;
  /** Räume ohne (gültige) Einheit. */
  unassigned: UnitAreas & { rooms: number };
}

/** Nutzungen einer Einheit in der Reihenfolge der Auswahl. */
export const UNIT_USAGES: readonly UnitUsage[] = ["living", "commercial", "office", "other"];

/** Wohnungsspiegel des Projekts (`renovation`: Umbau-Zustand, leer = alle Bauteile). */
export function computeUnitSchedule(project: Project, renovation = ""): UnitSchedule {
  return documentFor(project).query<UnitSchedule>("unitSchedule", [], renovation);
}

/** CSV des Spiegels (Trenner „;“); `head` = Spaltenköpfe (Nr., Geschoss, Typ, Nutzung, Zimmer, HNF, NNF, NF, Aussenraum). */
export function unitScheduleCsv(project: Project, head: string[]): string {
  return documentFor(project).query<string>("unitSchedule", [], JSON.stringify({ head }));
}

/** Vorschlag für den Namen einer neuen Einheit: Präfix + erste freie Zahl („Whg 3“). */
export function nextUnitName(units: readonly Unit[], prefix: string): string {
  const taken = new Set(units.map((u) => u.name));
  for (let n = units.length + 1; ; n++) {
    const name = `${prefix} ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Neue, noch unbenutzte Einheiten-Id. */
export function newUnitId(units: readonly Unit[]): string {
  const taken = new Set(units.map((u) => u.id));
  for (let n = units.length + 1; ; n++) {
    const id = `unit-${n}`;
    if (!taken.has(id)) return id;
  }
}
