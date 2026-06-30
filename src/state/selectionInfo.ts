// Selektions-Attribut-Kontrakt: leitet aus der aktuellen Auswahl
// (selectedWallIds/selectedDrawingId) + dem Projekt ein normalisiertes,
// darstellungsfertiges Attribut-Objekt für das ERSTE selektierte Element ab.
// Die kommenden Paletten (Attributes, Object-Info) lesen ausschließlich diesen
// Kontrakt — sie kennen weder das Modell noch die Auflösungs-Logik.
//
// „Effektiv aufgelöst" = dieselbe Reihenfolge wie generatePlan: explizite
// Übersteuerung am Element → LineStyle → Kategorie-Default. So zeigt die Palette
// den TATSÄCHLICH gezeichneten Wert, nicht nur das (oft leere) Override-Feld.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { flattenCategories, getWallType, wallTypeThickness } from "../model/types";
import type {
  Drawing2D,
  Drawing2DGeom,
  LayerCategory,
  Project,
  VerticalAnchor,
  Wall,
  WallReferenceLine,
} from "../model/types";
import { nextFloorAbove, wallVerticalExtent } from "../model/wall";

/** Eintrag für die WallType-Auswahl (Preset-Dropdown) im Object-Info-Panel. */
export interface WallTypeChoice {
  id: string;
  name: string;
  /** Gesamtdicke (Meter) — informativ im Dropdown-Label. */
  thickness: number;
  /** Anzahl Schichten (1 = einschichtig). */
  layerCount: number;
}

/** Eintrag für die Geschoss-Auswahl (Referenzgeschoss / OK-Bindung). */
export interface FloorChoice {
  id: string;
  name: string;
}

/**
 * Wand-spezifische Attribute für das Object-Info-Panel (nur bei Auswahl einer
 * einzelnen Wand gesetzt). Effektiv aufgelöste, anzeigefertige Werte plus die
 * Listen, die die Dropdowns brauchen.
 */
export interface WallInfo {
  referenceLine: WallReferenceLine;
  wallTypeId: string;
  /** Aktuelle Gesamtdicke (Meter). */
  thickness: number;
  /** Ob der aktuelle Wandtyp einschichtig ist (1 Schicht). */
  singleLayer: boolean;
  /** Verfügbare Wandtyp-Presets (für den Mehrschicht-Aufbau). */
  wallTypes: WallTypeChoice[];
  /** Geschoss, dem die Wand zugeordnet ist (Referenzgeschoss). */
  floorId: string;
  floorName: string;
  /** Alle Geschosse (für UK/OK-„an Geschoss gebunden"-Auswahl). */
  floors: FloorChoice[];
  /** Geschoss direkt darüber (für „Verknüpfung zum oberen Geschoss"). */
  floorAbove?: FloorChoice;
  /** UK-Bindung (undefined = Geschoss-Default). */
  bottom?: VerticalAnchor;
  /** OK-Bindung (undefined = UK + height). */
  top?: VerticalAnchor;
  /** Aufgelöste absolute UK/OK (Meter) + abgeleitete Höhe. */
  zBottom: number;
  zTop: number;
}

/** Achsparallele Bounding-Box eines Elements in Modell-Metern. */
export interface SelectionBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Normalisierte Sicht auf das erste selektierte Element. Farbe/Strichstärke sind
 * EFFEKTIV aufgelöst (Override sonst Default), damit die Palette den real
 * gezeichneten Wert zeigt. `fillHatchId`/`closed` sind nur für Drawing2D sinnvoll.
 */
export interface Selection {
  kind: "wall" | "drawing2d" | "door";
  id: string;
  /** Grafik-Kategorie (Ebene) des Elements. */
  categoryCode: string;
  /** Effektiv aufgelöste Strich-/Umrandungsfarbe (hex). */
  color: string;
  /** Effektiv aufgelöste Strichstärke in Millimetern. */
  weightMm: number;
  /**
   * Schraffur-ID der Füllung (nur Drawing2D, geschlossene Form); `null` = keine.
   * Bei Wänden/Türen `undefined` (Konzept nicht anwendbar).
   */
  fillHatchId?: string | null;
  /**
   * Vollton-Füllfarbe der Füllung (nur Drawing2D, geschlossene Form); `null` =
   * keine (transparent). Bei Wänden/Türen `undefined` (nicht anwendbar).
   */
  fillColor?: string | null;
  /** Ob die Form geschlossen ist (rect/circle/closed polyline) — nur Drawing2D. */
  closed?: boolean;
  /** Achsparallele Bounding-Box in Modell-Metern. */
  bbox: SelectionBBox;
  /**
   * Wand-Attribute (nur bei `kind === "wall"`). Trägt Referenzlinie, Aufbau-Typ
   * (Wandtyp/Dicke), Referenzgeschoss + UK/OK für den Wand-Abschnitt im Panel.
   */
  wall?: WallInfo;
}

const WALL_FALLBACK_MM = 0.18;
const DRAW_FALLBACK_COLOR = "#d0d0d0";
const WALL_FALLBACK_COLOR = "#2b3039";

/** Kategorie (per Code) im Baum suchen — flach, da Codes baumweit eindeutig sind. */
function findCategory(
  layers: LayerCategory[],
  code: string,
): LayerCategory | undefined {
  return flattenCategories(layers).find((c) => c.code === code);
}

/** Ob eine 2D-Form geschlossen ist (Füllung/Schraffur sinnvoll). */
function isClosedGeom(g: Drawing2DGeom): boolean {
  return (
    g.shape === "rect" ||
    g.shape === "circle" ||
    (g.shape === "polyline" && g.closed)
  );
}

/** Bounding-Box einer 2D-Form. */
function geomBBox(g: Drawing2DGeom): SelectionBBox {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const acc = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  switch (g.shape) {
    case "line":
      acc(g.a.x, g.a.y);
      acc(g.b.x, g.b.y);
      break;
    case "polyline":
      for (const p of g.pts) acc(p.x, p.y);
      break;
    case "rect":
      acc(g.min.x, g.min.y);
      acc(g.max.x, g.max.y);
      break;
    case "circle":
    case "arc":
      acc(g.center.x - g.r, g.center.y - g.r);
      acc(g.center.x + g.r, g.center.y + g.r);
      break;
    case "text":
      acc(g.at.x, g.at.y);
      break;
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Selektion für eine Wand ableiten (Farbe übersteuerbar, Strichstärke = Kategorie). */
function wallSelection(project: Project, wall: Wall): Selection {
  const cat = findCategory(project.layers, wall.categoryCode);
  const color = wall.color ?? cat?.color ?? WALL_FALLBACK_COLOR;
  const weightMm = cat?.lw ?? WALL_FALLBACK_MM;
  const minX = Math.min(wall.start.x, wall.end.x);
  const minY = Math.min(wall.start.y, wall.end.y);
  const maxX = Math.max(wall.start.x, wall.end.x);
  const maxY = Math.max(wall.start.y, wall.end.y);
  // Wand-Attribute auflösen (Referenzlinie, Aufbau, Referenzgeschoss, UK/OK).
  const wt = getWallType(project, wall);
  const thickness = wallTypeThickness(wt);
  const floor = project.drawingLevels.find((z) => z.id === wall.floorId);
  const { zBottom, zTop } = wallVerticalExtent(project, wall);
  const above = nextFloorAbove(project, wall);
  const wallInfo: WallInfo = {
    referenceLine: wall.referenceLine ?? "center",
    wallTypeId: wall.wallTypeId,
    thickness,
    singleLayer: wt.layers.length <= 1,
    wallTypes: project.wallTypes.map((t) => ({
      id: t.id,
      name: t.name,
      thickness: wallTypeThickness(t),
      layerCount: t.layers.length,
    })),
    floorId: wall.floorId,
    floorName: floor?.name ?? wall.floorId,
    floors: project.drawingLevels
      .filter((z) => z.kind === "floor")
      .map((z) => ({ id: z.id, name: z.name })),
    floorAbove: above,
    bottom: wall.bottom,
    top: wall.top,
    zBottom,
    zTop,
  };
  // bbox aus der Wandachse (start/end); die Schichtdicke bleibt unberücksichtigt,
  // damit die Box der Achs-Geometrie folgt (genügt für die Paletten).
  return {
    kind: "wall",
    id: wall.id,
    categoryCode: wall.categoryCode,
    color,
    weightMm,
    fillHatchId: undefined,
    fillColor: undefined,
    closed: undefined,
    bbox: { minX, minY, maxX, maxY },
    wall: wallInfo,
  };
}

/** Selektion für ein 2D-Zeichenelement ableiten (gleiche Auflösung wie generatePlan). */
function drawingSelection(project: Project, d: Drawing2D): Selection {
  const ls = d.lineStyleId
    ? project.lineStyles.find((l) => l.id === d.lineStyleId)
    : undefined;
  const cat = findCategory(project.layers, d.categoryCode);
  const color = d.color ?? ls?.color ?? cat?.color ?? DRAW_FALLBACK_COLOR;
  const weightMm = d.weightMm ?? ls?.weight ?? cat?.lw ?? WALL_FALLBACK_MM;
  const closed = isClosedGeom(d.geom);
  return {
    kind: "drawing2d",
    id: d.id,
    categoryCode: d.categoryCode,
    color,
    weightMm,
    fillHatchId: closed ? d.hatchId ?? null : null,
    fillColor: closed ? d.fillColor ?? null : null,
    closed,
    bbox: geomBBox(d.geom),
  };
}

/**
 * Leitet den Selektions-Kontrakt für das ERSTE selektierte Element ab.
 * Drawing-Auswahl und Wand-Auswahl schließen sich aus; bei Drawing-Auswahl
 * hat diese Vorrang. Liefert `null`, wenn nichts (oder kein auffindbares
 * Element) selektiert ist.
 */
export function deriveSelection(
  project: Project,
  selectedWallIds: string[],
  selectedDrawingId: string | null,
): Selection | null {
  if (selectedDrawingId) {
    const d = project.drawings2d.find((x) => x.id === selectedDrawingId);
    return d ? drawingSelection(project, d) : null;
  }
  const wallId = selectedWallIds[0];
  if (wallId) {
    const w = project.walls.find((x) => x.id === wallId);
    return w ? wallSelection(project, w) : null;
  }
  return null;
}
