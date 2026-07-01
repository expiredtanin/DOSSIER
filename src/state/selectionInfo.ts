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

import {
  ceilingThickness,
  flattenCategories,
  getCeilingType,
  getWallType,
  wallTypeThickness,
} from "../model/types";
import type {
  Ceiling,
  Drawing2D,
  Drawing2DGeom,
  LayerCategory,
  Opening,
  Project,
  Room,
  SiaCategory,
  Stair,
  StairShape,
  VerticalAnchor,
  Wall,
  WallReferenceLine,
} from "../model/types";
import { evaluateRoom } from "../geometry/roomArea";
import {
  ceilingVerticalExtent,
  nextFloorAbove,
  stairVerticalExtent,
  wallVerticalExtent,
} from "../model/wall";
import { ceilingArea, outlineBBox } from "../geometry/ceiling";
import { openingGapQuad, openingVerticalExtent } from "../geometry/opening";
import { stairGeometry, stairBBox } from "../geometry/stair";

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

/**
 * Decken-spezifische Attribute für das Object-Info-Panel (nur bei Auswahl genau
 * einer Decke gesetzt). Anzeigefertige Werte + Listen für die Dropdowns.
 */
export interface CeilingInfo {
  wallTypeId: string;
  /** Aktuelle Gesamtdicke (Meter). */
  thickness: number;
  /** Ob der aktuelle Aufbau-Typ einschichtig ist (1 Schicht). */
  singleLayer: boolean;
  /** Grundfläche der Decke (m²). */
  area: number;
  /** Verfügbare Aufbau-Typ-Presets (wie WallType). */
  wallTypes: WallTypeChoice[];
  /** Geschoss, dem die Decke zugeordnet ist. */
  floorId: string;
  floorName: string;
  /** Alle Geschosse (für die OK-„an Geschoss gebunden"-Auswahl). */
  floors: FloorChoice[];
  /** OK-Bindung (undefined = Geschoss-Oberkante). */
  top?: VerticalAnchor;
  /** Aufgelöste absolute UK/OK (Meter). */
  zBottom: number;
  zTop: number;
}

/**
 * Öffnungs-spezifische Attribute für das Object-Info-Panel (nur bei Auswahl
 * genau einer Öffnung gesetzt). Anzeigefertige Werte + Wirts-Wand-Bezug.
 */
export interface OpeningInfo {
  kind: "window" | "door";
  /** Wirts-Wand (ID + Name/Geschoss zur Anzeige). */
  hostWallId: string;
  hostWallName: string;
  /** Abstand vom Wand-Startpunkt (Meter). */
  position: number;
  width: number;
  height: number;
  /** Brüstungshöhe (Meter); 0 bei Türen. */
  sillHeight: number;
  /** Nur Tür: Anschlag/Aufschlag/Winkel/Richtung. */
  hinge?: "start" | "end";
  swing?: "left" | "right";
  swingAngle?: number;
  openingDir?: "in" | "out";
  /** Aufgelöste absolute UK/OK (Meter). */
  zBottom: number;
  zTop: number;
}

/**
 * Treppen-spezifische Attribute für das Object-Info-Panel (nur bei Auswahl genau
 * einer Treppe gesetzt). Anzeigefertige Werte + Listen für die Dropdowns.
 */
export interface StairInfo {
  shape: StairShape;
  /** Laufbreite (Meter). */
  width: number;
  /** Stufenanzahl (Setzstufen). */
  stepCount: number;
  /** Gesamt-Steighöhe (Meter, OKFF → OKFF). */
  totalRise: number;
  /** Abgeleitete Steigungshöhe (Meter) = totalRise / stepCount. */
  riserHeight: number;
  /** Abgeleitete Auftrittstiefe (Meter). */
  treadDepth: number;
  /** Laufrichtung aufwärts (Auf-/Abpfeil-Richtung). */
  up: boolean;
  /** Geschoss, dem die Treppe zugeordnet ist. */
  floorId: string;
  floorName: string;
  /** Aufgelöste absolute UK/OK (Meter). */
  zBottom: number;
  zTop: number;
}

/**
 * Raum-spezifische Attribute für das Object-Info-Panel (nur bei Auswahl genau
 * eines Raums gesetzt). Anzeigefertige Werte; Fläche/Umfang werden aus dem
 * Umriss abgeleitet (nie gespeichert).
 */
export interface RoomInfo {
  /** Raum-Name (editierbar). */
  name: string;
  /** SIA-416-Blatt-Kategorie (HNF/NNF/VF/FF/KGF). */
  siaCategory: SiaCategory;
  /** Netto-anrechenbare Fläche (m²). */
  area: number;
  /** Umfang des Umrisses (m). */
  perimeter: number;
  /** Geschoss, dem der Raum zugeordnet ist. */
  floorId: string;
  floorName: string;
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
  kind: "wall" | "ceiling" | "opening" | "stair" | "room" | "drawing2d" | "door";
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
  /** Decken-Attribute (nur bei `kind === "ceiling"`). */
  ceiling?: CeilingInfo;
  /** Öffnungs-Attribute (nur bei `kind === "opening"`). */
  opening?: OpeningInfo;
  /** Treppen-Attribute (nur bei `kind === "stair"`). */
  stair?: StairInfo;
  /** Raum-Attribute (nur bei `kind === "room"`). */
  room?: RoomInfo;
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

/** Selektion für eine Decke ableiten (Farbe übersteuerbar, Strichstärke = Kategorie). */
function ceilingSelection(project: Project, ceiling: Ceiling): Selection {
  const cat = findCategory(project.layers, ceiling.categoryCode);
  const color = ceiling.color ?? cat?.color ?? WALL_FALLBACK_COLOR;
  const weightMm = cat?.lw ?? WALL_FALLBACK_MM;
  const box = outlineBBox(ceiling.outline);
  const wt = getCeilingType(project, ceiling);
  const thickness = ceilingThickness(project, ceiling);
  const floor = project.drawingLevels.find((z) => z.id === ceiling.floorId);
  const { zBottom, zTop } = ceilingVerticalExtent(project, ceiling);
  const ceilingInfo: CeilingInfo = {
    wallTypeId: ceiling.wallTypeId,
    thickness,
    singleLayer: wt.layers.length <= 1,
    area: ceilingArea(ceiling.outline),
    wallTypes: project.wallTypes.map((t) => ({
      id: t.id,
      name: t.name,
      thickness: wallTypeThickness(t),
      layerCount: t.layers.length,
    })),
    floorId: ceiling.floorId,
    floorName: floor?.name ?? ceiling.floorId,
    floors: project.drawingLevels
      .filter((z) => z.kind === "floor")
      .map((z) => ({ id: z.id, name: z.name })),
    top: ceiling.top,
    zBottom,
    zTop,
  };
  return {
    kind: "ceiling",
    id: ceiling.id,
    categoryCode: ceiling.categoryCode,
    color,
    weightMm,
    fillHatchId: undefined,
    fillColor: undefined,
    closed: true,
    bbox: { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY },
    ceiling: ceilingInfo,
  };
}

/** Selektion für eine Öffnung ableiten (Farbe übersteuerbar, Strichstärke = Kategorie). */
function openingSelection(project: Project, o: Opening): Selection {
  const cat = findCategory(project.layers, o.categoryCode);
  const color = o.color ?? cat?.color ?? WALL_FALLBACK_COLOR;
  const weightMm = cat?.lw ?? WALL_FALLBACK_MM;
  const wall = project.walls.find((w) => w.id === o.hostWallId);
  const floor = wall
    ? project.drawingLevels.find((z) => z.id === wall.floorId)
    : undefined;
  // Bounding-Box aus dem Lücken-Quad (volle Wanddicke); Fallback: leere Box.
  const quad = wall ? openingGapQuad(project, wall, o) : null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of quad ?? []) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) {
    minX = minY = maxX = maxY = 0;
  }
  const ext = wall
    ? openingVerticalExtent(project, wall, o)
    : { zBottom: 0, zTop: o.height };
  const openingInfo: OpeningInfo = {
    kind: o.kind,
    hostWallId: o.hostWallId,
    hostWallName: floor ? `${floor.name}` : o.hostWallId,
    position: o.position,
    width: o.width,
    height: o.height,
    sillHeight: o.sillHeight,
    hinge: o.hinge,
    swing: o.swing,
    swingAngle: o.swingAngle,
    openingDir: o.openingDir,
    zBottom: ext.zBottom,
    zTop: ext.zTop,
  };
  return {
    kind: "opening",
    id: o.id,
    categoryCode: o.categoryCode,
    color,
    weightMm,
    fillHatchId: undefined,
    fillColor: undefined,
    closed: undefined,
    bbox: { minX, minY, maxX, maxY },
    opening: openingInfo,
  };
}

/** Selektion für eine Treppe ableiten (Farbe übersteuerbar, Strichstärke = Kategorie). */
function stairSelection(project: Project, s: Stair): Selection {
  const cat = findCategory(project.layers, s.categoryCode);
  const color = s.color ?? cat?.color ?? WALL_FALLBACK_COLOR;
  const weightMm = cat?.lw ?? WALL_FALLBACK_MM;
  const { zBottom, zTop } = stairVerticalExtent(project, s);
  const totalRise = zTop - zBottom;
  const geo = stairGeometry(s, totalRise);
  const box = stairBBox(geo);
  const floor = project.drawingLevels.find((z) => z.id === s.floorId);
  const stairInfo: StairInfo = {
    shape: s.shape,
    width: s.width,
    stepCount: s.stepCount,
    totalRise,
    riserHeight: geo.riserHeight,
    treadDepth: geo.treadDepth,
    up: s.up !== false,
    floorId: s.floorId,
    floorName: floor?.name ?? s.floorId,
    zBottom,
    zTop,
  };
  return {
    kind: "stair",
    id: s.id,
    categoryCode: s.categoryCode,
    color,
    weightMm,
    fillHatchId: undefined,
    fillColor: undefined,
    closed: undefined,
    bbox: { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY },
    stair: stairInfo,
  };
}

/** Selektion für einen Raum ableiten (Fläche/Umfang aus dem Umriss abgeleitet). */
function roomSelection(project: Project, r: Room): Selection {
  const cat = findCategory(project.layers, r.categoryCode);
  const color = r.color ?? cat?.color ?? WALL_FALLBACK_COLOR;
  const weightMm = cat?.lw ?? WALL_FALLBACK_MM;
  const res = evaluateRoom(r.boundary, r.siaCategory);
  const floor = project.drawingLevels.find((z) => z.id === r.floorId);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of r.boundary) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) minX = minY = maxX = maxY = 0;
  const roomInfo: RoomInfo = {
    name: r.name,
    siaCategory: r.siaCategory,
    area: res.netArea,
    perimeter: res.perimeter,
    floorId: r.floorId,
    floorName: floor?.name ?? r.floorId,
  };
  return {
    kind: "room",
    id: r.id,
    categoryCode: r.categoryCode,
    color,
    weightMm,
    fillHatchId: undefined,
    fillColor: undefined,
    closed: true,
    bbox: { minX, minY, maxX, maxY },
    room: roomInfo,
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
  selectedCeilingId: string | null = null,
  selectedOpeningId: string | null = null,
  selectedStairId: string | null = null,
  selectedRoomId: string | null = null,
): Selection | null {
  if (selectedDrawingId) {
    const d = project.drawings2d.find((x) => x.id === selectedDrawingId);
    return d ? drawingSelection(project, d) : null;
  }
  if (selectedOpeningId) {
    const o = (project.openings ?? []).find((x) => x.id === selectedOpeningId);
    if (o) return openingSelection(project, o);
  }
  const wallId = selectedWallIds[0];
  if (wallId) {
    const w = project.walls.find((x) => x.id === wallId);
    return w ? wallSelection(project, w) : null;
  }
  if (selectedCeilingId) {
    const c = (project.ceilings ?? []).find((x) => x.id === selectedCeilingId);
    return c ? ceilingSelection(project, c) : null;
  }
  if (selectedStairId) {
    const s = (project.stairs ?? []).find((x) => x.id === selectedStairId);
    return s ? stairSelection(project, s) : null;
  }
  if (selectedRoomId) {
    const r = (project.rooms ?? []).find((x) => x.id === selectedRoomId);
    return r ? roomSelection(project, r) : null;
  }
  return null;
}
