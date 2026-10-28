// Raumprogramm ([61]): Soll/Ist-Vergleich und Anordnung der Soll-Räume. Rechnet der Kern auf dem
// Projekt-Dokument (`src-tauri/core/src/room_program.rs`; Zuordnung, Ampel und Packing stehen dort).
// Diese Datei ist nur die typisierte Fassade.

import type { Project } from "../model/types";
import { documentFor } from "../core/document";

export type ProgramStatus = "ok" | "zu klein" | "zu gross" | "fehlt" | "zu wenige" | "zu viele";
export type Light = "green" | "yellow" | "red" | "grey";

export interface CompareRow {
  /** Index der Programmzeile. */
  index: number;
  name: string;
  group: string | null;
  /** Flächenart (SIA-416-Kürzel). */
  kind: string | null;
  targetCount: number;
  /** Soll-Fläche je Raum (m²). */
  targetArea: number;
  /** Soll gesamt = Anzahl × Fläche. */
  soll: number;
  /** Zugeordnete Räume im Modell. */
  count: number;
  ist: number;
  diff: number;
  /** Differenz relativ zum Soll; `null` bei Soll 0. */
  diffPct: number | null;
  status: ProgramStatus;
  light: Light;
}

export interface CompareSum {
  /** Gruppe bzw. Flächenart; leer = ohne Angabe. */
  key: string;
  rows: number;
  soll: number;
  ist: number;
  diff: number;
  diffPct: number | null;
  light: Light;
}

export interface RoomProgramCompare {
  /** Toleranz als Anteil (0.05 = ±5 %). */
  tolerance: number;
  rows: CompareRow[];
  groups: CompareSum[];
  kinds: CompareSum[];
  total: CompareSum;
  /** Räume im Modell ohne Programmzeile. */
  extra: Array<{ id: string; name: string; area: number }>;
  extraArea: number;
}

/** Standard-Toleranz der Ampel (Anteil der Soll-Fläche). */
export const DEFAULT_PROGRAM_TOLERANCE = 0.05;

/** Soll/Ist-Vergleich des Raumprogramms mit den gezeichneten Räumen. */
export function compareRoomProgram(project: Project): RoomProgramCompare {
  return documentFor(project).query<RoomProgramCompare>("programCompare");
}

export interface LayoutOptions {
  /** Abstand zwischen den Rechtecken (m, Default 1). */
  gap?: number;
  /** Höhe des Titelbereichs je Gruppe (m, Default 1.6). */
  titleHeight?: number;
}

export interface LayoutItem {
  row: number;
  copy: number;
  name: string;
  groupIndex: number;
  area: number;
  /** Linke untere Ecke, Breite (x) und Tiefe (y) in Metern. */
  x: number;
  y: number;
  w: number;
  d: number;
}

export interface LayoutGroup {
  index: number;
  /** Leer = ohne Titel. */
  name: string;
  x: number;
  y: number;
  w: number;
  titleHeight: number;
  area: number;
}

export interface RoomProgramLayout {
  items: LayoutItem[];
  groups: LayoutGroup[];
  width: number;
  height: number;
  skipped: number;
}

/** Soll-Räume als Rechtecke 4 : 3 mit exakter Fläche, nach Gruppe geordnet und in Reihen gepackt. */
export function layoutRoomProgram(project: Project, opts: LayoutOptions = {}): RoomProgramLayout {
  return documentFor(project).query<RoomProgramLayout>("programLayout", [], JSON.stringify(opts));
}
