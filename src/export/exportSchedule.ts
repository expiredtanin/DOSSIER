// Bauteil-Schedule (Bauteilliste) — CSV-Export einer Bauteilaufstellung des
// Projekts (AUDIT A6, DOSSIER-Parität). Reiner Rechen-/Serialisierungskern:
// keine UI, kein Datei-IO — nur Modell → CSV-String (unit-testbar). Der
// Download (Blob + Anchor) passiert im App-Layer, analog zum Raum-CSV
// (geometry/roomArea → roomsToCsv) und zum Projekt-JSON-Speichern.
//
// Granularität: EINE Zeile je Bauteil-VORKOMMEN (Wand, Decke, Tür, Fenster/
// Öffnung, Treppe, Extrusion). Räume sind bewusst NICHT enthalten — die haben
// ihren eigenen CSV-Export (geometry/roomArea → roomsToCsv), keine Duplikation.
// Optional folgt darunter ein Aggregat-Block je Bauteil-Typ.
// Bezeichner englisch, Labels/Kommentare deutsch (CONVENTIONS.md). Einheit: METER.

import type {
  Project,
  Wall,
  Ceiling,
  Opening,
  Stair,
  ExtrudedSolid,
  Roof,
  Column,
} from "../model/types";
import {
  getWallType,
  getCeilingType,
  wallTypeThickness,
  ceilingThickness,
} from "../model/types";
import { polygonArea } from "../geometry/roomArea";

// ── CSV-Primitive (RFC 4180, gespiegelt vom Raum-CSV) ───────────────────────

/** Ein Feld CSV-sicher quoten: „..." bei , " \n \r ; → " wird verdoppelt. */
function csvField(value: string): string {
  if (/[",\n\r;]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Zahl auf 2 Nachkommastellen, Punkt als Dezimaltrenner. Leer bei null. */
function fmtNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return (Math.round(value * 100) / 100).toFixed(2);
}

// ── Kennwert-Ableitung (aus dem Modell, keine erfundenen Felder) ────────────

/** Achslänge einer Wand (Meter) = Abstand Start→End der Centerline. */
function wallLength(wall: Wall): number {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
}

/** Anzeigename eines Geschosses (oder die roh-ID, wenn unbekannt). */
function floorNameOf(project: Project, floorId: string): string {
  return project.drawingLevels.find((z) => z.id === floorId)?.name ?? floorId;
}

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
   * Geschoss-ID (rohe DrawingLevel-Referenz, additiv für Konsumenten wie das
   * Elemente-Panel — NICHT Teil der CSV-Spalten, siehe exportScheduleCsv).
   * `undefined` bei verwaister/nicht auflösbarer Referenz (z. B. Tür/Öffnung
   * mit gelöschter Wirtswand).
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

/** Wertet eine Wand für die Bauteilliste aus (defensiv gegen fehlende Typen). */
function evalWall(project: Project, wall: Wall): ScheduleRow {
  let typeName = wall.wallTypeId;
  let thickness = 0;
  try {
    const wt = getWallType(project, wall);
    typeName = wt.name;
    thickness = wallTypeThickness(wt);
  } catch {
    /* verwaister Wandtyp — Roh-ID + Dicke 0 */
  }
  const length = wallLength(wall);
  return {
    kind: "Wand",
    id: wall.id,
    typeName,
    floor: floorNameOf(project, wall.floorId),
    floorId: wall.floorId,
    length,
    heightM: wall.height,
    thickness,
    area: length * wall.height,
  };
}

/** Wertet eine Decke für die Bauteilliste aus (defensiv gegen fehlende Typen). */
function evalCeiling(project: Project, ceiling: Ceiling): ScheduleRow {
  let typeName = ceiling.ceilingTypeId ?? ceiling.wallTypeId;
  try {
    typeName = getCeilingType(project, ceiling).name;
  } catch {
    /* verwaister Deckentyp — Roh-ID */
  }
  return {
    kind: "Decke",
    id: ceiling.id,
    typeName,
    floor: floorNameOf(project, ceiling.floorId),
    floorId: ceiling.floorId,
    length: null,
    heightM: null,
    thickness: ceilingThickness(project, ceiling),
    area: polygonArea(ceiling.outline),
  };
}

/** Geschoss eines wandgehosteten Elements (Tür/Öffnung) über die Wirtswand. */
function floorOfHostWall(project: Project, hostWallId: string): string {
  const wall = project.walls.find((w) => w.id === hostWallId);
  if (!wall) return hostWallId; // verwaiste Wirtswand — Roh-ID, analog verwaister Typreferenzen
  return floorNameOf(project, wall.floorId);
}

/** Rohe Geschoss-ID eines wandgehosteten Elements (Tür/Öffnung), oder `undefined` bei verwaister Wirtswand. */
function floorIdOfHostWall(project: Project, hostWallId: string): string | undefined {
  return project.walls.find((w) => w.id === hostWallId)?.floorId;
}

/** Wertet eine Öffnung (Fenster oder Tür-Öffnung) für die Bauteilliste aus. */
function evalOpening(project: Project, opening: Opening): ScheduleRow {
  const kind = opening.kind === "window" ? "Fenster" : "Tür";
  return {
    kind,
    id: opening.id,
    typeName: kind,
    floor: floorOfHostWall(project, opening.hostWallId),
    floorId: floorIdOfHostWall(project, opening.hostWallId),
    length: opening.width,
    heightM: opening.height,
    thickness: null,
    area: opening.width * opening.height,
  };
}

/**
 * Wertet eine Treppe für die Bauteilliste aus. Fläche bleibt bewusst leer —
 * eine echte Footprint-Fläche bräuchte stairGeometry() (geometry/stair.ts)
 * samt dessen Geschosshöhen-Fallback, den wir hier nicht koppeln wollen.
 */
function evalStair(project: Project, stair: Stair): ScheduleRow {
  return {
    kind: "Treppe",
    id: stair.id,
    typeName: "Treppe",
    floor: floorNameOf(project, stair.floorId),
    floorId: stair.floorId,
    length: stair.runLength + (stair.run2Length ?? 0),
    heightM: stair.totalRise ?? null,
    thickness: null,
    area: null,
  };
}

/** Wertet einen extrudierten Körper für die Bauteilliste aus. */
function evalExtrudedSolid(project: Project, solid: ExtrudedSolid): ScheduleRow {
  return {
    kind: "Extrusion",
    id: solid.id,
    typeName: "Extrusion",
    floor: floorNameOf(project, solid.levelId),
    floorId: solid.levelId,
    length: null,
    heightM: solid.height,
    thickness: null,
    area: polygonArea(solid.points),
  };
}

/** Wertet ein Dach für die Bauteilliste aus (defensiv gegen fehlenden Dachtyp). */
function evalRoof(project: Project, roof: Roof): ScheduleRow {
  let typeName = roof.roofTypeId ?? roof.shape;
  if (roof.roofTypeId) {
    const rt = (project.roofTypes ?? []).find((t) => t.id === roof.roofTypeId);
    if (rt) typeName = rt.name;
  }
  return {
    kind: "Dach",
    id: roof.id,
    typeName,
    floor: floorNameOf(project, roof.floorId),
    floorId: roof.floorId,
    length: null,
    heightM: null,
    thickness: roof.thickness,
    area: polygonArea(roof.outline),
  };
}

/** Wertet eine Stütze für die Bauteilliste aus (Querschnitt als „Dicke", Rechteck-Breite als „Länge"). */
function evalColumn(project: Project, column: Column): ScheduleRow {
  return {
    kind: "Stütze",
    id: column.id,
    typeName: column.profile.kind === "round" ? "Rund" : "Rechteck",
    floor: floorNameOf(project, column.floorId),
    floorId: column.floorId,
    length: column.profile.kind === "rect" ? column.profile.width : null,
    heightM: column.height,
    thickness:
      column.profile.kind === "rect" ? column.profile.depth : column.profile.radius * 2,
    area: null,
  };
}

/**
 * Wertet ALLE Bauteil-Vorkommen eines Projekts aus (Wände, Decken, Türen,
 * Fenster/Öffnungen, Treppen, Extrusionen, Dächer, Stützen — Räume bewusst
 * ausgenommen, siehe Dateikopf). Reine Ableitung aus dem Modell — nichts wird
 * gespeichert. Reihenfolge: Wände, Decken, Türen, Öffnungen, Treppen,
 * Extrusionen, Dächer, Stützen (je in Dokumentreihenfolge).
 */
export function scheduleRows(project: Project): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  for (const w of project.walls ?? []) rows.push(evalWall(project, w));
  for (const c of project.ceilings ?? []) rows.push(evalCeiling(project, c));
  for (const o of project.openings ?? []) rows.push(evalOpening(project, o));
  for (const s of project.stairs ?? []) rows.push(evalStair(project, s));
  for (const e of project.extrudedSolids ?? []) rows.push(evalExtrudedSolid(project, e));
  for (const r of project.roofs ?? []) rows.push(evalRoof(project, r));
  for (const c of project.columns ?? []) rows.push(evalColumn(project, c));
  return rows;
}

// ── Aggregat je Bauteil-Typ ─────────────────────────────────────────────────

interface TypeAggregate {
  kind: ScheduleKind;
  typeName: string;
  count: number;
  /** Summe der Längen (Meter) — Bauteile ohne Länge tragen 0 bei. */
  totalLength: number;
  /** Summe der Flächen (m²) — Bauteile ohne Fläche tragen 0 bei. */
  totalArea: number;
}

/** Rollt die Zeilen je (Klasse + Typname) zu Zwischensummen zusammen. */
function aggregateByType(rows: ScheduleRow[]): TypeAggregate[] {
  const map = new Map<string, TypeAggregate>();
  for (const r of rows) {
    const key = `${r.kind} ${r.typeName}`;
    let agg = map.get(key);
    if (!agg) {
      agg = { kind: r.kind, typeName: r.typeName, count: 0, totalLength: 0, totalArea: 0 };
      map.set(key, agg);
    }
    agg.count += 1;
    agg.totalLength += r.length ?? 0;
    agg.totalArea += r.area ?? 0;
  }
  return [...map.values()];
}

// ── CSV-Serialisierung ───────────────────────────────────────────────────────

export interface ScheduleCsvOptions {
  /** Feldtrenner. Default „;" (Excel-DE-freundlich, wie der Raum-CSV). */
  delimiter?: string;
  /** true (Default): Aggregat-Block je Bauteil-Typ unter die Liste anhängen. */
  includeSummary?: boolean;
}

/** Spaltenüberschriften der Bauteilliste (fix Deutsch, wie der Raum-CSV). */
const HEADER = [
  "Typ",
  "ID",
  "Bauteil",
  "Geschoss",
  "Länge [m]",
  "Höhe [m]",
  "Dicke [m]",
  "Fläche [m²]",
];

/**
 * Baut die Bauteilliste des Projekts als CSV-String (kein Datei-IO). Eine Zeile
 * je Bauteil-Vorkommen mit den aus dem Modell verlässlich ableitbaren
 * Kennwerten; optional ein Aggregat-Block je Bauteil-Typ.
 *
 * Leeres Projekt ⇒ nur die Kopfzeile (kein Crash).
 */
export function exportScheduleCsv(
  project: Project,
  options: ScheduleCsvOptions = {},
): string {
  const d = options.delimiter ?? ";";
  const includeSummary = options.includeSummary ?? true;
  const rows = scheduleRows(project);
  const lines: string[] = [];

  lines.push(HEADER.map(csvField).join(d));

  for (const r of rows) {
    lines.push(
      [
        csvField(r.kind),
        csvField(r.id),
        csvField(r.typeName),
        csvField(r.floor),
        fmtNum(r.length),
        fmtNum(r.heightM),
        fmtNum(r.thickness),
        fmtNum(r.area),
      ].join(d),
    );
  }

  if (includeSummary && rows.length > 0) {
    lines.push(""); // Leerzeile trennt Liste von Aggregat
    lines.push([csvField("Zusammenfassung (je Bauteil-Typ)"), "", "", "", "", "", "", ""].join(d));
    for (const agg of aggregateByType(rows)) {
      lines.push(
        [
          csvField(agg.kind),
          "",
          csvField(agg.typeName),
          csvField(`${agg.count} Stk`),
          agg.totalLength > 0 ? fmtNum(agg.totalLength) : "",
          "",
          "",
          agg.totalArea > 0 ? fmtNum(agg.totalArea) : "",
        ].join(d),
      );
    }
  }

  return lines.join("\r\n");
}
