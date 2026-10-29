// Raumprogramm aus einer Tabelle importieren ([61]): .xlsx, .ods, .csv/.tsv.
//
//  • Lesen der Datei und Zahlen-Parser stehen im Rust-Modul `fileio/src/sheet_import.rs`
//    (`readSheetFile`, `cellNumber`).
//  • Die Zuordnung (Kopfzeile erkennen, Spalten vorschlagen, Zeilen abbilden) rechnet `fileio/src/sheet_map.rs`;
//    hier nur Fassade (JSON, Tabellen sind klein) und das Einfügen ins Projekt (ersetzen oder anhängen).
// Reine Funktionen ohne UI; der Dialog ist `ui/RoomProgramImportDialog.tsx`.

import type { Project, RoomProgramRow, SiaCategory } from "../model/types";
import { fileio, loadFileio } from "../engine/fileioWasm";
import { applyOps } from "../core/ops";
import type { CoreOp } from "../core/ops";
import { setField } from "../core/opsBuild";

export type SheetCell = string | number | null;

export interface SheetData {
  name: string;
  rows: SheetCell[][];
}

/** Felder einer Programmzeile, denen eine Spalte zugeordnet werden kann. */
export type ProgramField = "name" | "area" | "count" | "kind" | "group" | "note";

export const PROGRAM_FIELDS: readonly ProgramField[] = ["name", "area", "count", "kind", "group", "note"];

/** Spaltenindex je Feld (0-basiert); fehlend = nicht zugeordnet. */
export type ColumnMap = Partial<Record<ProgramField, number>>;

export interface Mapping {
  /** Zeile (0-basiert) der Spaltenüberschriften; `null` = keine Kopfzeile. */
  headerRow: number | null;
  columns: ColumnMap;
}

/** Tabellenblätter einer Datei (lädt das Format-Modul beim ersten Aufruf). */
export async function readSheetFile(bytes: Uint8Array, fileName: string): Promise<SheetData[]> {
  const m = await loadFileio();
  return JSON.parse(m.sheet_read(bytes, fileName)) as SheetData[];
}

/** Zahl einer Zelle: Zahl bleibt, Text wird geparst ("1'250,5", "12,5 m²"), sonst `null`. Format-Modul muss geladen sein. */
export function cellNumber(c: SheetCell | undefined): number | null {
  if (typeof c === "number") return Number.isFinite(c) ? c : null;
  if (typeof c !== "string" || c.trim() === "") return null;
  const v = fileio().sheet_parse_number(c);
  return Number.isNaN(v) ? null : v;
}

/** Text einer Zelle (Zahlen ohne Nachkomma-Rauschen, leer = ""). */
export function cellText(c: SheetCell | undefined): string {
  if (c === null || c === undefined) return "";
  return fileio().sheet_cell_text(JSON.stringify(c));
}

/** Kopfzeile in den ersten Zeilen (`null` = keine). */
export function detectHeaderRow(rows: SheetCell[][]): number | null {
  const r = fileio().sheet_detect_header_row(JSON.stringify(rows));
  return r < 0 ? null : r;
}

/** Vorschlag: Kopfzeile erkennen und Spalten zuordnen (Überschriften de/en/fr, sonst aus den Daten). */
export function suggestMapping(rows: SheetCell[][]): Mapping {
  return JSON.parse(fileio().sheet_suggest_mapping(JSON.stringify(rows))) as Mapping;
}

export type SkipReason = "empty" | "sum" | "noName" | "noArea" | "header";

export interface ImportLine {
  /** Zeile im Blatt (0-basiert). */
  sheetRow: number;
  /** Fertige Programmzeile; `undefined`, wenn die Zeile übersprungen wird. */
  row?: RoomProgramRow;
  skip?: SkipReason;
  /** Gruppenzeile: Name wird zur Gruppe der folgenden Zeilen (ohne zugeordnete Gruppenspalte). */
  groupHeading?: string;
  /** Die Flächenart-Zelle war gefüllt, aber nicht erkannt. */
  unknownKind?: string;
}

/** Flächenart aus Text ("HNF", "HNF 1.1", "Hauptnutzfläche"); sonst `undefined`. */
export function parseKind(text: string): SiaCategory | undefined {
  const k = fileio().sheet_parse_kind(text);
  return k === "" ? undefined : (k as SiaCategory);
}

export interface MapOptions {
  /** Summenzeilen überspringen (Default ja). */
  skipSums?: boolean;
}

/** Eine Tabelle mit Zuordnung in Programmzeilen übersetzen (Format-Modul muss geladen sein). */
export function mapRows(rows: SheetCell[][], mapping: Mapping, opts: MapOptions = {}): ImportLine[] {
  return JSON.parse(fileio().sheet_map_rows(JSON.stringify(rows), JSON.stringify(mapping), opts.skipSums ?? true)) as ImportLine[];
}

/** Programmzeilen der Übersetzung. */
export function importedRows(lines: ImportLine[]): RoomProgramRow[] {
  return lines.flatMap((l) => (l.row ? [l.row] : []));
}

export type ImportMode = "replace" | "append";

/** Ops: Programmzeilen ins Projekt einfügen — ersetzen oder anhängen. Keine Zeilen → keine Ops. */
export function roomProgramOps(project: Project, rows: RoomProgramRow[], mode: ImportMode): CoreOp[] {
  if (rows.length === 0) return [];
  return [setField("roomProgram", mode === "append" ? [...(project.roomProgram ?? []), ...rows] : rows)];
}

/** Wie {@link roomProgramOps}, als Projekt → Projekt (CLI, Tests). Keine Zeilen → unverändert. */
export function applyRoomProgram(project: Project, rows: RoomProgramRow[], mode: ImportMode): Project {
  return applyOps(project, roomProgramOps(project, rows, mode));
}
