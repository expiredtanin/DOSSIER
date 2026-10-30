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
// [K4] S3: gerechnet wird im Rust-Kern (`src-tauri/core/src/selection_info.rs`, Wurzel-Abfrage
// `selectionInfo` auf dem Projekt-Dokument); hier stehen der Kontrakt (Typen) und die Fassade. Der
// B-Rep-Körper einer Extrusion (`spec`) kommt aus TS (`extrudedSolidSpec`, truck-Pipeline).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { extrudedSolidSpec } from "../core";
import type { SolidSpec } from "../engine/truckSolid";
import { documentFor } from "../core/document";
import type {
  AttributeSource,
  DimRef,
  ColumnProfile,
  ContextImage,
  ContextObject,
  Project,
  RoofShape,
  SiaCategory,
  SliceTermination,
  StairShape,
  VerticalAnchor,
  WallReferenceLine,
} from "../model/types";
import type { DetailLevel } from "../model/viewTypes";
import type { RoofEdge } from "../core";

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
  halfHipRatio?: number;
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
  /** Kanten (Umriss, dann Höfe) mit Neigungsvorgabe ([26], `roofEdgeList`). */
  edges: RoofEdge[];
  /** Gauben ([G5]) des Dachs, wie gespeichert. */
  dormers?: import("../model/types").Dormer[];
  /** Innenhöfe: Fläche (m²) und Punktzahl je Hof, in der Reihenfolge von `Roof.holes`. */
  holes: { area: number; points: number }[];
  /** Ob `edgePitchDeg` gesetzt ist. */
  hasEdgePitch: boolean;
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
  /** Per-Element-Übersteuerung der Detailstufe; fehlt → Ansichts-Detailstufe gilt. */
  detailLevel?: DetailLevel;
  /** Aufgelöste absolute UK/OK (Meter). */
  zBottom: number;
  zTop: number;
  /** Nur Fenster: Grundriss-Linien-Übersteuerungen je Kategorie. */
  frameLine?: { color?: string; weight?: number };
  frameViewLine?: { color?: string; weight?: number };
  sashLine?: { color?: string; weight?: number };
  sillLineStyle?: { color?: string; weight?: number };
  /** Dach-/Deckenfenster ([103]): Wirt und Lage (dann ohne Wirts-Wand). */
  hostRoofId?: string;
  hostCeilingId?: string;
  hostPoint?: { x: number; y: number };
  hostAngle?: number;
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
  /** Nur Wendel: Radius der Mittelsäule (Meter); fehlt → keine Säule. */
  centerColumn?: number;
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
  /** Eckenradius der Aussenkontur (m), editierbar (0 = scharf). */
  cornerRadius: number;
  /** Fase an den Ecken der Aussenkontur (m), editierbar (0 = scharf). */
  chamfer: number;
  /** B-Rep-Körper (Grundkörper): Ecken-/Verjüngungsfelder entfallen. */
  brepLabel?: string;
  /** Grundfläche des Profils (m²). */
  area: number;
  /** Abzugskörper (Aussparung/Durchbruch). */
  subtract: boolean;
  /** Abzugskörper möglich (senkrechtes Prisma ohne B-Rep/Verjüngung). */
  canSubtract: boolean;
  /** Abstand der UK über der Geschoss-UK (m). */
  baseOffset: number;
  /** B-Rep-Beschreibung (Weltkoordinaten) für Kennwerte — `null`, wenn truck keine hat. */
  spec: SolidSpec | null;
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
    | "contextObject";
  id: string;
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
  /**
   * Stift-Kopplung der Farbe oben (ArchiCAD-Stiftsatz-Muster, s.
   * `model/penSets.ts`): gesetzt, wenn DIESES Element (nicht Bauteil/Ebene)
   * seine eigene Farbe an einen Stift gekoppelt hat. `color` bleibt auch dann
   * die aufgelöste (gebackene) Farbe — die Kopplung ist nur fürs Panel-UI
   * relevant (Dropdown „Frei"/Stiftname). Gesetzt bei Wand/Decke/Dach/
   * Öffnung/Treppe/Raum/Stütze/Drawing2D; bei den übrigen `kind`s (Tür,
   * Extrusion, Kontext-Objekt, Layout-Annotation) `undefined`.
   */
  colorPenId?: string;
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
   * Stift-Kopplung von `foreground`, analog {@link Selection.colorPenId} —
   * gesetzt bei Wand, Decke, Stütze und Drawing2D (dieselben `kind`s wie
   * `foreground` selbst).
   */
  foregroundPenId?: string;
  /**
   * Hintergrund-Override (Füllfarbe/Poché) des Elements; `undefined` = „Nach
   * System". Nachfolger von `fillColor`; hat im Plan Vorrang.
   */
  background?: string;
  /** Stift-Kopplung von `background`, analog {@link Selection.foregroundPenId}. */
  backgroundPenId?: string;
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
   * Ob das Element ein Bild ist (Drawing2D `{shape:"image"}`, Layout-
   * Annotation `kind:"image"` ODER Kontext-Objekt `type:"image"`) — steuert
   * die Deckkraft-Zeile im Attribute-Panel.
   */
  isImage?: boolean;
  /** Deckkraft (0..1) — nur wenn `isImage`. */
  opacity?: number;
  /**
   * Bildkorrektur (Sättigung/Helligkeit/Kontrast/Graustufen) — NUR bei
   * Kontext-Objekt-Bildern gesetzt (`ContextImage.filters`, s. dort); Drawing2D-
   * und Layout-Bilder haben (noch) keine Korrektur.
   */
  imageFilters?: ContextImage["filters"];
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
  /**
   * Detail-/Schnitt-Verweis-Attribute (nur bei `kind === "drawing2d"` mit
   * `geom.shape === "detailref"`).
   */
  detailRef?: DetailRefInfo;
  /**
   * Assoziative Bemassung ([38]): Bezug je Punkt der Kette (`null` = freier Punkt), nur bei
   * `geom.shape === "dimension"` mit Bezügen.
   */
  dimRefs?: (DimRef | null)[];
}

/**
 * Detail-/Schnitt-Verweis-Attribute (Drawing2D `{shape:"detailref"}`) fürs
 * Object-Info-/Attribute-Panel: Bezeichner + Blattverknüpfung (samt der
 * verfügbaren Blätter für das Auswahl-Dropdown).
 */
export interface DetailRefInfo {
  label: string;
  sheetLayoutId?: string;
  sheetLabel?: string;
  availableLayouts: { id: string; name: string }[];
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

/** Meldungen, mit denen die Objekt-Info wie bisher abbricht (unbekannter Typ/Bauteil). */
const THROWN = /^Unbekannte[rs]? /;

/**
 * Leitet den Selektions-Kontrakt für das ERSTE selektierte Element ab.
 * Drawing-Auswahl und Wand-Auswahl schließen sich aus; bei Drawing-Auswahl
 * hat diese Vorrang. Liefert `null`, wenn nichts (oder kein auffindbares
 * Element) selektiert ist. Ein unbekannter Wand-/Deckentyp oder ein fehlendes
 * Bauteil wirft wie bisher; ein Element, das das Kern-Modell nicht lesen kann,
 * ergibt `null` (mit Warnung).
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
  const args = {
    wallIds: selectedWallIds,
    drawingId: selectedDrawingId,
    ceilingId: selectedCeilingId,
    openingId: selectedOpeningId,
    stairId: selectedStairId,
    roomId: selectedRoomId,
    extrudedSolidId: selectedExtrudedSolidId,
    columnId: selectedColumnId,
    roofId: selectedRoofId,
    contextObjectId: selectedContextObjectId,
  };
  // Das Element sucht der Kern über den Positions-Index des Dokuments (keine lineare Suche).
  let sel: Selection | null;
  try {
    sel = documentFor(project).queryRootMarked<Selection | null>("selectionInfo", JSON.stringify(args));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (THROWN.test(msg)) throw new Error(msg);
    console.warn("Objekt-Info:", msg);
    return null;
  }
  if (sel?.extrudedSolid) {
    const s = (project.extrudedSolids ?? []).find((x) => x.id === sel!.id);
    const floor = s && project.drawingLevels.find((z) => z.id === s.levelId);
    sel.extrudedSolid.spec = s && s.operation !== "subtract" ? extrudedSolidSpec(s, floor?.baseElevation ?? 0) : null;
  }
  return sel;
}
