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
  getComponent,
  getWallType,
  wallTypeLabel,
  wallTypeThickness,
} from "../model/types";
import type {
  AttributeSource,
  Ceiling,
  Column,
  ColumnProfile,
  ContextObject,
  Drawing2D,
  Drawing2DGeom,
  ExtrudedSolid,
  LayerCategory,
  Opening,
  Project,
  Roof,
  RoofShape,
  Room,
  SiaCategory,
  SliceTermination,
  Stair,
  StairShape,
  VerticalAnchor,
  Wall,
  WallReferenceLine,
} from "../model/types";
import { localToLv95 } from "../io/lv95";
import {
  resolveForeground,
  resolveBackground,
  resolveHatchId,
  resolveStrokeWeight,
} from "../plan/generatePlan/shared";
import { columnVerticalExtent } from "../model/wall";
import { columnFootprint } from "../geometry/column";
import { evaluateRoom, polygonArea } from "../geometry/roomArea";
import {
  ceilingVerticalExtent,
  nextFloorAbove,
  stairVerticalExtent,
  wallVerticalExtent,
} from "../model/wall";
import { ceilingArea, outlineBBox } from "../geometry/ceiling";
import { roofBBox, roofBaseElevation, roofGeometry } from "../geometry/roof";
import { openingGapQuad, openingVerticalExtent } from "../geometry/opening";
import { stairGeometry, stairBBox } from "../geometry/stair";

/** Eintrag für die WallType-Auswahl (Preset-Dropdown) im Object-Info-Panel. */
export interface WallTypeChoice {
  id: string;
  name: string;
  /** Kurz-Label für das Dropdown (aus wallTypeLabel: Kürzel+Dicke oder Name). */
  label: string;
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

/** Dach-Attribute fürs Objekt-Info-Panel (nur bei Auswahl genau eines Dachs). */
export interface RoofInfo {
  shape: RoofShape;
  /** Hauptneigung (Grad). */
  pitchDeg: number;
  /** Obere Neigung (Grad) — nur Mansarde relevant. */
  pitchUpperDeg?: number;
  /** Dachtyp-Verweis (mehrschichtiger Aufbau) oder undefined (einschichtig). */
  roofTypeId?: string;
  /** Mansarde-Untertyp (Giebel/Walm/Zelt) — nur Mansarde relevant. */
  mansardType?: "giebel" | "walm" | "zelt";
  /** Mansarde-Knicklage (0..0.5 der halben Spannweite) — nur Mansarde relevant. */
  mansardKneeRatio?: number;
  /** Dachüberstand an der Traufe (Meter). */
  overhang: number;
  /** Dachüberstand am Ortgang (Giebelseite, Meter); fehlt ⇒ = Traufüberstand. */
  overhangGable?: number;
  /** Firstrichtung entlang X oder Y. */
  ridgeAxis: "x" | "y";
  /** Dachdicke (Meter). */
  thickness: number;
  /** Traufhöhe (absolutes Z, Meter) — aufgelöst (Override ODER Geschoss-Oberkante). */
  baseElevation: number;
  /** Firsthöhe über der Traufe (Meter, abgeleitet). */
  ridgeHeight: number;
  /** Grundfläche des Umriss-Rechtecks (m², ohne Überstand). */
  footprintArea: number;
  /** Breite (X-Ausdehnung) des Umriss-Rechtecks (Meter). */
  width: number;
  /** Tiefe (Y-Ausdehnung) des Umriss-Rechtecks (Meter). */
  depth: number;
  /** Untere/linke Ecke der Bounding-Box (fix beim Breite/Tiefe-Resize). */
  minX: number;
  minY: number;
}

/**
 * Eine wählbare Schichttrennlinie (Fuge zwischen zwei Schichten) als
 * Referenzlinie einer mehrschichtigen Wand. `offset` ist der fertige
 * Achsversatz entlang +n (Meter), `label` benennt die angrenzenden Schichten.
 */
export interface LayerBoundaryChoice {
  offset: number;
  label: string;
}

/**
 * Wand-spezifische Attribute für das Object-Info-Panel (nur bei Auswahl einer
 * einzelnen Wand gesetzt). Effektiv aufgelöste, anzeigefertige Werte plus die
 * Listen, die die Dropdowns brauchen.
 */
export interface WallInfo {
  referenceLine: WallReferenceLine;
  /** Freier Achsversatz (Schichttrennlinie), falls gesetzt — sonst undefined. */
  referenceOffset?: number;
  /**
   * Interne Schichttrennlinien der Wand als wählbare Referenz (leer bei
   * einschichtigen Wänden). Aussen-/Innenfläche stecken bereits in
   * left/right — hier stehen nur die FUGEN dazwischen.
   */
  layerBoundaries: LayerBoundaryChoice[];
  /** Terminierungs-Regel am Deckenanschluss (Default "both" = heutiges Verhalten). */
  sliceTermination: SliceTermination;
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
  /** Achslänge der Wand (Meter). */
  length: number;
  /** Bruttovolumen = Länge × Dicke × Höhe (m³, ohne Öffnungsabzug). */
  grossVolume: number;
  /** Summe der Öffnungsvolumina (Fenster/Türen) dieser Wand (m³). */
  openingVolume: number;
  /** Nettovolumen = Brutto − Öffnungen (m³, ≥ 0). */
  netVolume: number;
}

/**
 * Decken-spezifische Attribute für das Object-Info-Panel (nur bei Auswahl genau
 * einer Decke gesetzt). Anzeigefertige Werte + Listen für die Dropdowns.
 */
export interface CeilingInfo {
  /** Effektiv aktiver Aufbau-Typ: `ceilingTypeId`, sonst LEGACY-`wallTypeId`. */
  typeId: string;
  /** Aktuelle Gesamtdicke (Meter). */
  thickness: number;
  /** Ob der aktuelle Aufbau-Typ einschichtig ist (1 Schicht). */
  singleLayer: boolean;
  /** Grundfläche der Decke (m²). */
  area: number;
  /** Volumen = Fläche × Dicke (m³). */
  volume: number;
  /** Verfügbare Deckentyp-Presets (dediziert, `project.ceilingTypes`). */
  ceilingTypes: WallTypeChoice[];
  /** Geschoss, dem die Decke zugeordnet ist. */
  floorId: string;
  floorName: string;
  /** Alle Geschosse (für die OK-„an Geschoss gebunden"-Auswahl). */
  floors: FloorChoice[];
  /** OK-Bindung (undefined = Geschoss-Oberkante). */
  top?: VerticalAnchor;
  /** UK-Bindung (undefined = OK − Dicke). */
  bottom?: VerticalAnchor;
  /** Aufgelöste absolute UK/OK (Meter). */
  zBottom: number;
  zTop: number;
  /** Aussparungen (Treppenauge/Schacht) als BBox-Masse, Reihenfolge = Modell. */
  openings: { width: number; depth: number }[];
}

/**
 * Öffnungs-spezifische Attribute für das Object-Info-Panel (nur bei Auswahl
 * genau einer Öffnung gesetzt). Anzeigefertige Werte + Wirts-Wand-Bezug.
 */
export interface OpeningInfo {
  /** ID der Öffnung (für den ⚙-Sprung in den Fenster-/Tür-Editor). */
  id: string;
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
  /** Nur Fenster: Anzahl der Flügel (1–4). Fehlt → 1 (Default). */
  wingCount?: number;
  /** Nur Tür: Tür-Typ (normal / Wandöffnung). Fehlt → "normal". */
  doorType?: "normal" | "wandoeffnung";
  /** Nur Tür: Sturzlinien (keine/innen/aussen/beide). Fehlt → "beide". */
  lintelLines?: "keine" | "innen" | "aussen" | "beide";
  /** Zugewiesener Tür-/Fenstertyp (Bibliothek, `Opening.typeId`) oder undefined. */
  typeId?: string;
  /** Aufgelöste absolute UK/OK (Meter). */
  zBottom: number;
  zTop: number;
  /** Nur Fenster: Grundriss-Linien-Übersteuerungen je Kategorie. */
  frameLine?: { color?: string; weight?: number };
  frameViewLine?: { color?: string; weight?: number };
  sashLine?: { color?: string; weight?: number };
  sillLineStyle?: { color?: string; weight?: number };
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
  /** Pfeil-Darstellung (offener Winkel- vs. gefüllter Vollpfeil). Fehlt → "line". */
  arrowStyle?: "line" | "filled";
  /** Referenzpunkt der Laufbreite (links/mitte/rechts). Fehlt → "mitte". */
  referenz?: "links" | "mitte" | "rechts";
  /** Zugewiesener Treppentyp (Bibliothek, `Stair.typeId`) oder undefined. */
  typeId?: string;
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

/**
 * Extrusions-spezifische Attribute für das Object-Info-Panel (nur bei Auswahl
 * genau eines extrudierten Körpers, truck-Integration, gesetzt).
 */
export interface ExtrudedSolidInfo {
  /** Extrusionshöhe in Metern (editierbar). */
  height: number;
  /** Verjüngung 0 (Prisma) … 1 (Spitze), editierbar. */
  taper: number;
  /** Grundfläche des Profils (m²). */
  area: number;
  /** Geschoss, dessen `baseElevation` die UK des Körpers bestimmt. */
  floorId: string;
  floorName: string;
}

/**
 * Stützen-spezifische Attribute für das Object-Info-Panel (nur bei Auswahl genau
 * einer Stütze gesetzt). Anzeigefertige Werte für die Panel-Felder.
 */
export interface ColumnInfo {
  /** Profil (Rechteck/Kreis) — bestimmt, welche Masse editierbar sind. */
  profile: ColumnProfile;
  /** Höhe (Meter, editierbar). */
  height: number;
  /** Drehung (Grad, editierbar) — intern in Radiant gespeichert. */
  rotationDeg: number;
  /** Geschoss, dem die Stütze zugeordnet ist. */
  floorId: string;
  floorName: string;
  /** Aufgelöste absolute UK/OK (Meter). */
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
  kind:
    | "wall"
    | "ceiling"
    | "opening"
    | "stair"
    | "room"
    | "drawing2d"
    | "door"
    | "extrudedSolid"
    | "column"
    | "roof"
    | "contextObject"
    | "layoutAnnotation";
  id: string;
  /**
   * Konkrete Art der Layout-Annotation (nur `kind === "layoutAnnotation"`) —
   * steuert z. B., ob die Strichstärke editierbar ist (Linie/Rechteck ja,
   * Text/Bild nein).
   */
  annotKind?: "line" | "rect" | "text" | "image";
  /** Grafik-Kategorie (Ebene) des Elements. */
  categoryCode: string;
  /**
   * Zeichnungsebene (Geschoss) des Elements — editierbar im Objektinfo-Kopf
   * (VW: „Ebene"). Bei Öffnungen `undefined` (die Ebene kommt aus der
   * Wirts-Wand, ein Verschieben auf eine andere Ebene ergäbe keinen Sinn).
   */
  floorId?: string;
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
  /**
   * Vordergrund-Override (Muster-/Schraffurfarbe) des Elements; `undefined` =
   * „Nach System" (erbt vom Bauteil/System). Gesetzt bei Wand, Decke und
   * geschlossener Drawing2D.
   */
  foreground?: string;
  /**
   * Hintergrund-Override (Füllfarbe/Poché) des Elements; `undefined` = „Nach
   * System". Nachfolger von `fillColor`; hat im Plan Vorrang.
   */
  background?: string;
  /**
   * Quelle des Vordergrunds, wenn `foreground` NICHT gesetzt ist ("layer" =
   * Nach Ebene, "object"/`undefined` = Nach Bauteil, Default). Gesetzt bei
   * Wand, Decke und geschlossener Drawing2D (wie `foreground`/`pocheEditable`).
   */
  foregroundSource?: AttributeSource;
  /** Quelle des Hintergrunds, analog zu {@link Selection.foregroundSource}. */
  backgroundSource?: AttributeSource;
  /**
   * RAW Strichstärke-Override (mm) DIESES Elements; `undefined` = kein Override
   * (Herkunft dann `strokeWeightSource`). Gesetzt bei Wand, Decke, Drawing2D.
   * `weightMm` bleibt der EFFEKTIVE (aufgelöste) Wert für die Anzeige.
   */
  strokeWeightOverride?: number;
  /** Quelle der Strichstärke, wenn kein `strokeWeightOverride` gesetzt ist. */
  strokeWeightSource?: AttributeSource;
  /** Quelle der Schraffur, wenn kein `fillHatchId` gesetzt ist. */
  hatchSource?: AttributeSource;
  /**
   * EFFEKTIV aufgelöster Vordergrund (Override ?? Ebene ?? Bauteil, s.
   * `resolveForeground` — dieselbe Kette wie beim Rendern), für die IMMER
   * sichtbare Vorschau im Attribut-Panel (Nutzer-Wunsch: „man sollte immer
   * sehen welche Farbe [gilt]"), unabhängig von der aktuellen Quelle.
   * `undefined` = kein Wert an keiner Stelle der Kette (echtes „Nach System").
   */
  effectiveForeground?: string;
  /** Effektiv aufgelöster Hintergrund, analog zu {@link Selection.effectiveForeground}. */
  effectiveBackground?: string;
  /** Effektiv aufgelöste Schraffur-ID, analog zu {@link Selection.effectiveForeground}. */
  effectiveHatchId?: string | null;
  /** Ob die Form geschlossen ist (rect/circle/closed polyline) — nur Drawing2D. */
  closed?: boolean;
  /**
   * Ob das Element ein Bild ist (Drawing2D `{shape:"image"}` ODER Layout-
   * Annotation `kind:"image"`) — steuert die Deckkraft-Zeile im Attribute-Panel.
   */
  isImage?: boolean;
  /** Deckkraft (0..1) — nur wenn `isImage`. */
  opacity?: number;
  /** Achsparallele Bounding-Box in Modell-Metern. */
  bbox: SelectionBBox;
  /**
   * Wand-Attribute (nur bei `kind === "wall"`). Trägt Referenzlinie, Aufbau-Typ
   * (Wandtyp/Dicke), Referenzgeschoss + UK/OK für den Wand-Abschnitt im Panel.
   */
  wall?: WallInfo;
  /** Decken-Attribute (nur bei `kind === "ceiling"`). */
  ceiling?: CeilingInfo;
  /** Dach-Attribute (nur bei `kind === "roof"`). */
  roof?: RoofInfo;
  /** Öffnungs-Attribute (nur bei `kind === "opening"`). */
  opening?: OpeningInfo;
  /** Treppen-Attribute (nur bei `kind === "stair"`). */
  stair?: StairInfo;
  /** Raum-Attribute (nur bei `kind === "room"`). */
  room?: RoomInfo;
  /** Extrusions-Attribute (nur bei `kind === "extrudedSolid"`). */
  extrudedSolid?: ExtrudedSolidInfo;
  /** Stützen-Attribute (nur bei `kind === "column"`). */
  column?: ColumnInfo;
  /** Kontext-Objekt-Attribute (nur bei `kind === "contextObject"`). */
  contextObject?: ContextObjectInfo;
}

/**
 * Kontext-Objekt-spezifische Attribute (importiertes Mesh/Terrain/Konturen-
 * Satz) für das Object-Info-Panel — v. a. zum Prüfen, OB/WOHIN georeferenziert
 * importiert wurde (Nutzer-Wunsch: reale Koordinaten direkt sichtbar).
 */
export interface ContextObjectInfo {
  objType: ContextObject["type"];
  /** Reale LV95-Koordinate des Bbox-Mittelpunkts, falls `Project.geoAnchor`
   *  gesetzt ist (sonst `undefined` — kein Bezug bekannt). */
  lv95Center?: { e: number; n: number };
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
    g.shape === "ellipse" ||
    (g.shape === "polyline" && g.closed) ||
    (g.shape === "spline" && g.closed)
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
    case "image":
      acc(g.min.x, g.min.y);
      acc(g.max.x, g.max.y);
      break;
    case "circle":
    case "arc":
      acc(g.center.x - g.r, g.center.y - g.r);
      acc(g.center.x + g.r, g.center.y + g.r);
      break;
    case "ellipse": {
      // Präzise Bounding-Box unter Berücksichtigung der Drehung (rotation=0
      // beim heutigen Werkzeug, Feld existiert für spätere Quellen).
      const c = Math.cos(g.rotation), s = Math.sin(g.rotation);
      const hw = Math.hypot(g.rx * c, g.ry * s);
      const hh = Math.hypot(g.rx * s, g.ry * c);
      acc(g.center.x - hw, g.center.y - hh);
      acc(g.center.x + hw, g.center.y + hh);
      break;
    }
    case "bezier":
    case "spline":
      for (const p of g.pts) acc(p.x, p.y);
      break;
    case "dimension": {
      for (const p of g.pts) acc(p.x, p.y);
      if (g.pts.length >= 2) {
        const a = g.pts[0], b = g.pts[g.pts.length - 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * g.offset, ny = (dx / len) * g.offset;
        for (const p of g.pts) acc(p.x + nx, p.y + ny);
      }
      break;
    }
    case "kote":
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
  // Effektive Strichstärke: expliziter Override zuerst, sonst die Kategorie
  // (die Quelle "layer"/"object" macht heute keinen Unterschied, da Component
  // keine eigene Strichstärke trägt — siehe resolveStrokeWeight).
  const weightMm = wall.strokeWeight ?? cat?.lw ?? WALL_FALLBACK_MM;
  const minX = Math.min(wall.start.x, wall.end.x);
  const minY = Math.min(wall.start.y, wall.end.y);
  const maxX = Math.max(wall.start.x, wall.end.x);
  const maxY = Math.max(wall.start.y, wall.end.y);
  // Wand-Attribute auflösen (Referenzlinie, Aufbau, Referenzgeschoss, UK/OK).
  const wt = getWallType(project, wall);
  const thickness = wallTypeThickness(wt);
  // Effektive Vordergrund-/Hintergrund-/Schraffur-Vorschau fürs Attribut-Panel
  // (Nutzer-Wunsch: immer den TATSÄCHLICHEN Wert sehen, nicht nur ein leeres
  // Override-Feld) — dieselbe Resolve-Kette wie beim Rendern (resolveForeground
  // & Co.), als Bauteil-Repräsentant die ÄUSSERSTE Schicht (wie `abbrevOf`
  // unten). Bei mehrschichtigem Aufbau nur eine Annäherung (jede Schicht kann
  // im Schnitt ihre EIGENE Bauteilfarbe zeigen) — für die Panel-Vorschau
  // ausreichend, der Override selbst wirkt ohnehin einheitlich auf alle Schichten.
  const outerComponent = getComponent(project, wt.layers[0]?.componentId);
  const effectiveForeground = outerComponent
    ? resolveForeground(outerComponent, wall.foreground, cat, wall.foregroundSource)
    : wall.foreground;
  const effectiveBackground = outerComponent
    ? resolveBackground(outerComponent, wall.background, cat, wall.backgroundSource)
    : wall.background;
  const effectiveHatchId = resolveHatchId(
    wall.hatchId,
    wall.hatchSource,
    cat,
    outerComponent?.hatchId,
  );
  const floor = project.drawingLevels.find((z) => z.id === wall.floorId);
  const { zBottom, zTop } = wallVerticalExtent(project, wall);
  const above = nextFloorAbove(project, wall);
  // Volumen aus Achslänge × Gesamtdicke × Höhe, abzüglich der Öffnungen (jede
  // Öffnung durchbricht die volle Wanddicke: Breite × Höhe × Dicke).
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const wallHeight = Math.max(0, zTop - zBottom);
  const grossVolume = length * thickness * wallHeight;
  const openingVolume = (project.openings ?? [])
    .filter((o) => o.hostWallId === wall.id)
    .reduce((sum, o) => sum + o.width * o.height * thickness, 0);
  const netVolume = Math.max(0, grossVolume - openingVolume);
  // Interne Schichttrennlinien als wählbare Referenz: von aussen (Schicht 0)
  // nach innen aufsummiert; der Achsversatz +n = halbe Dicke − Fugenlage.
  const half = thickness / 2;
  const layerBoundaries: WallInfo["layerBoundaries"] = [];
  let cum = 0;
  const abbrevOf = (componentId: string): string => {
    const c = getComponent(project, componentId);
    return c ? c.abbrev ?? c.name : "?";
  };
  for (let i = 0; i < wt.layers.length - 1; i++) {
    cum += wt.layers[i].thickness;
    layerBoundaries.push({
      offset: half - cum,
      label: `${abbrevOf(wt.layers[i].componentId)}|${abbrevOf(wt.layers[i + 1].componentId)}`,
    });
  }
  const wallInfo: WallInfo = {
    referenceLine: wall.referenceLine ?? "center",
    referenceOffset: wall.referenceOffset,
    layerBoundaries,
    sliceTermination: wall.sliceTermination ?? "both",
    wallTypeId: wall.wallTypeId,
    thickness,
    singleLayer: wt.layers.length <= 1,
    wallTypes: project.wallTypes.map((t) => ({
      id: t.id,
      name: t.name,
      label: wallTypeLabel(t, project.components),
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
    length,
    grossVolume,
    openingVolume,
    netVolume,
  };
  // bbox aus der Wandachse (start/end); die Schichtdicke bleibt unberücksichtigt,
  // damit die Box der Achs-Geometrie folgt (genügt für die Paletten).
  return {
    kind: "wall",
    id: wall.id,
    categoryCode: wall.categoryCode,
    floorId: wall.floorId,
    color,
    weightMm,
    fillHatchId: wall.hatchId,
    fillColor: undefined,
    foreground: wall.foreground,
    background: wall.background,
    foregroundSource: wall.foregroundSource,
    backgroundSource: wall.backgroundSource,
    effectiveForeground,
    effectiveBackground,
    effectiveHatchId,
    strokeWeightOverride: wall.strokeWeight,
    strokeWeightSource: wall.strokeWeightSource,
    hatchSource: wall.hatchSource,
    closed: undefined,
    bbox: { minX, minY, maxX, maxY },
    wall: wallInfo,
  };
}

/** Selektion für eine Decke ableiten (Farbe übersteuerbar, Strichstärke = Kategorie). */
function ceilingSelection(project: Project, ceiling: Ceiling): Selection {
  const cat = findCategory(project.layers, ceiling.categoryCode);
  const color = ceiling.color ?? cat?.color ?? WALL_FALLBACK_COLOR;
  const weightMm = ceiling.strokeWeight ?? cat?.lw ?? WALL_FALLBACK_MM;
  const box = outlineBBox(ceiling.outline);
  const wt = getCeilingType(project, ceiling);
  const thickness = ceilingThickness(project, ceiling);
  // Effektive Vordergrund-/Hintergrund-/Schraffur-Vorschau — s. Kommentar in
  // wallSelection (dieselbe Kette, äusserste Schicht als Bauteil-Repräsentant).
  const outerComponent = getComponent(project, wt.layers[0]?.componentId);
  const effectiveForeground = outerComponent
    ? resolveForeground(outerComponent, ceiling.foreground, cat, ceiling.foregroundSource)
    : ceiling.foreground;
  const effectiveBackground = outerComponent
    ? resolveBackground(outerComponent, ceiling.background, cat, ceiling.backgroundSource)
    : ceiling.background;
  const effectiveHatchId = resolveHatchId(
    ceiling.hatchId,
    ceiling.hatchSource,
    cat,
    outerComponent?.hatchId,
  );
  const floor = project.drawingLevels.find((z) => z.id === ceiling.floorId);
  const { zBottom, zTop } = ceilingVerticalExtent(project, ceiling);
  const ceilingInfo: CeilingInfo = {
    typeId: ceiling.ceilingTypeId ?? ceiling.wallTypeId,
    thickness,
    singleLayer: wt.layers.length <= 1,
    area: ceilingArea(ceiling.outline),
    volume: ceilingArea(ceiling.outline) * thickness,
    ceilingTypes: (project.ceilingTypes ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      label: wallTypeLabel(t, project.components),
      thickness: wallTypeThickness(t),
      layerCount: t.layers.length,
    })),
    floorId: ceiling.floorId,
    floorName: floor?.name ?? ceiling.floorId,
    floors: project.drawingLevels
      .filter((z) => z.kind === "floor")
      .map((z) => ({ id: z.id, name: z.name })),
    top: ceiling.top,
    bottom: ceiling.bottom,
    zBottom,
    zTop,
    // Aussparungen als anzeigefertige BBox-Masse (Breite × Tiefe je Loch).
    openings: (ceiling.openings ?? []).map((hole) => {
      const bb = outlineBBox(hole);
      return { width: bb.maxX - bb.minX, depth: bb.maxY - bb.minY };
    }),
  };
  return {
    kind: "ceiling",
    id: ceiling.id,
    categoryCode: ceiling.categoryCode,
    floorId: ceiling.floorId,
    color,
    weightMm,
    fillHatchId: ceiling.hatchId,
    fillColor: undefined,
    foreground: ceiling.foreground,
    background: ceiling.background,
    foregroundSource: ceiling.foregroundSource,
    backgroundSource: ceiling.backgroundSource,
    effectiveForeground,
    effectiveBackground,
    effectiveHatchId,
    strokeWeightOverride: ceiling.strokeWeight,
    strokeWeightSource: ceiling.strokeWeightSource,
    hatchSource: ceiling.hatchSource,
    closed: true,
    bbox: { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY },
    ceiling: ceilingInfo,
  };
}

/** Selektion für ein Dach ableiten (Farbe übersteuerbar, Strichstärke = Kategorie). */
function roofSelection(project: Project, roof: Roof): Selection {
  const cat = findCategory(project.layers, roof.categoryCode);
  const color = roof.color ?? cat?.color ?? WALL_FALLBACK_COLOR;
  const weightMm = cat?.lw ?? WALL_FALLBACK_MM;
  const bb = roofBBox(roof.outline);
  const eavesZ = roofBaseElevation(project, roof);
  const g = roofGeometry(roof, eavesZ);
  const footprintArea = Math.abs(bb.x1 - bb.x0) * Math.abs(bb.y1 - bb.y0);
  const roofInfo: RoofInfo = {
    shape: roof.shape,
    pitchDeg: roof.pitchDeg,
    pitchUpperDeg: roof.pitchUpperDeg,
    roofTypeId: roof.roofTypeId,
    mansardType: roof.mansardType,
    mansardKneeRatio: roof.mansardKneeRatio,
    overhang: roof.overhang,
    overhangGable: roof.overhangGable,
    ridgeAxis: roof.ridgeAxis,
    thickness: roof.thickness,
    baseElevation: eavesZ,
    ridgeHeight: g.ridgeHeight,
    footprintArea,
    width: Math.abs(bb.x1 - bb.x0),
    depth: Math.abs(bb.y1 - bb.y0),
    minX: bb.x0,
    minY: bb.y0,
  };
  return {
    kind: "roof",
    id: roof.id,
    categoryCode: roof.categoryCode,
    floorId: roof.floorId,
    color,
    weightMm,
    closed: true,
    bbox: { minX: bb.x0, minY: bb.y0, maxX: bb.x1, maxY: bb.y1 },
    roof: roofInfo,
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
    id: o.id,
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
    wingCount: o.wingCount,
    doorType: o.doorType,
    lintelLines: o.lintelLines,
    typeId: o.typeId,
    zBottom: ext.zBottom,
    zTop: ext.zTop,
    frameLine: o.frameLine,
    frameViewLine: o.frameViewLine,
    sashLine: o.sashLine,
    sillLineStyle: o.sillLineStyle,
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
    arrowStyle: s.arrowStyle,
    referenz: s.referenz,
    typeId: s.typeId,
    floorId: s.floorId,
    floorName: floor?.name ?? s.floorId,
    zBottom,
    zTop,
  };
  return {
    kind: "stair",
    id: s.id,
    categoryCode: s.categoryCode,
    floorId: s.floorId,
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
    floorId: r.floorId,
    color,
    weightMm,
    fillHatchId: undefined,
    fillColor: undefined,
    closed: true,
    bbox: { minX, minY, maxX, maxY },
    room: roomInfo,
  };
}

/** Auswahl-Farbe der Extrusions-Footprints (identisch zum Grundriss-Umriss/3D-Orange). */
const EXTRUSION_COLOR = "#d98c40";

/** Selektion für einen extrudierten Körper ableiten (truck-Integration). */
function extrudedSolidSelection(project: Project, s: ExtrudedSolid): Selection {
  const floor = project.drawingLevels.find((z) => z.id === s.levelId);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of s.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) minX = minY = maxX = maxY = 0;
  const info: ExtrudedSolidInfo = {
    height: s.height,
    taper: s.taper ?? 0,
    area: polygonArea(s.points),
    floorId: s.levelId,
    floorName: floor?.name ?? s.levelId,
  };
  return {
    kind: "extrudedSolid",
    id: s.id,
    categoryCode: "",
    floorId: s.levelId,
    color: EXTRUSION_COLOR,
    weightMm: WALL_FALLBACK_MM,
    fillHatchId: null,
    fillColor: null,
    closed: true,
    bbox: { minX, minY, maxX, maxY },
    extrudedSolid: info,
  };
}

/** Umriss-/Auswahlfarbe der Stützen-Poché (neutrales Tragwerks-Grau). */
const COLUMN_COLOR = "#3a3f47";

/** Selektion für eine Stütze (Column) ableiten. */
function columnSelection(project: Project, col: Column): Selection {
  const floor = project.drawingLevels.find((z) => z.id === col.floorId);
  const category = findCategory(project.layers, col.categoryCode);
  const pts = columnFootprint(col);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) minX = minY = maxX = maxY = 0;
  const { zBottom, zTop } = columnVerticalExtent(project, col);
  const info: ColumnInfo = {
    profile: col.profile,
    height: col.height,
    rotationDeg: ((col.rotation ?? 0) * 180) / Math.PI,
    floorId: col.floorId,
    floorName: floor?.name ?? col.floorId,
    zBottom,
    zTop,
  };
  // Effektive Vordergrund-/Hintergrund-/Schraffur-/Strichstärke-Vorschau — s.
  // Kommentar in wallSelection (dieselbe Kette, das zugewiesene Bauteil als
  // Repräsentant statt der äussersten Schicht, da Column nur EIN componentId
  // trägt statt eines geschichteten Aufbaus).
  // `getComponent` wirft bei unbekannter ID (z. B. gelöschtes Bauteil) — die
  // Panel-Vorschau soll dabei nicht abstürzen (analog dem try/catch in
  // structures.ts addColumnPoche), einfach auf "kein Bauteil" zurückfallen.
  const comp = col.componentId
    ? project.components.find((c) => c.id === col.componentId)
    : undefined;
  const effectiveForeground = comp
    ? resolveForeground(comp, col.foreground, category, col.foregroundSource)
    : col.foreground;
  const effectiveBackground = comp
    ? resolveBackground(comp, col.background, category, col.backgroundSource)
    : col.background;
  const effectiveHatchId = resolveHatchId(col.hatchId, col.hatchSource, category, comp?.hatchId);
  const weightMm = resolveStrokeWeight(col.strokeWeight, col.strokeWeightSource, category, WALL_FALLBACK_MM);
  return {
    kind: "column",
    id: col.id,
    categoryCode: col.categoryCode,
    floorId: col.floorId,
    color: col.color ?? category?.color ?? COLUMN_COLOR,
    weightMm,
    fillHatchId: col.hatchId,
    foreground: col.foreground,
    background: col.background,
    foregroundSource: col.foregroundSource,
    backgroundSource: col.backgroundSource,
    effectiveForeground,
    effectiveBackground,
    effectiveHatchId,
    strokeWeightOverride: col.strokeWeight,
    strokeWeightSource: col.strokeWeightSource,
    hatchSource: col.hatchSource,
    bbox: { minX, minY, maxX, maxY },
    column: info,
  };
}

/**
 * Selektion für ein Kontext-Objekt (importiertes Mesh/Terrain/Konturen-Satz)
 * ableiten. Bbox aus den rohen x/y-Koordinaten (Meshes: flaches [x,y,z…]-
 * Array, nur x/y je Vertex; Konturen: `pts` je Kontur) — die Höhe (z) bleibt
 * unberücksichtigt (2D-Bbox wie bei allen anderen Elementarten). `lv95Center`
 * nur, wenn `project.geoAnchor` gesetzt ist (sonst kein Rückrechnungs-Bezug).
 */
function contextObjectSelection(project: Project, obj: ContextObject): Selection {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const consider = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  if (obj.type === "contourSet") {
    for (const c of obj.contours) for (const p of c.pts) consider(p.x, p.y);
  } else if (obj.type === "image") {
    consider(obj.min.x, obj.min.y);
    consider(obj.max.x, obj.max.y);
  } else {
    const pos = obj.positions;
    for (let i = 0; i + 2 < pos.length; i += 3) consider(pos[i], pos[i + 1]);
  }
  if (!isFinite(minX)) minX = minY = maxX = maxY = 0;
  const anchor = project.geoAnchor;
  const lv95Center = anchor
    ? localToLv95(
        (minX + maxX) / 2,
        (minY + maxY) / 2,
        { e: anchor.lv95.e - anchor.model.x, n: anchor.lv95.n - anchor.model.y },
      )
    : undefined;
  return {
    kind: "contextObject",
    id: obj.id,
    categoryCode: "",
    color: "#888888",
    weightMm: WALL_FALLBACK_MM,
    bbox: { minX, minY, maxX, maxY },
    contextObject: { objType: obj.type, lv95Center },
  };
}

/** Selektion für ein 2D-Zeichenelement ableiten (gleiche Auflösung wie generatePlan). */
function drawingSelection(project: Project, d: Drawing2D): Selection {
  const ls = d.lineStyleId
    ? project.lineStyles.find((l) => l.id === d.lineStyleId)
    : undefined;
  const cat = findCategory(project.layers, d.categoryCode);
  const color = d.color ?? ls?.color ?? cat?.color ?? DRAW_FALLBACK_COLOR;
  // Effektive Strichstärke, dieselbe Kette wie generatePlan/addDrawing2D
  // (resolveStrokeWeight): Override zuerst, Source ≠ "object" (also "layer"
  // ODER fehlend, s. AttributeSource-Default) erzwingt die Kategorie (umgeht
  // das LineStyle-Gewicht), sonst die LineStyle-/Kategorie-Kette.
  const weightMm =
    d.weightMm ??
    (d.strokeWeightSource !== "object" ? cat?.lw : undefined) ??
    ls?.weight ??
    cat?.lw ??
    WALL_FALLBACK_MM;
  const closed = isClosedGeom(d.geom);
  // Effektive Vordergrund-/Hintergrund-/Schraffur-Vorschau — s. Kommentar in
  // wallSelection. Ein Drawing2D hat KEIN eigenes Bauteil (daher auch keine
  // „Nach Bauteil"-Option im Panel, s. AttributesPanel.tsx) — als Platzhalter
  // ein leeres Bauteil, dessen foreground/background/hatchId immer fehlen,
  // sodass die Kette bei einem (aus Alt-Daten) expliziten `source:"object"`
  // korrekt auf „kein Wert" statt einer erfundenen Bauteilfarbe fällt. Anders
  // als bei Wand/Decke (Default „Nach Bauteil") gilt bei Drawing2D „Nach
  // Ebene" als Default — daher hier explizit `?? "layer"` VOR dem Resolver
  // (der selbst weiterhin generisch „Nach Bauteil" als Default kennt).
  const noComponent = { id: "", name: "", color, hatchId: "", joinPriority: 0 };
  const effectiveForeground = closed
    ? resolveForeground(noComponent, d.foreground, cat, d.foregroundSource ?? "layer")
    : undefined;
  const effectiveBackground = closed
    ? resolveBackground(noComponent, d.background, cat, d.backgroundSource ?? "layer")
    : undefined;
  const effectiveHatchId = closed
    ? resolveHatchId(d.hatchId, d.hatchSource ?? "layer", cat, undefined)
    : null;
  return {
    kind: "drawing2d",
    id: d.id,
    categoryCode: d.categoryCode,
    floorId: d.levelId,
    color,
    weightMm,
    fillHatchId: closed ? d.hatchId ?? null : null,
    fillColor: closed ? d.fillColor ?? null : null,
    foreground: closed ? d.foreground : undefined,
    background: closed ? d.background : undefined,
    foregroundSource: closed ? d.foregroundSource : undefined,
    backgroundSource: closed ? d.backgroundSource : undefined,
    effectiveForeground,
    effectiveBackground,
    effectiveHatchId,
    strokeWeightOverride: d.weightMm,
    strokeWeightSource: d.strokeWeightSource,
    hatchSource: closed ? d.hatchSource : undefined,
    closed,
    isImage: d.geom.shape === "image",
    opacity: d.geom.shape === "image" ? d.geom.opacity ?? 1 : undefined,
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
  selectedExtrudedSolidId: string | null = null,
  selectedColumnId: string | null = null,
  selectedRoofId: string | null = null,
  selectedContextObjectId: string | null = null,
): Selection | null {
  if (selectedContextObjectId) {
    const o = (project.context ?? []).find((x) => x.id === selectedContextObjectId);
    if (o) return contextObjectSelection(project, o);
  }
  if (selectedDrawingId) {
    const d = project.drawings2d.find((x) => x.id === selectedDrawingId);
    return d ? drawingSelection(project, d) : null;
  }
  if (selectedExtrudedSolidId) {
    const s = (project.extrudedSolids ?? []).find((x) => x.id === selectedExtrudedSolidId);
    return s ? extrudedSolidSelection(project, s) : null;
  }
  if (selectedColumnId) {
    const c = (project.columns ?? []).find((x) => x.id === selectedColumnId);
    return c ? columnSelection(project, c) : null;
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
  if (selectedRoofId) {
    const r = (project.roofs ?? []).find((x) => x.id === selectedRoofId);
    return r ? roofSelection(project, r) : null;
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
