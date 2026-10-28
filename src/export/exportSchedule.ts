// Bauteil-Schedule (Bauteilliste) — CSV-Export einer Bauteilaufstellung des Projekts
// (AUDIT A6, DOSSIER-Parität). Gerechnet wird im Rust-Kern (`src-tauri/core/src/export_schedule.rs`,
// [K4] S2) auf dem Projekt-Dokument: EINE Zeile je Bauteil-VORKOMMEN (Wand, Decke, Tür, Fenster,
// Treppe, Extrusion, Dach, Stütze); Räume sind bewusst nicht enthalten (eigener CSV-Export in
// `geometry/roomArea`). Optional folgt ein Aggregat-Block je Bauteil-Typ. Der Download
// (Blob + Anchor) passiert im App-Layer. Einheit: METER.

import type { Project } from "../model/types";
import { documentFor } from "../core/document";

/** Bauteilklassen der Bauteilliste. */
export type ScheduleKind =
  | "Wand"
  | "Decke"
  | "Tür"
  | "Fenster"
  | "Öffnung"
  | "Treppe"
  | "Extrusion"
  | "Dach"
  | "Stütze";

/** Eine ausgewertete Zeile der Bauteilliste (je Bauteil-Vorkommen ein Datensatz). */
export interface ScheduleRow {
  /** Bauteilklasse. */
  kind: ScheduleKind;
  /** Element-ID (stabile Kennung). */
  id: string;
  /** Name des Bauteil-Typs (Wandtyp/Deckentyp) bzw. Bauteilklasse ohne eigenen Typ. */
  typeName: string;
  /** Geschoss-Name. */
  floor: string;
  /**
   * Geschoss-ID (rohe DrawingLevel-Referenz, additiv für Konsumenten wie das Elemente-Panel — NICHT
   * Teil der CSV-Spalten). Fehlt bei verwaister Referenz (z. B. Öffnung mit gelöschter Wirtswand).
   */
  floorId?: string;
  /** Achslänge bzw. lichte Breite in Metern (null wo nicht verlässlich ableitbar). */
  length: number | null;
  /** Höhe in Metern (null wo nicht verlässlich ableitbar). */
  heightM: number | null;
  /** Gesamtdicke in Metern (null wo nicht verlässlich ableitbar). */
  thickness: number | null;
  /** Fläche in m² (null wo nicht verlässlich ableitbar, z. B. Treppe). */
  area: number | null;
}

/**
 * Wertet ALLE Bauteil-Vorkommen eines Projekts aus. Reihenfolge: Wände, Decken, Öffnungen, Treppen,
 * Extrusionen, Dächer, Stützen (je in Dokumentreihenfolge).
 */
export function scheduleRows(project: Project): ScheduleRow[] {
  return documentFor(project).query<ScheduleRow[]>("scheduleRows");
}

export interface ScheduleCsvOptions {
  /** Feldtrenner. Default „;" (Excel-DE-freundlich, wie der Raum-CSV). */
  delimiter?: string;
  /** true (Default): Aggregat-Block je Bauteil-Typ unter die Liste anhängen. */
  includeSummary?: boolean;
}

/**
 * Baut die Bauteilliste des Projekts als CSV-String (kein Datei-IO). Leeres Projekt ⇒ nur die
 * Kopfzeile (kein Crash).
 */
export function exportScheduleCsv(project: Project, options: ScheduleCsvOptions = {}): string {
  return documentFor(project).queryJson("scheduleCsv", [options.includeSummary ?? true ? 1 : 0], options.delimiter ?? ";");
}
