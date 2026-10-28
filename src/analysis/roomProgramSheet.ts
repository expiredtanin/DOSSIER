// „Räume generieren" ([61]): das Raumprogramm als neues Blatt (Zeichnungsebene „Raumprogramm").
//
// Entscheid Raum oder Zeichnung: Die Rechtecke sind freie 2D-Zeichnungen (Rechteck + Text) auf einer
// eigenen Ebene der Art "drawing", KEINE `Room`s. Echte Räume gehören einem Geschoss (`floorId`), zählen
// in Flächenbilanz, Flächentabelle, Kennzahlen und IFC — die Soll-Rechtecke würden das Ist verfälschen
// (und `checkRoomProgram` würde sie dem Programm als „vorhanden" zuordnen). Als Zeichnung lassen sie sich
// trotzdem verschieben, kopieren und als Vorlage über die eigenen Räume legen.
//
// Die Anordnung (Packing) rechnet der Kern (`room_program.rs`); hier entstehen nur die Modellobjekte.
// Der Aufruf gehört in EIN `setProject` (ein Undo-Schritt).

import type { Drawing2D, DrawingLevel, Project } from "../model/types";
import { t } from "../i18n";
import { layoutRoomProgram } from "./roomProgram";
import type { LayoutGroup, LayoutItem, RoomProgramLayout } from "./roomProgram";

/** Füllfarben der Gruppen (hell, Text darauf dunkel); weiter reihum. */
const GROUP_COLORS = ["#dbe8f5", "#f7e3c8", "#dcefd6", "#f3d9e4", "#e6e0f3", "#f5f0c4", "#d2eeee", "#efdcd2"];

/** Farbe der Gruppe `index`. */
export function groupColor(index: number): string {
  return GROUP_COLORS[((index % GROUP_COLORS.length) + GROUP_COLORS.length) % GROUP_COLORS.length]!;
}

export interface SheetLabels {
  /** Name des neuen Blatts (Grundname; ist er vergeben, hängt eine Nummer an). */
  levelName: string;
  /** Beschriftung eines Raums unter dem Namen, z. B. „28.5 m²". */
  area: (area: number) => string;
  /** Titel einer Gruppe, z. B. „Wohnen · 120.0 m²". */
  groupTitle: (name: string, area: number) => string;
}

const areaText = (a: number): string => a.toLocaleString("de-CH", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Beschriftungen in der Oberflächensprache. */
export function defaultSheetLabels(): SheetLabels {
  return {
    levelName: t("program.generate.levelName"),
    area: (a) => `${areaText(a)} m²`,
    groupTitle: (name, a) => t("program.generate.groupTitle", { name, area: areaText(a) }),
  };
}

export interface ProgramSheet {
  level: DrawingLevel;
  drawings: Drawing2D[];
  layout: RoomProgramLayout;
}

const INK = "#222222";
const OUTLINE = "#555555";
const TEXT_CATEGORY = "50";
const SHAPE_CATEGORY = "60";

function uniqueLevelName(project: Project, base: string): string {
  const names = new Set(project.drawingLevels.map((l) => l.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Höhe der Beschriftung (m) für ein Rechteck der Tiefe `d`. */
function labelHeight(d: number): number {
  return Math.min(0.5, Math.max(0.22, d * 0.13));
}

function roomDrawings(it: LayoutItem, color: string, level: string, id: string, labels: SheetLabels): Drawing2D[] {
  const h = labelHeight(it.d);
  const pad = Math.min(0.25, it.w * 0.05);
  const rect: Drawing2D = {
    id: `${id}-r`,
    type: "drawing2d",
    levelId: level,
    categoryCode: SHAPE_CATEGORY,
    geom: { shape: "rect", min: { x: it.x, y: it.y }, max: { x: it.x + it.w, y: it.y + it.d } },
    background: color,
    color: OUTLINE,
  };
  const name: Drawing2D = {
    id: `${id}-n`,
    type: "drawing2d",
    levelId: level,
    categoryCode: TEXT_CATEGORY,
    color: INK,
    geom: { shape: "text", at: { x: it.x + pad, y: it.y + it.d - pad - h }, text: it.name, height: h, angle: 0, width: Math.max(0.5, it.w - 2 * pad), marks: { bold: true, color: INK } },
  };
  const area: Drawing2D = {
    id: `${id}-a`,
    type: "drawing2d",
    levelId: level,
    categoryCode: TEXT_CATEGORY,
    color: INK,
    geom: { shape: "text", at: { x: it.x + pad, y: it.y + pad }, text: labels.area(it.area), height: h * 0.9, angle: 0, marks: { color: INK } },
  };
  return [rect, name, area];
}

function titleDrawing(g: LayoutGroup, level: string, id: string, labels: SheetLabels): Drawing2D {
  return {
    id,
    type: "drawing2d",
    levelId: level,
    categoryCode: TEXT_CATEGORY,
    color: INK,
    geom: { shape: "text", at: { x: g.x, y: g.y + g.titleHeight * 0.25 }, text: labels.groupTitle(g.name, g.area), height: g.titleHeight * 0.4, angle: 0, marks: { bold: true, color: INK } },
  };
}

/**
 * Ebene und Zeichnungen für das Raumprogramm des Projekts. Leer (`drawings.length === 0`), wenn das Programm
 * keine Zeile mit Namen und Fläche hat. `stamp` macht die Ids eindeutig.
 */
export function buildProgramSheet(project: Project, labels: SheetLabels, stamp: string = String(Date.now())): ProgramSheet {
  const layout = layoutRoomProgram(project, { gap: 1, titleHeight: 1.6 });
  const level: DrawingLevel = { id: `drawing-rp-${stamp}`, name: uniqueLevelName(project, labels.levelName), kind: "drawing", visible: true, locked: false };
  const drawings: Drawing2D[] = [];
  layout.groups.forEach((g) => {
    if (g.name) drawings.push(titleDrawing(g, level.id, `rp-${stamp}-g${g.index}`, labels));
  });
  layout.items.forEach((it, i) => {
    drawings.push(...roomDrawings(it, groupColor(it.groupIndex), level.id, `rp-${stamp}-${i}`, labels));
  });
  return { level, drawings, layout };
}

/** Fügt das Blatt dem Projekt hinzu (für `setProject`); ohne Räume unverändert. */
export function addProgramSheet(project: Project, sheet: ProgramSheet): Project {
  if (sheet.drawings.length === 0) return project;
  return { ...project, drawingLevels: [...project.drawingLevels, sheet.level], drawings2d: [...project.drawings2d, ...sheet.drawings] };
}
