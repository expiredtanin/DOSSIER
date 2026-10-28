// Raumprogramm aus einer Tabelle importieren ([61]): .xlsx, .ods, .csv/.tsv.
//
//  • Lesen der Datei und Zahlen-Parser stehen im Rust-Modul `fileio/src/sheet_import.rs`
//    (`readSheetFile`, `cellNumber`).
//  • Hier die Zuordnung: Kopfzeile erkennen, Spalten nach Spaltennamen vorschlagen (de/en/fr),
//    Zeilen in `RoomProgramRow`s abbilden (Summenzeilen und Leerzeilen überspringen, Gruppenzeilen
//    als Gruppe der folgenden Zeilen) und ins Projekt einfügen (ersetzen oder anhängen).
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
  if (typeof c === "number") return Number.isInteger(c) ? String(c) : String(Math.round(c * 1e6) / 1e6);
  return c.trim();
}

// ── Spaltennamen ────────────────────────────────────────────────────────────

/** Vergleichsform: klein, ohne Umlaut-Punkte/Akzente, nur Buchstaben und Ziffern. */
function key(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/²/g, "2")
    .replace(/[^a-z0-9]+/g, "");
}

/** Bekannte Spaltenüberschriften (Vergleichsform) je Feld, deutsch/englisch/französisch. */
const HEADERS: Record<ProgramField, string[]> = {
  name: ["raum", "raume", "raumname", "raumbezeichnung", "bezeichnung", "name", "nutzung", "raumnutzung", "room", "rooms", "roomname", "designation", "description", "space", "piece", "local", "pieces", "designationdupiece", "nomdupiece"],
  area: ["flache", "m2", "qm", "sollflache", "flachem2", "flachejeraum", "flacheproraum", "grosse", "area", "surface", "sollm2", "soll", "nettoflache", "nutzflache", "size", "m2jeraum", "flachesoll", "areasqm", "aream2"],
  count: ["anzahl", "anz", "stk", "stuck", "stuk", "menge", "n", "count", "qty", "quantity", "number", "nombre", "nb", "nbre", "quantite", "pcs", "sollanzahl"],
  kind: ["flachenart", "art", "kategorie", "category", "sia", "sia416", "typ", "type", "nutzungsart", "nutzungskategorie", "kat", "flachentyp", "kind", "categorie", "genre"],
  group: ["gruppe", "geschoss", "etage", "bereich", "group", "level", "floor", "storey", "abteilung", "zone", "nutzungseinheit", "cluster", "gruppierung", "stockwerk", "niveau", "groupe", "secteur"],
  note: ["bemerkung", "bemerkungen", "kommentar", "notiz", "notizen", "anmerkung", "anmerkungen", "note", "notes", "comment", "comments", "remark", "remarks", "remarque", "remarques", "commentaire", "hinweis", "beschreibung"],
};

/** Wie gut passt eine Überschrift zu einem Feld: 2 = genau, 1 = enthält (ab 3 Zeichen), 0 = nein. */
function headerScore(cell: string, field: ProgramField): number {
  const k = key(cell);
  if (k === "") return 0;
  if (HEADERS[field].includes(k)) return 2;
  if (field === "area" && /(flache|m2|qm)/.test(k) && k.length <= 24) return 1;
  if (field === "name" && /(raum|bezeichnung)/.test(k)) return 1;
  if (field === "count" && /(anzahl|stuck|stk)/.test(k)) return 1;
  if (field === "kind" && /(flachenart|kategorie|nutzungsart)/.test(k)) return 1;
  if (field === "group" && /(gruppe|geschoss|etage)/.test(k)) return 1;
  if (field === "note" && /(bemerk|kommentar|notiz)/.test(k)) return 1;
  return 0;
}

/** Spalten nach Überschriften der Zeile `headerRow`: jedem Feld höchstens eine Spalte, beste Treffer zuerst. */
function columnsFromHeader(row: SheetCell[]): ColumnMap {
  const cand: { field: ProgramField; col: number; score: number }[] = [];
  row.forEach((c, col) => {
    const text = cellText(c);
    if (!text) return;
    for (const field of PROGRAM_FIELDS) {
      const score = headerScore(text, field);
      if (score > 0) cand.push({ field, col, score });
    }
  });
  cand.sort((a, b) => b.score - a.score || a.col - b.col);
  const out: ColumnMap = {};
  const usedCols = new Set<number>();
  for (const c of cand) {
    if (out[c.field] !== undefined || usedCols.has(c.col)) continue;
    out[c.field] = c.col;
    usedCols.add(c.col);
  }
  return out;
}

/** Kopfzeile in den ersten Zeilen: die mit den meisten erkannten Feldern (mindestens Name und Fläche, oder zwei Felder). */
export function detectHeaderRow(rows: SheetCell[][]): number | null {
  let best: { row: number; n: number; hasCore: boolean } | null = null;
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const cols = columnsFromHeader(rows[r] ?? []);
    const n = Object.keys(cols).length;
    if (n < 2) continue;
    const hasCore = cols.name !== undefined && cols.area !== undefined;
    if (!best || (hasCore && !best.hasCore) || (hasCore === best.hasCore && n > best.n)) best = { row: r, n, hasCore };
  }
  return best ? best.row : null;
}

/** Spalten aus den Daten raten, wenn Überschriften fehlen: erste Textspalte = Name, Zahlenspalte mit Nachkommastellen/grössten Werten = Fläche, kleine ganze Zahlen = Anzahl. */
function columnsFromData(rows: SheetCell[][], from: number): ColumnMap {
  const sample = rows.slice(from, from + 60);
  const width = sample.reduce((m, r) => Math.max(m, r.length), 0);
  const stats = Array.from({ length: width }, (_, col) => {
    let text = 0, nums = 0, ints = 0, sum = 0;
    for (const r of sample) {
      const c = r[col];
      if (c === null || c === undefined || cellText(c) === "") continue;
      const n = cellNumber(c);
      if (n === null) text++;
      else {
        nums++;
        sum += n;
        if (Number.isInteger(n) && n >= 1 && n <= 50) ints++;
      }
    }
    return { col, text, nums, ints, mean: nums ? sum / nums : 0 };
  });
  const out: ColumnMap = {};
  const name = stats.find((s) => s.text > 0 && s.text >= s.nums);
  if (name) out.name = name.col;
  const numeric = stats.filter((s) => s.nums > s.text && s.nums > 0);
  const area = [...numeric].sort((a, b) => b.mean - a.mean)[0];
  if (area) out.area = area.col;
  const count = numeric.find((s) => s.col !== area?.col && s.ints === s.nums);
  if (count) out.count = count.col;
  return out;
}

/** Vorschlag: Kopfzeile erkennen und Spalten zuordnen; was die Überschriften offen lassen, ergänzen die Daten (Name, Fläche, Anzahl). */
export function suggestMapping(rows: SheetCell[][]): Mapping {
  const headerRow = detectHeaderRow(rows);
  const columns = headerRow !== null ? columnsFromHeader(rows[headerRow] ?? []) : {};
  const guessed = columnsFromData(rows, headerRow === null ? 0 : headerRow + 1);
  const taken = new Set(Object.values(columns));
  for (const f of ["name", "area", "count"] as const) {
    const col = guessed[f];
    if (columns[f] === undefined && col !== undefined && !taken.has(col) && (headerRow === null || f !== "count")) {
      columns[f] = col;
      taken.add(col);
    }
  }
  return { headerRow, columns };
}

// ── Zeilen abbilden ─────────────────────────────────────────────────────────

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

const SUM_WORDS = /^(σ|∑|total|totale?|summe|zwischensumme|gesamt|gesamtsumme|gesamtfläche|übertrag|sum|subtotal|grand total|somme|sous-total|totaux)\b/i;

const KIND_WORDS: [RegExp, SiaCategory][] = [
  [/^hnf\b|^hauptnutz/i, "HNF"],
  [/^nnf\b|^nebennutz/i, "NNF"],
  [/^vf\b|^verkehrsfl/i, "VF"],
  [/^ff\b|^funktionsfl/i, "FF"],
  [/^kgf\b|^kf\b|^konstruktionsfl/i, "KGF"],
  [/^agf\b|^aussengeschoss|^außengeschoss/i, "AGF"],
];

/** Flächenart aus Text ("HNF", "HNF 1.1", "Hauptnutzfläche"); sonst `undefined`. */
export function parseKind(text: string): SiaCategory | undefined {
  const t = text.trim();
  for (const [re, cat] of KIND_WORDS) if (re.test(t)) return cat;
  return undefined;
}

export interface MapOptions {
  /** Summenzeilen überspringen (Default ja). */
  skipSums?: boolean;
}

/** Eine Tabelle mit Zuordnung in Programmzeilen übersetzen (Format-Modul für Zahlen muss geladen sein). */
export function mapRows(rows: SheetCell[][], mapping: Mapping, opts: MapOptions = {}): ImportLine[] {
  const { columns } = mapping;
  const skipSums = opts.skipSums ?? true;
  const start = mapping.headerRow === null ? 0 : mapping.headerRow + 1;
  const out: ImportLine[] = [];
  if (mapping.headerRow !== null) out.push({ sheetRow: mapping.headerRow, skip: "header" });
  const get = (r: SheetCell[], f: ProgramField): SheetCell => (columns[f] === undefined ? null : (r[columns[f]!] ?? null));
  let heading = "";
  let runningSum = 0; // Summe der Flächen seit der letzten Summenzeile
  for (let i = start; i < rows.length; i++) {
    const r = rows[i] ?? [];
    if (r.every((c) => cellText(c) === "")) {
      out.push({ sheetRow: i, skip: "empty" });
      continue;
    }
    const name = cellText(get(r, "name"));
    const area = cellNumber(get(r, "area"));
    const countRaw = cellNumber(get(r, "count"));
    // Summenzeile: Stichwort in Name oder (bei leerem Namen) irgendeiner Textzelle; oder ohne Namen und gleich der laufenden Summe.
    const anyText = r.map((c) => (typeof c === "string" ? c.trim() : "")).filter(Boolean);
    const keyword = SUM_WORDS.test(name) || (name === "" && anyText.some((t) => SUM_WORDS.test(t)));
    const matchesRunning = name === "" && area !== null && runningSum > 0 && Math.abs(area - runningSum) < 0.005 * Math.max(1, runningSum);
    if (skipSums && (keyword || matchesRunning)) {
      out.push({ sheetRow: i, skip: "sum" });
      runningSum = 0;
      continue;
    }
    if (name === "") {
      out.push({ sheetRow: i, skip: "noName" });
      continue;
    }
    if (area === null && countRaw === null && columns.group === undefined) {
      // Nur ein Name: Zwischentitel („Wohnen") → Gruppe der folgenden Zeilen.
      const others = r.filter((_, c) => c !== columns.name && cellText(r[c]) !== "");
      if (others.length === 0) {
        heading = name;
        out.push({ sheetRow: i, skip: "noArea", groupHeading: name });
        continue;
      }
    }
    if (area === null || area <= 0) {
      out.push({ sheetRow: i, skip: "noArea" });
      continue;
    }
    const row: RoomProgramRow = { name, area };
    const count = countRaw === null ? 1 : Math.round(countRaw);
    if (count > 1) row.count = count;
    const kindText = cellText(get(r, "kind"));
    let unknownKind: string | undefined;
    if (kindText) {
      const k = parseKind(kindText);
      if (k) row.siaCategory = k;
      else unknownKind = kindText;
    }
    const group = columns.group !== undefined ? cellText(get(r, "group")) : heading;
    if (group) row.group = group;
    const note = cellText(get(r, "note"));
    if (note) row.note = note;
    runningSum += area * Math.max(1, count);
    out.push({ sheetRow: i, row, ...(unknownKind ? { unknownKind } : {}) });
  }
  return out;
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
