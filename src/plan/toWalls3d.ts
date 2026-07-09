// Leitet aus den Wänden eines Projekts die serialisierbaren WallInput-Records
// für den nativen render3d-Renderer ab. Matcht 1:1 render3d::types::WallInput
// { start:[x,y], end:[x,y], thickness, height, baseElevation, color:[r,g,b] }
// mit Modell-Metern und Y-up-Extrusion (Rust-Seite: plan liegt in XZ, +Y hoch).
//
// Alle Geschosse werden einbezogen und über wallVerticalExtent korrekt
// gestapelt (EG baseElevation 0, OG 2.6 …), sodass das 3D-Fenster das ganze
// Gebäude zeigt.
//
// ÖFFNUNGEN (Türen/Fenster): eine Wand mit Öffnungen wird NICHT als ein Quader
// emittiert, sondern in Teilquader entlang der Achse zerlegt:
//   • volle Wandhöhe links/rechts der Öffnung (Pfeiler),
//   • unter dem Fenster die Brüstung (UK..Sill),
//   • über Tür/Fenster der Sturz (OpeningTop..Wandkopf).
// So entstehen sichtbare Aussparungen ohne dass render3d etwas davon wissen muss.
//
// DECKEN (Slabs): geschossgebundene Flächenbauteile werden als extrudierte
// Polygon-Platten (SlabInput) mitgegeben — render3d trianguliert den Umriss und
// zieht ihn über die Deckendicke hoch.
//
// SCHICHTEN (Putz/Dämmung/Mauerwerk/…): der aufgelöste Schichtaufbau des
// WallType wird HIER (TS-seitig) in echte 3D-Substanz zerlegt — statt EINES
// Vollkörpers in der repräsentativen Farbe emittiert jede Achsen-Teilquader-
// Position je Materiallage eine EIGENE Box, quer zur Wanddicke entlang der
// Wand-Normalen gestapelt und in der Materialfarbe ihres Components eingefärbt
// (Option B). Schicht i belegt entlang der Normalen das Intervall
//   [−T/2 + Σ_{k<i} t_k,  −T/2 + Σ_{k≤i} t_k],  T = Σ t_k (Summe der Lagen),
// zentriert um die Wandachse. Alle Schicht-Boxen einer Wand tragen dieselbe
// `wallId` (Klick/Highlight selektieren die GANZE Wand). Jede Box ist ein
// Vollkörper (`layers: []`), den render3d in ihrer `color` zeichnet — die
// Schicht-Aufteilung passiert also komplett hier, render3d bleibt unverändert.
// Ohne auflösbaren WallType/ohne Schichten: EIN Vollkörper über die volle
// Dicke im neutralen Grundton (heutiges Fallback-Verhalten).

import type { Project, Wall, Ceiling, Column, Layer, ExtrudedSolid, Drawing2D, Vec2, HatchPattern, SliceTermination, Opening } from "../model/types";
import {
  getComponent,
  getWallType,
  getCeilingType,
  getStairType,
  wallTypeThickness,
  openingsOfWall,
  getFloor,
  flattenCategories,
  getDoorType,
  getWindowType,
} from "../model/types";
import { wallVerticalExtent, ceilingVerticalExtent, columnVerticalExtent, stairVerticalExtent } from "../model/wall";
import { columnFootprint } from "../geometry/column";
import { pointInOutline } from "../geometry/ceiling";
import { openingInterval, openingVerticalExtent, openingJambs } from "../geometry/opening";
import type { DetailLevel } from "../ui/TopBar";
import { stairGeometry, stairBBox } from "../geometry/stair";
import { roofGeometry, roofBaseElevation } from "../geometry/roof";
import type { Vec3 as RoofVec3 } from "../geometry/roof";
import { extrudePolygon, extrudeCircle } from "../engine/truckSolid";
import { computeJoins } from "../model/joins";
import type { WallCuts } from "../model/joins";
import { add, dot, leftNormal, lineIntersect, normalize, scale, sub } from "../model/geometry";
import type { Line } from "../model/geometry";
import { resolveHatch } from "./generatePlan";
import type { PickOpening, PickStair } from "../viewport/raycast3d";

/**
 * Achswinkel einer GESCHNITTENEN Wand im Schnitt-Koordinatensystem (Modell-
 * Konvention, identisch zu `SECTION_WALL_AXIS_ANGLE_DEG` in toSection.ts): das
 * Wand-Band steht vertikal (Achse entlang v, atan2(1,0) = 90°). Damit drehen
 * `relativeToWall`-Muster (Dämmung, Backstein) im 3D-Schnitt genauso mit der Wand
 * wie im 2D-Schnitt (`splitWallLayers` → `resolveHatch(…, 90, …)`). Für DECKEN gibt
 * es keinen Wandachsen-Bezug — dort bleibt der Winkel absolut (`emitSlabs` ruft
 * `resolveComponentHatch` ohne Achswinkel, wie `splitSlabLayers` → `resolveHatch(…,
 * undefined, …)`), sodass die liegende Boden-Dämmung vertikal statt horizontal läuft.
 */
const SECTION_WALL_AXIS_ANGLE_DEG = 90;

export type RVec2 = [number, number];
export type RRgb = [number, number, number];
/** Weltpunkt (x, elevation, y) — nur intern für Highlight-Kantengeometrie. */
type RVec3 = [number, number, number];

/**
 * Eine aufgelöste Wandschicht: Dicke + 3D-Albedo-Farbe (aus dem Component).
 * Wird seit der TS-seitigen Schicht-Zerlegung (Option B, siehe Moduldoc) NICHT
 * mehr an render3d durchgereicht — jede Schicht ist eine eigene Voll-Box; das
 * `RWall.layers`-Feld bleibt für Serde-Kompatibilität, aber stets leer.
 */
export interface RLayer {
  thickness: number;
  color: RRgb;
}

/**
 * Schnitt-Schraffur eines Bauteil-Bandes für den 3D-Live-Schnitt — matcht 1:1
 * render3d::types::Hatch. Nur die drei Felder, die der prozedurale Cap-Shader
 * (`CAP_WGSL`) auswertet: Muster-Id, Winkel (Grad), Skalierung. MONOCHROM (Tinte
 * auf Papier, wie die 2D-Direktive `HATCH_INK`) — es wandert nur das MUSTER mit,
 * KEINE Farbe. Muster-Id: 0 = none, 1 = solid, 2 = diagonal, 3 = crosshatch,
 * 4 = insulation (Zickzack/Dämmung). Synchron zu halten mit `hatchPatternId`
 * (unten), `types::Hatch` (Rust) und `CAP_WGSL`.
 */
export interface RHatch {
  pattern: number;
  angle: number;
  scale: number;
  /**
   * Strichstärke der Schraffur-Musterlinien in mm-Papier (aus dem LineStyle des
   * Hatch, `HatchRender.lineWeight`; Default 0.13). Matcht render3d::Hatch.lineWeight
   * — der Cap-Shader setzt die Musterlinien-Breite daraus (dieselbe mm→Welt-
   * Kalibrierung wie die Trennlinien), sodass die Schraffur-Stärke im 3D pro
   * Schraffur einstellbar ist (z. B. SIA `hatch-hair` 0.02 mm vs. `thin` 0.13 mm).
   */
  lineWeight?: number;
}

/** Bildet ein 2D-{@link HatchPattern} auf die Muster-Id von {@link RHatch}/CAP_WGSL ab. */
function hatchPatternId(p: HatchPattern): number {
  switch (p) {
    case "solid":
      return 1;
    case "diagonal":
      return 2;
    case "crosshatch":
      return 3;
    case "insulation":
      return 4;
    case "none":
    default:
      return 0;
  }
}

/**
 * Löst die Schnitt-Schraffur eines Bauteils (per `Component.hatchId`) zu einem
 * {@link RHatch} auf — dasselbe Muster/Winkel/Skalierung wie der 2D-Schnitt
 * (`generatePlan.ts::resolveHatch`, hier bewusst NICHT aufgerufen: nur die drei
 * render3d-relevanten Felder werden direkt aus dem {@link HatchStyle} gezogen, die
 * Farbe bleibt monochrom im Shader). `undefined`, wenn das Bauteil/die Schraffur
 * nicht auflösbar ist (der Cap-Shader fällt dann auf sein Diagonalmuster zurück).
 */
function resolveComponentHatch(
  project: Project,
  componentId: string,
  axisAngleDeg?: number,
): RHatch | undefined {
  try {
    const comp = getComponent(project, componentId);
    if (!comp.hatchId) return undefined;
    // GENAU der 2D-Schnitt-Pfad (`splitWallLayers`/`splitSlabLayers` →
    // `resolveHatch`): `axisAngleDeg` = 90 für WAND-Bänder (die geschnittene Wand
    // steht vertikal, `relativeToWall`-Muster drehen mit), `undefined` für DECKEN
    // (kein Wandachsen-Bezug → absoluter Winkel). Wir übernehmen den ENDWINKEL
    // (`HatchRender.angle`, bereits relativeToWall-korrigiert) UND die Musterlinien-
    // Stärke (`lineWeight`, aus dem LineStyle) — nicht mehr den rohen Hatch-Winkel.
    const hr = resolveHatch(project, comp.hatchId, axisAngleDeg);
    return { pattern: hatchPatternId(hr.pattern), angle: hr.angle, scale: hr.scale, lineWeight: hr.lineWeight };
  } catch {
    return undefined;
  }
}

/**
 * Schnitt-Schraffur der dicksten (dominanten) Schicht eines Schichtstapels.
 * `axisAngleDeg` wie {@link resolveComponentHatch} (90 für Wand, undefined für Decke).
 */
function dominantLayerHatch(
  layers: Layer[],
  project: Project,
  axisAngleDeg?: number,
): RHatch | undefined {
  if (layers.length === 0) return undefined;
  const dominant = layers.reduce((best, l) => (l.thickness > best.thickness ? l : best));
  return resolveComponentHatch(project, dominant.componentId, axisAngleDeg);
}

/**
 * Geordnete Liste der EINDEUTIGEN Material-Farbkarten-URLs (`Component.material.
 * color`), die von Wand-/Decken-Bauteilen des Projekts benutzt werden — in
 * deterministischer First-Seen-Reihenfolge über `project.walls` (Wandtyp-Schichten)
 * dann `project.ceilings`. Die POSITION in dieser Liste (+1) ist der Textur-Array-
 * Index (`WallInput.materialIndex`, 1-basiert; Ebene 0 = Fallback-Schachbrett), den
 * sowohl {@link resolveComponentMaterialLayer} (Zuweisung je Band) als auch der
 * JS-Decoder ({@link import("../viewport/materialTextures")}) verwenden — so
 * stimmen Band-Index und hochgeladene Textur-Ebene ohne separaten Map-Transport
 * überein. Memoisiert je Projekt-REFERENZ (der Store ist immutabel — jede Änderung
 * liefert ein neues Objekt, also kein Stale-Risiko), damit die per-Band-Auflösung
 * nicht quadratisch wird.
 */
const materialMapCache = new WeakMap<Project, string[]>();
export function wallMaterialColorMaps(project: Project): string[] {
  const cached = materialMapCache.get(project);
  if (cached) return cached;
  const seen = new Set<string>();
  const list: string[] = [];
  const consider = (componentId: string): void => {
    try {
      const url = getComponent(project, componentId).material?.color;
      if (url && !seen.has(url)) {
        seen.add(url);
        list.push(url);
      }
    } catch {
      // Unauflösbares Bauteil überspringen.
    }
  };
  for (const w of project.walls) {
    try {
      for (const l of getWallType(project, w).layers) consider(l.componentId);
    } catch {
      // Kein auflösbarer Wandtyp.
    }
  }
  for (const c of project.ceilings ?? []) {
    try {
      for (const l of getCeilingType(project, c).layers) consider(l.componentId);
    } catch {
      // Kein auflösbarer Deckentyp.
    }
  }
  materialMapCache.set(project, list);
  return list;
}

/**
 * Textur-Array-Ebene (1-basiert) der Material-Farbkarte eines Bauteils, oder
 * `undefined`, wenn das Bauteil kein Material mit Farbkarte trägt. Ebene 0 ist das
 * Fallback-Schachbrett — deshalb `indexOf + 1`. Siehe {@link wallMaterialColorMaps}.
 */
function resolveComponentMaterialLayer(project: Project, componentId: string): number | undefined {
  try {
    const url = getComponent(project, componentId).material?.color;
    if (!url) return undefined;
    const idx = wallMaterialColorMaps(project).indexOf(url);
    return idx >= 0 ? idx + 1 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ein rechteckiges LOCH (Fenster/Tür) in EINEM Wandkörper — matcht 1:1
 * render3d::types::Hole. KONVENTION: `from`/`to` sind Achsen-Meter ab
 * `RWall.start` (0..Achslänge, dieselbe Achse wie die Öffnungs-Intervalle);
 * `zBottom`/`zTop` sind ABSOLUTE Weltmeter (NICHT relativ zur Wand-UK — anders
 * als `Opening.sillHeight`). Eine Tür ist der Sonderfall
 * `zBottom == RWall.baseElevation` (Loch bis zur Wand-UK). render3d stanzt die
 * Löcher als echte Aussparungen in die beiden Langseiten (Rechteck-Gitter-
 * Zerlegung + Laibungsflächen), statt die Wand in Pfeiler/Brüstung/Sturz zu
 * zerlegen.
 */
export interface RHole {
  from: number;
  to: number;
  zBottom: number;
  zTop: number;
}

/**
 * Schnitt-Verschneidungs-/Linienstil-Metadaten EINES geschnittenen Bauteil-Bandes
 * für den 3D-Live-Schnitt — matcht 1:1 render3d::types::CutBandMeta. Trägt die
 * `joinPriority` (Schnitt-Boolean-Dominanz: die stärkere Schicht schneidet die
 * schwächere, `section_boolean::subtract_dominant_bands`), die `componentId` (MERGE-
 * Regel gleichartiger Bänder) sowie Farbe/Stärke der Schnitt-Umrisslinie (P2, aus
 * dem `jointLineStyleId`-LineStyle der Schicht). Alle Felder optional — fehlt eines,
 * greift auf der Rust-Seite der jeweilige Default (keine Subtraktion / Default-
 * Schnittkante).
 */
export interface RCutMeta {
  joinPriority?: number;
  componentId?: string;
  lineColor?: RRgb;
  lineWeight?: number;
}

export interface RWall {
  start: RVec2;
  end: RVec2;
  thickness: number;
  height: number;
  baseElevation: number;
  color: RRgb;
  /**
   * Immer leer: die Schichten werden TS-seitig in eigene Voll-Boxen zerlegt
   * (Option B, siehe Moduldoc). Feld bleibt nur zur Serde-Kompatibilität mit
   * render3d::WallInput (leer ⇒ Vollkörper-Extrusion in `color`).
   */
  layers: RLayer[];
  /**
   * Id der Ursprungs-Wand (`project.walls[].id`). Alle Öffnungs-Teilquader einer
   * Wand tragen dieselbe Id. Rein für den TS-seitigen Pick-Raycast (raycast3d);
   * der render3d/Serde-Pfad ignoriert das Feld (kein `deny_unknown_fields`,
   * serde verwirft unbekannte Felder).
   */
  wallId: string;
  /**
   * Echte rechteckige Löcher (Fenster/Türen) in DIESEM Wandkörper (siehe
   * {@link RHole}). Nur im 3D-Viewer-Pfad ({@link projectToModel3d} mit
   * `layeredWalls:true`) gesetzt: dort emittiert {@link emitWall} EINEN RWall pro
   * Schicht-Band über die volle Achse mit ALLEN Öffnungen als `holes` — statt der
   * Pfeiler/Brüstung/Sturz-Segment-Boxen. So bildet EIN Körper auch versetzt
   * übereinanderliegende Fenster ab (das kann die Segment-Zerlegung nicht). Der
   * Schnitt-Pfad (`layeredWalls:false`) setzt `holes` NICHT und segmentiert
   * unverändert weiter (Owner-Kompatibilität mit `toSection.ts`, s. u.). Fehlt/
   * leer ⇒ Vollkörper ohne Aussparung (render3d: `#[serde(default)]`). `holes`
   * und die Segment-Zerlegung schliessen sich damit gegenseitig aus.
   */
  holes?: RHole[];
  /**
   * Schnitt-Schraffur dieses Wand-Bandes (siehe {@link RHatch}) — matcht
   * render3d::WallInput.hatch. Im layered-3D-Pfad trägt jede Materiallage die
   * Schraffur IHRES Bauteils, sodass der 3D-Live-Schnitt jede geschnittene
   * Schicht in ihrem Muster (Beton/Dämmung/Backstein/…) zeichnet. Fehlt sie
   * (unauflösbares Bauteil), zeichnet der Cap-Shader sein Diagonal-Fallback.
   */
  hatch?: RHatch;
  /**
   * Material-Textur-Ebene dieses Wand-Bandes für den Stil `Textured` (matcht
   * render3d::WallInput.materialIndex, 1-basiert; Ebene 0 = Fallback-Schachbrett).
   * Aus `Component.material.color` über {@link wallMaterialColorMaps} aufgelöst;
   * fehlt sie, zeigt render3d das Schachbrett. Der Schnitt/Serde-Pfad ignoriert es.
   */
  materialIndex?: number;
  /**
   * Schnitt-Verschneidungs-/Linienstil-Metadaten dieses Wand-Bandes (siehe
   * {@link RCutMeta}) — matcht render3d::WallInput.cut. Im layered-3D-Pfad trägt
   * jede Materiallage ihre `joinPriority`/`componentId`/Schnittkanten-Stil, sodass
   * der 3D-Live-Schnitt die Boolean-Dominanz + Fugenlinien wie der 2D-Schnitt macht.
   */
  cut?: RCutMeta;
}

/** Eine extrudierte Deckenplatte: geschlossener Grundriss-Umriss + Z-Ausdehnung. */
export interface RSlab {
  outline: RVec2[];
  zBottom: number;
  zTop: number;
  color: RRgb;
  /**
   * Id der Ursprungs-Decke (`project.ceilings[].id`). Nur für den TS-seitigen
   * Pick-Raycast (raycast3d); der render3d/Serde-Pfad ignoriert das Feld
   * (kein `deny_unknown_fields`).
   */
  ceilingId: string;
  /** Schnitt-Schraffur der Decke (dominante Schicht, siehe {@link RHatch}). */
  hatch?: RHatch;
  /** Schnitt-Verschneidungs-/Linienstil-Metadaten dieser Decken-Schicht (siehe {@link RCutMeta}). */
  cut?: RCutMeta;
}

/** Art eines rohen Kontext-Meshes (bestimmt in render3d die Default-Einfärbung). */
export type RMeshKind = "terrain" | "imported" | "extrusion";

/**
 * Ein rohes Dreiecks-Mesh aus dem Geo-Kontext (Terrain-TIN oder importiertes
 * Gebäude-/DXF-Volumen). `positions` ist das flache (x,y,z=Höhe…)-Array in
 * MODELL-Metern — genau wie `ImportedMesh`/`TerrainMesh` es hält; render3d bildet
 * es selbst nach world (x, z, y) ab (analog Wände/Decken). Matcht
 * render3d::types::MeshInput.
 */
export interface RMesh {
  positions: number[];
  indices: number[];
  kind: RMeshKind;
  color: RRgb;
}

/** Modell-Bündel für den nativen 3D-Renderer (Wände + Decken + Kontext-Meshes). */
export interface RModel3d {
  walls: RWall[];
  slabs: RSlab[];
  meshes: RMesh[];
}

/** Warmer, neutraler Wand-Grundton (wie render3d default). */
const WALL_RGB: RRgb = [0.82, 0.8, 0.76];
/** Etwas hellerer, kühlerer Ton für Deckenplatten (heben sich von Wänden ab). */
const SLAB_RGB: RRgb = [0.86, 0.86, 0.88];
/** Gedämpftes Lehm-/Geländegrün-grau (three.js mats.terrain = 0xa9b0a2). */
const TERRAIN_RGB: RRgb = [169 / 255, 176 / 255, 162 / 255];
/** Neutrales Hellgrau für importierte Meshes (three.js mats.mesh = 0x9fa6ae). */
const IMPORTED_RGB: RRgb = [159 / 255, 166 / 255, 174 / 255];
/** Warmes Orange für truck-Profil-Extrusionen (hebt sie klar von Wand/Decke/Kontext ab). */
const EXTRUSION_RGB: RRgb = [0.85, 0.55, 0.25];
/** Neutraler Beton-/Tragwerks-Grauton für Stützen (Fallback ohne Bauteil-Farbe). */
const COLUMN_RGB: RRgb = [0.7, 0.7, 0.72];
/** Helles, leicht bläuliches Fenster-Glas (Scheibe in der Öffnung). */
const GLASS_RGB: RRgb = [0.62, 0.76, 0.85];
/** Halbe Dicke der Fensterscheibe (Meter) — sehr dünn, mittig in der Wand. */
const GLASS_HALF_THICK = 0.01;
/**
 * Helles, warmes Rahmen-Grau (Zarge/Blendrahmen/Kämpfer/Sprossen) — bewusst
 * deutlich heller als Wand ({@link WALL_RGB}) und klar von der bläulichen
 * Scheibe ({@link GLASS_RGB}) unterscheidbar, damit der Rahmen im 3D als
 * eigenes Bauteil lesbar ist (s. {@link emitOpeningFrames}).
 */
const FRAME_RGB: RRgb = [0.85, 0.85, 0.83];
/** Default-Ansichtsbreite des Rahmenprofils (Meter), wenn `TYPE.frameWidth` fehlt. */
const DEFAULT_FRAME_WIDTH = 0.06;
/** Warmer Terrakotta-Grauton für Dachflächen/-giebel (s. {@link emitRoofs}) — hebt das Dach klar von Wand/Decke/Kontext ab. */
const ROOF_RGB: RRgb = [0.72, 0.45, 0.36];
/** Fallback-Farbe für 2D-Zeichnungen ohne color/lineStyle/Kategorie (wie drawing2DColor in Viewport3D.tsx, "#888888"). */
const DRAWING_LINE_FALLBACK_RGB: RRgb = [0x88 / 255, 0x88 / 255, 0x88 / 255];
/** Halbe Linienbreite der 2D-Boden-Spuren im 3D (Meter) — liest sich als dünne Linie. */
const DRAWING_LINE_HALF_WIDTH = 0.008;
/** Höhen-Offset über der Geschossebene gegen Z-Fighting (wie addDrawing2DLines in Viewport3D.tsx). */
const DRAWING_LINE_ELEVATION_EPS = 0.01;

/** Ignoriere entartete vertikale Ausschnitte (Rundungsrauschen). */
const EPS = 1e-4;

/**
 * Wandelt eine Hex-Farbe ("#rrggbb", Component-Farbe im Plan) in float-RGB
 * (0..1, render3d-Konvention) um. Ungültiges/fehlendes Format fällt auf den
 * neutralen Wand-Grundton zurück (nie ein hartes Fehlbild).
 */
function hexToRgb(hex: string, fallback: RRgb = WALL_RGB): RRgb {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex ?? "");
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

/**
 * Repräsentative Bauteilfarbe eines Schichtaufbaus: die Farbe der DICKSTEN
 * Schicht (i. d. R. die tragende/dominante Schicht, z. B. Mauerwerk/Beton) —
 * einfache Näherung, solange Wände/Decken als EIN Vollkörper emittiert werden
 * (kein Schicht-Rendering in 3D). Fällt auf `fallback` zurück, wenn keine
 * Schicht vorhanden ist oder deren Component nicht auflösbar ist.
 */
function dominantLayerColor(layers: Layer[], project: Project, fallback: RRgb): RRgb {
  if (layers.length === 0) return fallback;
  const dominant = layers.reduce((best, l) => (l.thickness > best.thickness ? l : best));
  try {
    return hexToRgb(getComponent(project, dominant.componentId).color, fallback);
  } catch {
    return fallback;
  }
}

/**
 * Eine quer zur Wanddicke gestapelte Materiallage als 3D-Band: eigene Dicke,
 * Materialfarbe und Mitten-Versatz `offset` (Meter, entlang der Wand-Normalen,
 * relativ zur Wandachse). Jede solche Lage wird pro Achsen-Teilquader zu einer
 * eigenen Voll-Box (siehe {@link emitWall}/{@link pushSegment}).
 */
interface WallBand {
  thickness: number;
  color: RRgb;
  offset: number;
  /** Schnitt-Schraffur des Band-Bauteils (siehe {@link RHatch}). */
  hatch?: RHatch;
  /** Material-Textur-Ebene des Band-Bauteils (1-basiert, siehe {@link wallMaterialColorMaps}). */
  materialIndex?: number;
  /**
   * Verschneidungs-Rang dieser Materiallage (`Component.joinPriority`) — treibt
   * die per-Schicht-Dominanz gegen Decken im layered-3D-Pfad (s.
   * {@link collectCeilingCutters}/{@link emitWall}): eine Decke mit STRIKT höherer
   * `joinPriority` schneidet nur die Bänder mit niedrigerem Rang aus ihrem
   * z-Intervall (der Kern höherer Priorität läuft durch). `undefined` (kein
   * auflösbarer WallType / synthetisches Fallback-Band) ⇒ keine Decken-
   * Subtraktion (konservativ, wie das frühere Trim-Verhalten bei unbekanntem Typ).
   */
  priority?: number;
  /**
   * Bauteil-Identität dieser Materiallage (`Component.id`) — treibt die MERGE-Regel
   * der Schnitt-Boolean-Dominanz (gleiche Komponente + Priorität verschmelzen, keine
   * innere Trennlinie). Reist als `RCutMeta.componentId` mit.
   */
  componentId?: string;
  /** Farbe der Schnitt-Umrisslinie dieser Schicht (aus `jointLineStyleId`, sonst Default). */
  cutLineColor?: RRgb;
  /** Strichstärke der Schnitt-Umrisslinie in mm-Papier (aus `jointLineStyleId`, sonst Default). */
  cutLineWeight?: number;
}

/**
 * Löst den Schnitt-UMRISSLINIEN-Stil einer Schicht aus ihrem
 * `Layer.jointLineStyleId` (LineStyle) auf: Farbe (hex→RGB 0..1) + Strichstärke
 * (mm-Papier) — dieselbe Quelle wie die 2D-Schichtfuge (`generatePlan.ts`, Zeile
 * ~1681). Fehlt der Verweis/LineStyle, `undefined` (der 3D-Cut fällt dann auf
 * seinen Default-Schnittkanten-Stil zurück, siehe `section_fill::build_cut_cap_lines`).
 * Bewusst tolerant (`find` statt `getLineStyle`), wie im 2D — ein verwaister Verweis
 * darf den 3D-Push nicht werfen.
 */
function resolveCutLineStyle(
  project: Project,
  jointLineStyleId: string | undefined,
): { color?: RRgb; weight?: number } | undefined {
  if (!jointLineStyleId) return undefined;
  const ls = project.lineStyles.find((l) => l.id === jointLineStyleId);
  if (!ls) return undefined;
  return { color: hexToRgb(ls.color, DRAWING_LINE_FALLBACK_RGB), weight: ls.weight };
}

/**
 * Baut die {@link RCutMeta}-Nutzlast eines Wand-Bandes (Priorität/Identität/
 * Schnittkanten-Stil), oder `undefined`, wenn das Band keinerlei Schnitt-Metadaten
 * trägt (z. B. das Fallback-Vollkörper-Band ohne auflösbaren WallType). Nur gesetzte
 * Felder werden übernommen, damit `#[serde(default)]` auf der Rust-Seite greift.
 */
function bandCutMeta(b: WallBand): RCutMeta | undefined {
  const meta: RCutMeta = {};
  if (b.priority !== undefined) meta.joinPriority = b.priority;
  if (b.componentId !== undefined) meta.componentId = b.componentId;
  if (b.cutLineColor !== undefined) meta.lineColor = b.cutLineColor;
  if (b.cutLineWeight !== undefined) meta.lineWeight = b.cutLineWeight;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Löst den Schichtstapel EINER Wand auf: je Materiallage ein {@link WallBand}
 * mit ihrer Dicke, Component-Farbe und dem Mitten-Versatz entlang der Normalen.
 * Die Versätze zentrieren den Stapel um die Wandachse; als Gesamtdicke T dient
 * die SUMME der tatsächlichen Lagen-Dicken (nicht `wallTypeThickness`, falls es
 * abweicht) — so schließen die Bänder lückenlos aneinander an. Kein auflösbarer
 * WallType / keine Lagen ⇒ EIN Vollkörper-Band über die volle Dicke im
 * neutralen Grundton (heutiges Fallback-Verhalten).
 */
function resolveWallBands(project: Project, wall: Wall, layered = true): WallBand[] {
  try {
    const wt = getWallType(project, wall);
    if (wt.layers.length > 0) {
      // Gesamtdicke = Summe der Lagen (konsistent mit den Offsets); wenn diese
      // von wallTypeThickness abwiche, gewinnt die Lagen-Summe (keine Lücken).
      const total = wt.layers.reduce((s, l) => s + l.thickness, 0);
      // Schnitt-Eingabe (layered=false): EINE Voll-Box über die ganze Dicke statt
      // je Lage eine Box. So bleibt die Emission 1:1 Wand→Rechteck — passend zu
      // `wallSegmentOwners`/`splitWallLayers` in toSection.ts, die die Schicht-
      // Zerlegung TS-seitig aus diesem einen Rechteck machen. (Der 3D-Viewer ruft
      // mit Default layered=true auf und bekommt unverändert die Schicht-Bänder.)
      if (!layered) {
        const dominant = wt.layers.reduce((best, l) => (l.thickness > best.thickness ? l : best));
        return [
          {
            thickness: total,
            color: dominantLayerColor(wt.layers, project, WALL_RGB),
            offset: 0,
            hatch: dominantLayerHatch(wt.layers, project, SECTION_WALL_AXIS_ANGLE_DEG),
            materialIndex: resolveComponentMaterialLayer(project, dominant.componentId),
          },
        ];
      }
      const bands: WallBand[] = [];
      let prefix = 0;
      for (const l of wt.layers) {
        const comp = getComponent(project, l.componentId);
        const color = hexToRgb(comp.color);
        const lineStyle = resolveCutLineStyle(project, l.jointLineStyleId);
        bands.push({
          thickness: l.thickness,
          color,
          offset: -total / 2 + prefix + l.thickness / 2,
          priority: comp.joinPriority,
          componentId: comp.id,
          cutLineColor: lineStyle?.color,
          cutLineWeight: lineStyle?.weight,
          hatch: resolveComponentHatch(project, l.componentId, SECTION_WALL_AXIS_ANGLE_DEG),
          materialIndex: resolveComponentMaterialLayer(project, l.componentId),
        });
        prefix += l.thickness;
      }
      return bands;
    }
    // WallType ohne Schichten: EIN Vollkörper über die Typ-Gesamtdicke.
    return [{ thickness: wallTypeThickness(wt), color: WALL_RGB, offset: 0 }];
  } catch {
    // Kein auflösbarer WallType: EIN Vollkörper mit Default-Dicke/Grundton.
    return [{ thickness: 0.2, color: WALL_RGB, offset: 0 }];
  }
}

/**
 * Hängt eine Wand-Schicht-Box an: das Achsenstück [from..to] (Meter ab
 * Wand-Startpunkt) über den Höhenbereich [zBottom..zTop], quer um `normalOffset`
 * Meter entlang der Wand-Normalen versetzt (Schichtmitte relativ zur Achse) und
 * mit Schicht-`thickness`/`color`. Entartete Stücke (Länge ≤ 0 oder Höhe ≤ 0)
 * werden übersprungen — so überleben Öffnungen dicht an den Wandenden ohne
 * Nullquader.
 *
 * Optionale `holes`: echte rechteckige Aussparungen in DIESER Box (siehe
 * {@link RHole}). Ihre `from`/`to` sind Achsen-Meter ab Wand-Start (dieselbe
 * Achse wie `from`/`to` dieser Box), `zBottom`/`zTop` absolute Weltmeter — beides
 * unverändert an render3d durchgereicht (der Querversatz `normalOffset` wirkt nur
 * senkrecht zur Achse und lässt die Loch-Parametrisierung unberührt). Werden nur
 * im 3D-Pfad (voller Achsen-Quader) gesetzt.
 */
function pushSegment(
  out: RWall[],
  wall: Wall,
  from: number,
  to: number,
  zBottom: number,
  zTop: number,
  thickness: number,
  normalOffset: number,
  color: RRgb,
  wallId: string,
  hatch?: RHatch,
  materialIndex?: number,
  holes?: RHole[],
  cut?: RCutMeta,
): void {
  if (to - from <= EPS) return;
  if (zTop - zBottom <= EPS) return;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return;
  const ux = dx / len;
  const uy = dy / len;
  // LINKE Grundriss-Normale (identisch zu `leftNormal(u)` = (−uy, ux) in
  // generatePlan.ts/clippedBand — dieselbe Konvention, die addWallPoche für
  // den Schichtstapel im 2D-Grundriss benutzt). Der Schicht-Versatz verschiebt
  // Start/Ende der Box quer zur Wand, sodass render3d die Box um ihre eigene
  // (versetzte) Achse zentriert aufbaut — mit dieser Normale liegt Schicht 0
  // (Aussenseite, kleinster `offset`) auf derselben Weltseite wie im Grundriss.
  // Bewusst NICHT identisch zur Normale, die raycast3d/selectionHighlightLines
  // für den Box-Rebuild nutzen (n = (uy, −ux), rechte Normale) — das ist
  // unschädlich, weil jene Boxen symmetrisch um die (hier bereits versetzte)
  // Achse jedes einzelnen Layer-Records aufgebaut werden und daher unabhängig
  // von der Vorzeichen-Konvention des Versatzes sind.
  const ox = -uy * normalOffset;
  const oy = ux * normalOffset;
  const p1: RVec2 = [wall.start.x + ux * from + ox, wall.start.y + uy * from + oy];
  const p2: RVec2 = [wall.start.x + ux * to + ox, wall.start.y + uy * to + oy];
  out.push({
    start: p1,
    end: p2,
    thickness,
    height: zTop - zBottom,
    baseElevation: zBottom,
    color,
    layers: [],
    wallId,
    ...(hatch ? { hatch } : {}),
    ...(materialIndex != null ? { materialIndex } : {}),
    ...(holes && holes.length > 0 ? { holes } : {}),
    ...(cut ? { cut } : {}),
  });
}

/**
 * Achsenparalleles Grundriss-Rechteck (min/max je Achse), Meter, Modell-XY.
 * Dient hier NUR der groben Footprint-Überlapp-Prüfung Wand↔Decke (s.
 * {@link trimWallTopForCeilings}) — kein exakter Polygon-Test, siehe dort.
 */
interface Bounds2 {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Bounding-Box der Wandachse, um `halfThickness` in beide Richtungen geweitet
 * (sichere Über-Approximation des tatsächlichen Wandkörpers, unabhängig von
 * dessen Orientierung). */
function wallFootprintBounds(wall: Wall, halfThickness: number): Bounds2 {
  return {
    minX: Math.min(wall.start.x, wall.end.x) - halfThickness,
    maxX: Math.max(wall.start.x, wall.end.x) + halfThickness,
    minY: Math.min(wall.start.y, wall.end.y) - halfThickness,
    maxY: Math.max(wall.start.y, wall.end.y) + halfThickness,
  };
}

/** Bounding-Box eines geschlossenen Umrisses (Decke). */
function outlineBounds(outline: Array<{ x: number; y: number }>): Bounds2 {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of outline) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/** Überlappen sich zwei Bounding-Boxen (mit EPS-Toleranz an den Rändern)? */
function boundsOverlap(a: Bounds2, b: Bounds2): boolean {
  return (
    a.minX <= b.maxX + EPS &&
    a.maxX >= b.minX - EPS &&
    a.minY <= b.maxY + EPS &&
    a.maxY >= b.minY - EPS
  );
}

/**
 * Dicke einer Wand für die Footprint-Näherung (s. {@link wallFootprintBounds}):
 * Summe der WallType-Schichtdicken, sonst der Fallback-Grundton-Dicke aus
 * {@link resolveWallBands} (0.2 m), falls kein WallType auflösbar ist.
 */
function wallThicknessSafe(project: Project, wall: Wall): number {
  try {
    return wallTypeThickness(getWallType(project, wall));
  } catch {
    return 0.2;
  }
}

/**
 * Repräsentative `joinPriority` einer Decke (höchste ihrer Schichten) — bestimmt,
 * ob die Decke am Wand/Decke-Stoss "durchläuft" (gewinnt) und in die Wandschichten
 * niedrigerer Priorität einschneidet (s. {@link collectCeilingCutters}).
 */
function ceilingDominantPriority(project: Project, ceiling: Ceiling): number | undefined {
  try {
    const ct = getCeilingType(project, ceiling);
    let best: number | undefined;
    for (const layer of ct.layers) {
      const p = getComponent(project, layer.componentId).joinPriority;
      if (best === undefined || p > best) best = p;
    }
    return best;
  } catch {
    return undefined;
  }
}

/**
 * Ein Decken-„Cutter": vertikales z-Intervall + Dominanz-Rang + Grundriss-Umriss
 * (s. {@link collectCeilingCutters}). Der `outline` erlaubt die PER-BAND-genaue
 * Überdeckungsprüfung in {@link emitWall} (statt eines wandweiten BBox-Tests): eine
 * Decke schneidet ein Schicht-Band nur dort, wo ihre Outline die Footprint-
 * Mittellinie des Bandes im Grundriss überdeckt.
 */
interface CeilingCutter {
  zBottom: number;
  zTop: number;
  priority: number;
  outline: Vec2[];
}

/**
 * Sammelt die Decken, die eine Wand im layered-3D-Pfad PRO SCHICHT einschneiden —
 * die 3D-Entsprechung der Schnitt-Boolean-Dominanz (`toSection.ts::
 * subtractDominantBands`): statt die GANZE Wand am Deckenanschluss zu kappen
 * (früheres `trimWallTopForCeilings`), behält die Wand ihre volle Höhe und JEDES
 * Schicht-Band verliert nur das z-Intervall der Decken mit STRIKT höherer
 * `joinPriority` als das Band (der Kern höherer Priorität läuft durch die Decke).
 * Ein Band kann dadurch vertikal in zwei Boxen zerfallen (unter Deckenunterkante
 * + über Deckenoberkante, falls die Wand die Decke überragt).
 *
 * Kriterien je Decke (alle müssen zutreffen):
 *  • dasselbe Geschoss (`ceiling.floorId === wall.floorId`),
 *  • vertikale Überlappung mit der (vollen) Wand-Ausdehnung,
 *  • grober Footprint-Überlapp (Bounding-Box, s. {@link boundsOverlap}) — nur ein
 *    billiger Vor-Filter (keine Wand berührt, wenn die Wand-BBox die Decken-BBox
 *    nicht schneidet); die EXAKTE, per-Band geometrische Überdeckung entscheidet
 *    dann in {@link emitWall} (s. {@link bandCoverageIntervals}).
 *  • auflösbare Decken-`joinPriority` (`ceilingDominantPriority`).
 *
 * Das z-Intervall/die Priorität der Cutter ist PER DECKENSCHICHT (nicht die ganze
 * Decke als EIN Block der dominanten Priorität): jede Deckenschicht wird zu einem
 * eigenen Cutter mit IHREM z-Band (proportional auf [zBottom,zTop] verteilt, exakt
 * wie {@link emitSlabs}) und IHRER `Component.joinPriority`. Das ist zwingend, damit
 * der 3D-Cut EXAKT wie der 2D-Schnitt (`toSection.ts::subtractDominantBands`)
 * verschneidet: dort trägt jede Schicht ihre eigene Priorität. Mit dem früheren
 * EINEN Block (dominante Prio 100 über die volle Decke) verlor z. B. der Backstein
 * (50) das GANZE Decken-z-Band [UK,OK] — obwohl er die schwimmenden Deckenschichten
 * Estrich (30)/Dämmung (20) ÜBERRAGEN und schneiden soll; nur die Betonschicht (100)
 * darf ihn kappen. So blieb im 3D (Solid UND Schnitt) über dem Backstein eine Lücke,
 * durch die Estrich/Dämmung „rausliefen" (Nutzer-Bug). Per Schicht läuft der
 * Backstein zwischen Beton-OK und Wandkopf durch und schneidet dort Estrich/Dämmung
 * weg — identisch zum 2D-Schnitt. Der `outline` reist mit, damit {@link emitWall}
 * PRO BAND prüft, ob die Decke die Footprint-Mittellinie dieses Bandes überdeckt
 * (geometrischer Überlapp, kein wandweiter BBox-Test). Der Prioritätsvergleich pro
 * Band passiert in {@link emitWall} (`cutter.priority > band.priority`) — eine
 * Wand-Schicht mit ≥ Rang der jeweiligen Deckenschicht läuft durch deren z-Band durch.
 * Ein-Schicht-/nicht auflösbare Deckentypen fallen auf EINEN Cutter über die volle
 * Ausdehnung mit der dominanten Priorität zurück (Alt-Verhalten).
 */
function collectCeilingCutters(
  project: Project,
  wall: Wall,
  zBottom: number,
  zTop: number,
): CeilingCutter[] {
  const halfThickness = wallThicknessSafe(project, wall) / 2;
  const wallBounds = wallFootprintBounds(wall, halfThickness);
  const cutters: CeilingCutter[] = [];
  for (const c of project.ceilings ?? []) {
    if (c.floorId !== wall.floorId) continue;
    if (!c.outline || c.outline.length < 3) continue;
    const cExtent = ceilingVerticalExtent(project, c);
    if (cExtent.zBottom >= zTop - EPS || cExtent.zTop <= zBottom + EPS) continue;
    if (!boundsOverlap(wallBounds, outlineBounds(c.outline))) continue;

    // Per-Schicht-Cutter: je Deckenschicht ein eigenes z-Band + eigene Priorität
    // (proportional auf die tatsächliche Decken-z-Spanne skaliert, oben→unten wie
    // emitSlabs). Nur so schneidet Beton (100) den Backstein (50), Backstein aber
    // Estrich (30)/Dämmung (20) — identisch zu subtractDominantBands.
    let layers: Layer[] | undefined;
    try {
      layers = getCeilingType(project, c).layers;
    } catch {
      layers = undefined;
    }
    const total = layers?.reduce((s, l) => s + l.thickness, 0) ?? 0;
    if (layers && layers.length > 0 && total > EPS) {
      const span = cExtent.zTop - cExtent.zBottom;
      let prefixTop = 0; // von OK (zTop) nach unten aufsummiert (Meter)
      for (const l of layers) {
        const t = (l.thickness / total) * span;
        const layerTop = cExtent.zTop - prefixTop;
        const layerBottom = layerTop - t;
        prefixTop += t;
        let prio: number | undefined;
        try {
          prio = getComponent(project, l.componentId).joinPriority;
        } catch {
          prio = undefined;
        }
        if (prio === undefined) continue;
        cutters.push({ zBottom: layerBottom, zTop: layerTop, priority: prio, outline: c.outline });
      }
    } else {
      const ceilingPriority = ceilingDominantPriority(project, c);
      if (ceilingPriority === undefined) continue;
      cutters.push({ zBottom: cExtent.zBottom, zTop: cExtent.zTop, priority: ceilingPriority, outline: c.outline });
    }
  }
  return cutters;
}

/**
 * Achsen-Teilintervalle (Meter ab `wall.start` entlang `u`, geklemmt auf
 * `[lo,hi]`), auf denen die MITTELLINIE eines Schicht-Bands (Querversatz
 * `bandOffset` entlang `n = leftNormal(u)`) im Decken-Umriss `outline` liegt —
 * die per-Band-Entsprechung des geometrischen Rechteck-Überlapps in
 * `toSection.ts::subtractDominantBands`. Nur diese Teilintervalle bekommen später
 * den Decken-z-Schnitt; unbedeckte Achsenabschnitte behalten die volle Höhe (so
 * laufen Dämmung/Aussenputz, deren Mittellinie AUSSERHALB des Decken-Umrisses
 * liegt, ununterbrochen durch — der Nutzer-Bug „Kranz durch die Dämmung").
 *
 * Die Bandmittellinie wird entlang der Achse gerastert (~5-cm-Schritte, min. 32)
 * und gegen {@link pointInOutline} geprüft; Innen/Aussen-Übergänge werden per
 * Bisektion auf ~EPS verfeinert, sodass die Überdeckungsgrenzen scharf sind (auch
 * eine Decke, die nur einen Teil der Wandlänge überdeckt, wird korrekt getrimmt).
 */
function bandCoverageIntervals(
  wall: Wall,
  u: Vec2,
  n: Vec2,
  bandOffset: number,
  outline: Vec2[],
  lo: number,
  hi: number,
): Array<[number, number]> {
  if (hi - lo <= EPS) return [];
  const base = add(wall.start, scale(n, bandOffset));
  const inside = (t: number): boolean => pointInOutline(add(base, scale(u, t)), outline);
  const steps = Math.max(32, Math.ceil((hi - lo) / 0.05));
  const dt = (hi - lo) / steps;
  const intervals: Array<[number, number]> = [];
  let prevInside = inside(lo);
  let start: number | null = prevInside ? lo : null;
  let prevT = lo;
  for (let i = 1; i <= steps; i++) {
    const t = i === steps ? hi : lo + i * dt;
    const now = inside(t);
    if (now !== prevInside) {
      const cross = bisectBoundary(inside, prevT, t);
      if (now) start = cross;
      else if (start !== null) {
        intervals.push([start, cross]);
        start = null;
      }
    }
    prevInside = now;
    prevT = t;
  }
  if (start !== null) intervals.push([start, hi]);
  return intervals;
}

/**
 * Bisektion des Innen/Aussen-Übergangs der Bandmittellinie zwischen `a` und `b`
 * (verschiedene {@link pointInOutline}-Seiten) auf ~EPS-Genauigkeit — liefert die
 * scharfe Achsen-Position der Überdeckungsgrenze.
 */
function bisectBoundary(inside: (t: number) => boolean, a: number, b: number): number {
  const aInside = inside(a);
  let lo = a;
  let hi = b;
  for (let i = 0; i < 40 && hi - lo > EPS * 0.01; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid) === aInside) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Zieht die Cutter-Intervalle `holes` vom Intervall `[lo,hi]` ab und liefert die
 * verbleibenden Teil-Intervalle (Meter). Löcher werden auf `[lo,hi]` geklemmt,
 * sortiert und vereinigt; leeres `holes` ⇒ exakt `[[lo,hi]]` (unveränderter Fall).
 * Dient sowohl der Achsen-Zerlegung durch Durchgangswand-Span-Cutouts als auch
 * der vertikalen Decken-Subtraktion (identische 1D-Semantik wie
 * `generatePlan.ts::subtractIntervals`, hier lokal gehalten — generatePlan bleibt
 * unangetastet).
 */
function subtractSpans(lo: number, hi: number, holes: Array<[number, number]>): Array<[number, number]> {
  const clipped = holes
    .map(([a, b]): [number, number] => [Math.max(lo, Math.min(a, b)), Math.min(hi, Math.max(a, b))])
    .filter(([a, b]) => b > a + EPS)
    .sort((p, q) => p[0] - q[0]);
  const parts: Array<[number, number]> = [];
  let cursor = lo;
  for (const [a, b] of clipped) {
    if (a > cursor + EPS) parts.push([cursor, a]);
    if (b > cursor) cursor = b;
  }
  if (cursor < hi - EPS) parts.push([cursor, hi]);
  return parts;
}

/**
 * Wendet die Decken-z-Cutter `cutters` (dominante horizontale Cut-Bänder [zBottom,
 * zTop]) auf das Wandband-Intervall `[lo,hi]` an — je nach Terminierungs-Regel der
 * Wand ({@link Wall.sliceTermination}). Bewusst als EIGENER, klar benannter Schritt
 * neben der Priorität gehalten (Terminierung = Zuschnitt, KEINE Prioritätsregel):
 *
 *   • "both"/undefined ⇒ heutiges Verhalten: `subtractSpans` stanzt jedes Cutter-
 *     z-Band aus (oben+unten Reste bleiben erhalten). Bit-identisch zu vorher.
 *   • "below" ⇒ die Wand ENDET an der Decke: alles AB der Decken-UNTERKANTE wird
 *     verworfen (kein über der Decke wieder auftauchender Rest). Clip-Grenze = das
 *     KLEINSTE `zBottom` aller dominanten Cutter dieses Bandes. Da die dominanteste
 *     (tragende) Deckenschicht — z. B. Beton (Prio 100) — jedes schwächere Band
 *     kappt UND zugleich die unterste Deckenlage ist, terminieren so ALLE Bänder
 *     einheitlich an der Deckenunterkante (kein Durchstoss/Staffel, keine
 *     Interpenetration mit Beton/Dämmung darüber). Für den Backstein, den nur der
 *     Beton kappt, ist das exakt „unter dem dominanten Cut" (dessen Unterkante).
 *   • "above" ⇒ spiegelbildlich: alles BIS zur Decken-OBERKANTE wird verworfen.
 *     Clip-Grenze = das GRÖSSTE `zTop` aller dominanten Cutter dieses Bandes.
 *
 * Ohne Cutter (`cutters` leer) bleibt `[lo,hi]` in allen Modi unverändert — ein
 * Band ausserhalb des Decken-Umrisses (Aussenputz/Dämmung) läuft also weiter voll
 * durch, unabhängig von der Terminierung.
 */
function terminateOrSubtractSpans(
  lo: number,
  hi: number,
  cutters: Array<[number, number]>,
  termination: SliceTermination | undefined,
): Array<[number, number]> {
  if (cutters.length === 0) return [[lo, hi]];
  if (termination === "below") {
    // Deckenunterkante = kleinstes zBottom der Cutter; die Wand endet dort.
    let clipTop = Infinity;
    for (const [cb] of cutters) clipTop = Math.min(clipTop, cb);
    const top = Math.min(clipTop, hi);
    return top > lo + EPS ? [[lo, top]] : [];
  }
  if (termination === "above") {
    // Deckenoberkante = grösstes zTop der Cutter; die Wand beginnt dort.
    let clipBottom = -Infinity;
    for (const [, ct] of cutters) clipBottom = Math.max(clipBottom, ct);
    const bottom = Math.max(clipBottom, lo);
    return bottom < hi - EPS ? [[bottom, hi]] : [];
  }
  return subtractSpans(lo, hi, cutters);
}

/**
 * Achsen-Distanz (Meter ab `wall.start` entlang der Wandrichtung `u`), an der die
 * MITTELLINIE eines Schicht-Bands (Querversatz `bandOffset` entlang `leftNormal(u)`)
 * die Gehrungs-/Anschluss-Schnittlinie `cut` trifft — die 3D-Achsenbox-Entsprechung
 * des 2D-`clippedBand`. Da die Box achsparallel endet (keine gekippte Stirnfläche),
 * wird die Band-Länge auf den Schnittpunkt der MITTELLINIE gekürzt/verlängert; die
 * beiden 2D-Bandkanten (bei ±thickness/2) treffen die Schnittlinie an leicht
 * versetzten Achsenpunkten — der Box-Wert ist ihr Mittelwert. `null` bei
 * (nahezu) parallelem Schnitt (kollineare Achsen) ⇒ Aufrufer behält das Bandende.
 */
function bandCutDistance(wall: Wall, u: Vec2, n: Vec2, bandOffset: number, cut: Line): number | null {
  const base = add(wall.start, scale(n, bandOffset));
  const hit = lineIntersect(base, u, cut.point, cut.dir);
  if (!hit) return null;
  return dot(sub(hit, wall.start), u);
}

/**
 * Emittiert die Wandkörper EINER Wand (mit oder ohne Öffnungen).
 *
 * ZWEI PFADE je `layered`:
 *  • layered=true (3D-Viewer, Default): EIN Körper pro Schicht-Band über die
 *    VOLLE Achse mit allen Öffnungen als echte `holes` (render3d stanzt sie in
 *    die Langseiten). Ermöglicht auch versetzt übereinanderliegende Fenster in
 *    EINEM Körper (keine Segment-Nähte).
 *  • layered=false (Schnitt-Pfad, `computeSection`): UNVERÄNDERTE Pfeiler/
 *    Brüstung/Sturz-Segmentierung (EIN Voll-Band je Segment), damit die
 *    `ComponentRef.index`-Reihenfolge exakt zu `toSection.ts::wallSegmentOwners`
 *    passt (Owner-Kompatibilität; toSection.ts bleibt unangetastet). Löcher
 *    werden hier NICHT emittiert.
 */
function emitWall(out: RWall[], project: Project, wall: Wall, layered = true, cuts?: WallCuts): void {
  const bands = resolveWallBands(project, wall, layered);
  const { zBottom, zTop } = wallVerticalExtent(project, wall);
  // Anders als früher (`trimWallTopForCeilings` kappte im layered-Pfad die GANZE
  // Wand an der Deckenunterkante) behält die Wand jetzt IN BEIDEN PFADEN ihre
  // volle Höhe; die per-Schicht-Decken-Subtraktion (unten, nur layered) schneidet
  // Bänder niedrigerer Priorität im Decken-z-Band aus — die 3D-Entsprechung der
  // Schnitt-Boolean-Dominanz. Der Schnitt-Pfad (layered=false) bleibt unverändert
  // (volle Rohgeometrie; seine Dominanz macht toSection.ts::subtractDominantBands).
  const axisLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  if (axisLen < 1e-9 || zTop - zBottom <= EPS) return;

  // Ein Achsen-Teilquader × jede Materiallage = eine Box (Schichtstapel quer
  // zur Wanddicke). Alle tragen die Wand-Id, sodass ein Klick auf irgendeine
  // Schicht die GANZE Wand selektiert und das Highlight alle Bänder umrandet.
  const emitSeg = (from: number, to: number, zb: number, zt: number): void => {
    for (const b of bands) {
      pushSegment(out, wall, from, to, zb, zt, b.thickness, b.offset, b.color, wall.id, b.hatch, b.materialIndex, undefined, bandCutMeta(b));
    }
  };

  // Aussparungen der Wand als vereinheitlichte Cutouts sammeln:
  //   • Öffnungen (project.openings, Fenster mit Brüstung/Sturz),
  //   • Legacy-Türen (project.doors, sitzen am Boden, nur Sturz).
  // Jeweils [from..to] auf die Achse geklemmt + vertikale Öffnungs-Ausdehnung.
  const cutouts: Array<{ from: number; to: number; oBottom: number; oTop: number }> = [];
  for (const op of openingsOfWall(project, wall.id)) {
    const iv = openingInterval(wall, op);
    if (!iv) continue;
    const v = openingVerticalExtent(project, wall, op);
    cutouts.push({ from: iv.from, to: iv.to, oBottom: v.zBottom, oTop: v.zTop });
  }
  for (const d of project.doors ?? []) {
    if (d.hostWallId !== wall.id) continue;
    const from = Math.max(0, Math.min(d.position, axisLen));
    const to = Math.max(from, Math.min(d.position + d.width, axisLen));
    if (to - from < EPS) continue;
    // Tür sitzt am Boden (UK der Wand), reicht bis zur lichten Türhöhe.
    const oTop = Math.min(zTop, zBottom + d.height);
    cutouts.push({ from, to, oBottom: zBottom, oTop });
  }
  cutouts.sort((a, b) => a.from - b.from);

  // ── 3D-Viewer-Pfad (layered=true): EIN Körper je Schicht-Band über die volle
  // Achse mit allen Öffnungen als echte Löcher (render3d stanzt sie), PLUS die
  // materialbewussten Verschneidungen (identisch zum 2D-Grundriss/Schnitt):
  //   1. End-Cuts/Merge an L-/T-Stössen: jede Schicht wird an ihrem Achsenende an
  //      der Gehrungs-/Anschluss-Schnittlinie individuell gekürzt/verlängert
  //      (`WallCuts.startCut`/`endCut`, bzw. pro Schicht `layerCuts.start/end` —
  //      merge: Kern läuft bis zur Rückgrat-Nahfläche durch; trim: Putz stoppt an
  //      der Wandoberfläche). Wie im 2D wird die Band-MITTELLINIE geschnitten.
  //   2. Durchgangswand-Span-Cutouts: der Nah-Putz einer Durchgangswand wird über
  //      die Achsen-Breite des durchstechenden Abzweig-Kerns ausgeschnitten — ein
  //      Band zerfällt dabei entlang der Achse in mehrere Teilstücke.
  //   3. Decken-Dominanz pro Schicht: Bänder niedrigerer `joinPriority` verlieren
  //      das z-Intervall überlappender Decken (vertikaler Split), der Kern läuft
  //      durch (s. {@link collectCeilingCutters}).
  // Die Öffnungs-Löcher (`holes`, Achsen-Meter ab Wand-Start) werden je Teilstück
  // auf dessen Achsen-Start umgerechnet (rebased), damit render3d sie relativ zum
  // jeweiligen Box-Start korrekt stanzt.
  if (layered) {
    const holes: RHole[] = cutouts.map((c) => ({
      from: c.from,
      to: c.to,
      zBottom: c.oBottom,
      zTop: c.oTop,
    }));
    const startCut = cuts?.startCut ?? null;
    const endCut = cuts?.endCut ?? null;
    const layerCuts = cuts?.layerCuts;
    const spanCutouts = cuts?.spanCutouts ?? [];
    const ux = (wall.end.x - wall.start.x) / axisLen;
    const uy = (wall.end.y - wall.start.y) / axisLen;
    const u: Vec2 = { x: ux, y: uy };
    const n = leftNormal(u); // (-uy, ux) — dieselbe Konvention wie pushSegment/2D.
    const ceilingCutters = collectCeilingCutters(project, wall, zBottom, zTop);

    for (let li = 0; li < bands.length; li++) {
      const b = bands[li];
      // (1) Per-Schicht-Cuts an den Achsenden. `layerCuts` (materialbewusster
      // T-Stoss) überschreibt — wo gesetzt — den einheitlichen start/endCut PRO
      // Schicht; `null` an einem Index heisst „keine Kürzung an diesem Ende".
      // Exakt die 2D-Wahl aus generatePlan.ts::addWallPoche (Zeile ~1523).
      const sCut = layerCuts ? layerCuts.start[li] : startCut;
      const eCut = layerCuts ? layerCuts.end[li] : endCut;
      let from0 = 0;
      let to0 = axisLen;
      if (sCut) {
        const d = bandCutDistance(wall, u, n, b.offset, sCut);
        if (d !== null) from0 = d;
      }
      if (eCut) {
        const d = bandCutDistance(wall, u, n, b.offset, eCut);
        if (d !== null) to0 = d;
      }

      // (2) Span-Cutouts, deren Quer-Offsetbereich dieses Band schneidet, brechen
      // die Achse [from0,to0] auf (Nah-Putz-Durchstoss der Durchgangswand).
      const bandLo = b.offset - b.thickness / 2;
      const bandHi = b.offset + b.thickness / 2;
      const axisHoles: Array<[number, number]> = [];
      for (const c of spanCutouts) {
        const cLo = Math.min(c.offA, c.offB);
        const cHi = Math.max(c.offA, c.offB);
        if (bandLo < cHi - EPS && bandHi > cLo + EPS) axisHoles.push([c.from, c.to]);
      }
      const axisPieces = subtractSpans(from0, to0, axisHoles);

      // (3) Decken-Subtraktion GEOMETRISCH pro Band (Replik der Schnitt-Boolean-
      // Dominanz `toSection.ts::subtractDominantBands`): eine Decke mit STRIKT
      // höherer Priorität schneidet dieses Band nur dort aus, wo ihr Grundriss-
      // Umriss die Footprint-MITTELLINIE dieses Bandes überdeckt (nicht mehr der
      // wandweite BBox-Test). Aussenschichten (Dämmung/Aussenputz), deren
      // Mittellinie ausserhalb des Decken-Umrisses liegt, laufen ununterbrochen
      // durch — nur der überdeckte Kern verliert das Decken-z-Intervall. Ohne
      // auflösbare Band-Priorität bleibt die volle Höhe (konservativ).
      const bandZCuts: Array<{ from: number; to: number; zBottom: number; zTop: number }> = [];
      if (b.priority !== undefined) {
        for (const cc of ceilingCutters) {
          if (cc.priority <= b.priority) continue;
          for (const [ca, cb] of bandCoverageIntervals(wall, u, n, b.offset, cc.outline, from0, to0)) {
            bandZCuts.push({ from: ca, to: cb, zBottom: cc.zBottom, zTop: cc.zTop });
          }
        }
      }

      // Öffnungs-Löcher, die ein z-Teilstück vertikal berühren, auf den Box-Start
      // `a` umrechnen (render3d klemmt u/z selbst auf die Box).
      const emitPiece = (a: number, bb: number, zb: number, zt: number): void => {
        const segHoles = holes
          .filter((h) => h.zTop > zb + EPS && h.zBottom < zt - EPS)
          .map((h) => ({ from: h.from - a, to: h.to - a, zBottom: h.zBottom, zTop: h.zTop }));
        pushSegment(out, wall, a, bb, zb, zt, b.thickness, b.offset, b.color, wall.id, b.hatch, b.materialIndex, segHoles, bandCutMeta(b));
      };

      for (const [a, bb] of axisPieces) {
        // Nur die Decken-z-Schnitte, die dieses Achsen-Teilstück wirklich treffen.
        const local = bandZCuts
          .map((c) => ({ from: Math.max(a, c.from), to: Math.min(bb, c.to), zBottom: c.zBottom, zTop: c.zTop }))
          .filter((c) => c.to > c.from + EPS);
        if (local.length === 0) {
          // Kein Decken-Überlapp auf diesem Achsenstück ⇒ volle Höhe (Band läuft durch).
          emitPiece(a, bb, zBottom, zTop);
          continue;
        }
        // Achse [a,bb] an allen Überdeckungs-Grenzen in elementare Teilstücke
        // zerlegen; je Teilstück nur die dort greifenden Decken-z-Intervalle
        // subtrahieren (unbedeckte Teilstücke behalten die volle Höhe).
        const bounds = new Set<number>([a, bb]);
        for (const c of local) {
          bounds.add(c.from);
          bounds.add(c.to);
        }
        const xs = [...bounds].sort((p, q) => p - q);
        for (let i = 0; i < xs.length - 1; i++) {
          const xa = xs[i];
          const xb = xs[i + 1];
          if (xb - xa <= EPS) continue;
          const mid = (xa + xb) / 2;
          const zCutters = local
            .filter((c) => c.from <= mid && c.to >= mid)
            .map((c): [number, number] => [c.zBottom, c.zTop]);
          // Terminierung (Zuschnitt) statt reiner z-Subtraktion: bei "below"/"above"
          // endet die Wand an der Decke, statt oben wieder aufzutauchen (s.
          // {@link terminateOrSubtractSpans}). "both"/undefined = heutiges Verhalten.
          for (const [zb, zt] of terminateOrSubtractSpans(zBottom, zTop, zCutters, wall.sliceTermination)) {
            emitPiece(xa, xb, zb, zt);
          }
        }
      }
    }
    return;
  }

  // ── Schnitt-Pfad (layered=false): unveränderte Pfeiler/Brüstung/Sturz-
  // Segmentierung (Owner-Kompatibilität mit toSection.ts::wallSegmentOwners).
  // Ohne Aussparungen: ein durchgehender Quader je Schicht.
  if (cutouts.length === 0) {
    emitSeg(0, axisLen, zBottom, zTop);
    return;
  }

  // Wand entlang der Achse durchlaufen: volle Pfeiler zwischen den Aussparungen,
  // Brüstung/Sturz im Öffnungsbereich. Überlappende Cutouts werden über `cursor`
  // zusammengefasst.
  let cursor = 0;
  for (const { from, to, oBottom, oTop } of cutouts) {
    const segFrom = Math.max(cursor, from);
    if (from > cursor) {
      // Voller Wandpfeiler bis zur Aussparung.
      emitSeg(cursor, from, zBottom, zTop);
    }
    if (to > segFrom) {
      // Brüstung unter der Öffnung (bei Türen entfällt sie, da oBottom == zBottom).
      if (oBottom > zBottom + EPS) {
        emitSeg(segFrom, to, zBottom, oBottom);
      }
      // Sturz über der Öffnung (bis zum Wandkopf).
      if (oTop < zTop - EPS) {
        emitSeg(segFrom, to, oTop, zTop);
      }
    }
    cursor = Math.max(cursor, to);
  }
  // Restlicher Wandpfeiler bis zum Achsenende.
  if (cursor < axisLen) {
    emitSeg(cursor, axisLen, zBottom, zTop);
  }
}

/** Neutraler Beton-Grauton für Treppen (wie der Three.js-Pfad `addStairMeshes`). */
const STAIR_RGB: RRgb = hexToRgb("#9aa0a6", SLAB_RGB);

/**
 * Emittiert Treppen als RSlabs (extrudierte Grundriss-Polygone) — der WASM/wgpu-
 * Renderer kennt sonst KEINE Treppen (nur Wände/Decken/Meshes), sodass Treppen im
 * Standard-3D unsichtbar blieben. Jeder Tritt ist ein extrudiertes Polygon; das
 * ist exakt eine RSlab. Tragart über {@link getStairType}:
 *  • "massiv" / kein Typ — Vollblock je Tritt von der Treppen-UK bis zur Tritt-OK
 *    (gestuftes Massiv, Treppe auf Erdreich/Sockel).
 *  • "beton" — Ortbeton-Laufplatte: je Tritt ein Block von der SCHRÄGEN Untersicht
 *    (eine Stufe + Laufplattendicke unter der Tritt-OK, an der Treppen-UK gekappt)
 *    bis zur Tritt-OK. Die stufig gestapelten Blöcke bilden die schräge, UNTEN
 *    OFFENE Untersicht der klassischen Betontreppe.
 *  • "wange"/"aufgesattelt"/"spindel" — nur eine dünne Tritt-Platte der Dicke
 *    `treadThickness` an der Tritt-OK, darunter offen.
 * Podest (L/Wendel) als Vollblock bis zur halben Steighöhe. Setzstufen/Nase/
 * Geländer sind Verfeinerungen (Three.js-Pfad) — hier zählt zuerst die SICHTBARKEIT.
 * `ceilingId` trägt hier die Treppen-Id (nur TS-seitiges Tagging; render3d ignoriert
 * das Feld, und der Pick läuft separat über {@link pickGeometry}).
 */
const CONCRETE_WAIST = 0.18; // Laufplattendicke einer Ortbetontreppe (Meter)

function emitStairs(project: Project): RSlab[] {
  const out: RSlab[] = [];
  for (const stair of project.stairs ?? []) {
    const { zBottom, zTop } = stairVerticalExtent(project, stair);
    const totalRise = zTop - zBottom;
    if (totalRise <= EPS) continue;
    const geo = stairGeometry(stair, totalRise);
    const st = getStairType(project, stair);
    const structure = st?.structure ?? "massiv";
    // Gerade Betontreppe: die GLATTE Laufplatte kommt als echtes Mesh
    // (emitStairMeshes) — hier keine Slab-Näherung emittieren (sonst doppelt).
    if (structure === "beton" && stair.shape === "straight") continue;
    const treadThickness = st?.treadThickness ?? 0.04;
    const riser = geo.riserHeight;
    for (const tr of geo.treads) {
      if (tr.pts.length < 3) continue;
      const top = zBottom + tr.topRise;
      const bottom =
        structure === "massiv"
          ? zBottom // Vollblock bis zur Treppen-UK
          : structure === "beton"
            ? Math.max(zBottom, top - riser - CONCRETE_WAIST) // schräge Laufplatte
            : top - treadThickness; // offene Tritte (Wange/aufgesattelt/Spindel)
      if (top - bottom <= EPS) continue;
      out.push({
        outline: tr.pts.map((p) => [p.x, p.y] as RVec2),
        zBottom: bottom,
        zTop: top,
        color: STAIR_RGB,
        ceilingId: stair.id,
      });
    }
    if (geo.landing && geo.landing.length >= 3) {
      out.push({
        outline: geo.landing.map((p) => [p.x, p.y] as RVec2),
        zBottom,
        zTop: zBottom + totalRise * 0.5,
        color: STAIR_RGB,
        ceilingId: stair.id,
      });
    }
  }
  return out;
}

/**
 * Glatte Ortbeton-Laufplatte (Tragart "beton") als echtes Dreiecks-Mesh — nur für
 * GERADE Läufe. Anders als die stufige Slab-Näherung ({@link emitStairs}) entsteht
 * eine SPIEGELGLATTE schräge Untersicht: je Tritt ein konvexes Prisma mit
 * HORIZONTALER Oberkante (= Trittfläche) und SCHRÄGER Unterkante auf EINER
 * gemeinsamen Soffit-Geraden. Weil alle Prismen-Unterkanten exakt auf dieser
 * Geraden liegen, bildet die Vereinigung eine durchgehende glatte Schräge; die
 * Höhensprünge der Oberkanten bleiben als sichtbare Setzstufen. Prismen sind
 * konvex → triviale, robuste Triangulierung (kein Ear-Clipping). Positions in
 * MODELL-Metern (x, y, z=Höhe); render3d bildet nach world (x, z, y) ab.
 */
function emitStairMeshes(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const stair of project.stairs ?? []) {
    const st = getStairType(project, stair);
    if (!st || st.structure !== "beton") continue;
    if (stair.shape !== "straight") continue; // glattes Mesh nur für gerade Läufe
    if (stair.runLength <= EPS) continue;
    const { zBottom, zTop } = stairVerticalExtent(project, stair);
    const totalRise = zTop - zBottom;
    if (totalRise <= EPS) continue;
    const geo = stairGeometry(stair, totalRise);
    const u = normalize(stair.dir); // Laufrichtung (Grundriss)
    const w = leftNormal(u); // Querrichtung (Breite)
    const runTotal = stair.runLength;
    // Laufplattendicke (vertikal): an die Steigung gekoppelt, geklemmt.
    const waistV = Math.min(0.24, Math.max(0.14, geo.riserHeight * 1.2));
    // Soffit-Höhe entlang des Laufs: eine Gerade PARALLEL zur Trittkantenlinie
    // (Steigung totalRise/runTotal), um `waistV` nach unten versetzt → KONSTANTE
    // Plattendicke über den ganzen Lauf (sonst würde die Platte nach oben dicker).
    // An der Treppen-UK gekappt, damit die unterste Stufe auf dem Boden aufsitzt
    // statt darunter zu schweben.
    const soffitH = (runS: number) => {
      const s = Math.min(Math.max(runS, 0), runTotal);
      return Math.max(zBottom, zBottom + (s / runTotal) * totalRise - waistV);
    };
    const runOf = (p: Vec2) => (p.x - stair.start.x) * u.x + (p.y - stair.start.y) * u.y;
    const sideOf = (p: Vec2) => (p.x - stair.start.x) * w.x + (p.y - stair.start.y) * w.y;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const tr of geo.treads) {
      if (tr.pts.length < 4) continue;
      // Vier Eckpunkte nach Lauf-Parameter trennen (2 kleinste = Startkante, 2
      // grösste = Endkante), je Kante nach Quer-Parameter sortieren (0 = links).
      const byRun = [...tr.pts].sort((a, b) => runOf(a) - runOf(b));
      const startEdge = [byRun[0], byRun[1]].sort((a, b) => sideOf(a) - sideOf(b));
      const endEdge = [byRun[2], byRun[3]].sort((a, b) => sideOf(a) - sideOf(b));
      const runS = Math.min(runOf(byRun[0]), runOf(byRun[1]));
      const runE = Math.max(runOf(byRun[2]), runOf(byRun[3]));
      const topH = zBottom + tr.topRise;
      const bS = soffitH(runS);
      const bE = soffitH(runE);
      if (topH - Math.max(bS, bE) <= EPS) continue;
      const base = positions.length / 3;
      const push = (p: Vec2, z: number) => positions.push(p.x, p.y, z);
      // 0/1 Startkante unten (soffit), 2/3 Endkante unten, 4/5 Start oben, 6/7 End oben.
      push(startEdge[0], bS); push(startEdge[1], bS);
      push(endEdge[0], bE);   push(endEdge[1], bE);
      push(startEdge[0], topH); push(startEdge[1], topH);
      push(endEdge[0], topH);   push(endEdge[1], topH);
      const quad = (a: number, b: number, c: number, d: number) =>
        indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
      quad(0, 1, 3, 2); // Untersicht (schräge Soffit-Fläche)
      quad(4, 6, 7, 5); // Oberseite (Trittfläche)
      quad(0, 4, 5, 1); // Startkante (Setzstufen-Front der Vorstufe sichtbar)
      quad(2, 3, 7, 6); // Endkante
      quad(0, 2, 6, 4); // linke Wange
      quad(1, 5, 7, 3); // rechte Wange
    }
    if (indices.length === 0) continue;
    out.push({ positions, indices, kind: "extrusion", color: STAIR_RGB });
  }
  return out;
}

/** Emittiert die Deckenplatten eines Projekts (falls vorhanden). */
function emitSlabs(project: Project): RSlab[] {
  const out: RSlab[] = [];
  for (const c of project.ceilings ?? []) {
    if (!c.outline || c.outline.length < 3) continue;
    // zBottom/zTop (und damit die Deckendicke) berechnet ceilingVerticalExtent
    // bereits über ceilingThickness (respektiert Typ-Dicke + Übersteuerung).
    const { zBottom, zTop } = ceilingVerticalExtent(project, c);
    if (zTop - zBottom <= EPS) continue;
    const outline = c.outline.map((p) => [p.x, p.y] as RVec2);

    // Geschichteter Bodenaufbau: je Schicht des Deckentyps EIN eigener Slab,
    // von oben (OK, erste Lage) nach unten (UK, letzte Lage) gestapelt und
    // proportional auf die tatsächliche z-Spanne [zBottom, zTop] verteilt (wie
    // die Lagen-Summe bei den Wänden). Jede Lage trägt ihre Bauteil-Schraffur +
    // -Farbe — so zeigt der 3D-Schnitt den Bodenaufbau GESCHICHTET (Estrich/
    // Dämmung/Beton …), identisch zum 2D-Schnitt, statt eines Einkörpers in der
    // dominanten Schicht. Kein auflösbarer Deckentyp / keine Lagen ⇒ EIN
    // Vollkörper-Slab in SLAB_RGB (bisheriges Fallback-Verhalten).
    let layers: Layer[] | undefined;
    try {
      layers = getCeilingType(project, c).layers;
    } catch {
      layers = undefined;
    }
    const total = layers?.reduce((s, l) => s + l.thickness, 0) ?? 0;
    if (layers && layers.length > 0 && total > EPS) {
      const span = zTop - zBottom;
      let prefixTop = 0; // von OK (zTop) nach unten aufsummiert (Meter)
      for (const l of layers) {
        const t = (l.thickness / total) * span;
        const layerTop = zTop - prefixTop;
        const layerBottom = layerTop - t;
        prefixTop += t;
        let color: RRgb = SLAB_RGB;
        let cut: RCutMeta | undefined;
        try {
          const comp = getComponent(project, l.componentId);
          color = hexToRgb(comp.color);
          // Schnitt-Metadaten der Schicht: joinPriority + Identität (für die
          // Boolean-Dominanz/MERGE) + Schnittkanten-Stil aus jointLineStyleId.
          const lineStyle = resolveCutLineStyle(project, l.jointLineStyleId);
          cut = {
            joinPriority: comp.joinPriority,
            componentId: comp.id,
            ...(lineStyle?.color ? { lineColor: lineStyle.color } : {}),
            ...(lineStyle?.weight != null ? { lineWeight: lineStyle.weight } : {}),
          };
        } catch {
          color = SLAB_RGB;
          cut = undefined;
        }
        const hatch = resolveComponentHatch(project, l.componentId);
        out.push({
          outline,
          zBottom: layerBottom,
          zTop: layerTop,
          color,
          ceilingId: c.id,
          ...(hatch ? { hatch } : {}),
          ...(cut ? { cut } : {}),
        });
      }
    } else {
      out.push({ outline, zBottom, zTop, color: SLAB_RGB, ceilingId: c.id });
    }
  }
  return out;
}

/** Event-Name für den "Extrusion(en) geladen"-Stoss (s. Wasm3DViewport.tsx/nativeSync.ts). */
export const TRUCK_MESH_READY_EVENT = "dossier:truck-mesh-ready";

/**
 * Extrudiert `project.extrudedSolids` (truck-Integration, `docs/design/
 * truck-plan.md`) zu Kontext-Meshes. `extrudePolygon` lädt WASM asynchron;
 * `emitMeshes`/`emitExtrudedSolids` selbst bleiben synchron (Aufrufer wie
 * `updateModel`/`pushNativeWalls` erwarten das) — daher ein modulweiter Cache
 * je Solid-Id, der bei fehlendem/veraltetem Eintrag die Extrusion im
 * Hintergrund anstösst und `TRUCK_MESH_READY_EVENT` feuert, sobald sie fertig
 * ist (Wasm3DViewport/nativeSync hören darauf und re-pushen das Modell — ohne
 * das Signal käme eine fertige Extrusion trotz Erfolgs NIE ins Bild, weil
 * `updateModel` nur bei PROJEKT-Änderungen erneut läuft). Nur im Browser (kein
 * `window` unter vitest/node) und mit stillem Fallback bei Fehlern.
 */
interface TruckCacheEntry {
  /** Signatur (Punkte+Höhe) des Solids beim Laden — invalidiert den Eintrag bei Änderung. */
  signature: string;
  /** null, solange die Extrusion noch lädt. */
  mesh: RMesh | null;
}
const truckMeshCache = new Map<string, TruckCacheEntry>();

function extrudedSolidSignature(solid: ExtrudedSolid): string {
  return `${solid.height}|${solid.taper ?? 0}|${solid.points.map((p) => `${p.x},${p.y}`).join(";")}`;
}

function emitExtrudedSolids(project: Project): RMesh[] {
  if (typeof window === "undefined") return [];
  const out: RMesh[] = [];
  // Cache-Einträge gelöschter/nicht mehr existierender Körper verwerfen (sonst
  // wächst der Cache unbegrenzt über eine Session, z. B. nach Extrudieren →
  // Kopieren → Löschen in Serie).
  const liveIds = new Set((project.extrudedSolids ?? []).map((s) => s.id));
  for (const id of truckMeshCache.keys()) {
    if (!liveIds.has(id)) truckMeshCache.delete(id);
  }
  for (const solid of project.extrudedSolids ?? []) {
    if (solid.points.length < 3 || solid.height <= 0) continue;
    const signature = extrudedSolidSignature(solid);
    let entry = truckMeshCache.get(solid.id);
    if (!entry || entry.signature !== signature) {
      // Die bisherige Mesh (falls vorhanden) WEITER anzeigen, bis die neue
      // Extrusion fertig geladen ist — sonst verschwindet der Körper kurz,
      // während der Nutzer Höhe/Verjüngung im Attribute-Panel tippt (jeder
      // Tastendruck feuert onChange → neue Signatur).
      const staleMesh = entry?.mesh ?? null;
      entry = { signature, mesh: staleMesh };
      truckMeshCache.set(solid.id, entry);
      let baseZ = 0;
      try {
        baseZ = getFloor(project, solid.levelId).baseElevation ?? 0;
      } catch {
        // Geschoss nicht (mehr) auflösbar: bei UK 0 extrudieren (Fallback).
      }
      // Kreis-Profil: echte runde truck-Extrusion (extrudeCircle) statt der
      // 48-Eck-Tessellierung in `points` — glattes Zylinder-Mesh.
      const taper = solid.taper ?? 0;
      const extrusion = solid.circle
        ? extrudeCircle(solid.circle.center.x, solid.circle.center.y, solid.circle.r, solid.height, taper)
        : extrudePolygon(solid.points.flatMap((p) => [p.x, p.y]), solid.height, taper);
      extrusion
        .then((mesh) => {
          // truck extrudiert immer ab z=0 — auf die Geschoss-UK anheben.
          const positions =
            baseZ === 0
              ? mesh.positions
              : mesh.positions.map((v, i) => (i % 3 === 2 ? v + baseZ : v));
          const cur = truckMeshCache.get(solid.id);
          if (!cur || cur.signature !== signature) return; // inzwischen veraltet
          cur.mesh = { positions, indices: mesh.indices, kind: "extrusion", color: EXTRUSION_RGB };
          window.dispatchEvent(new Event(TRUCK_MESH_READY_EVENT));
        })
        .catch((e) => console.warn("truck-Extrusion fehlgeschlagen:", e));
    }
    if (entry.mesh) out.push(entry.mesh);
  }
  return out;
}

/**
 * Strecken eines 2D-Zeichenelements für die Boden-Spur im 3D — exakt dieselbe
 * Teilmenge wie `drawing2DSegments` im drei.js-Fallback (`Viewport3D.tsx`):
 * line/polyline/rect. Kreis/Bogen/Text bleiben aussen vor (keine neue
 * Fähigkeit gegenüber dem Fallback, nur Parität).
 */
function drawingSegments3d(d: Drawing2D): [Vec2, Vec2][] {
  const g = d.geom;
  const out: [Vec2, Vec2][] = [];
  if (g.shape === "line") out.push([g.a, g.b]);
  else if (g.shape === "polyline") {
    for (let i = 0; i < g.pts.length - 1; i++) out.push([g.pts[i], g.pts[i + 1]]);
    if (g.closed && g.pts.length > 2) out.push([g.pts[g.pts.length - 1], g.pts[0]]);
  } else if (g.shape === "rect") {
    const c1 = g.min, c3 = g.max;
    const c2 = { x: g.max.x, y: g.min.y }, c4 = { x: g.min.x, y: g.max.y };
    out.push([c1, c2], [c2, c3], [c3, c4], [c4, c1]);
  }
  return out;
}

/** Modellfarbe einer 2D-Zeichnung (color → LineStyle → Kategorie), analog `drawing2DColor`. */
function drawingColor3d(project: Project, d: Drawing2D): RRgb {
  if (d.color) return hexToRgb(d.color, DRAWING_LINE_FALLBACK_RGB);
  const ls = d.lineStyleId ? project.lineStyles.find((l) => l.id === d.lineStyleId) : undefined;
  if (ls?.color) return hexToRgb(ls.color, DRAWING_LINE_FALLBACK_RGB);
  const cat = flattenCategories(project.layers).find((c) => c.code === d.categoryCode);
  return cat?.color ? hexToRgb(cat.color, DRAWING_LINE_FALLBACK_RGB) : DRAWING_LINE_FALLBACK_RGB;
}

/**
 * Emittiert je 2D-Zeichnung ein dünnes Ribbon-Mesh knapp über ihrer
 * Geschossebene — die "2D-Referenz im 3D" (z. B. ein Boden-Raster), die der
 * drei.js-Fallback (`addDrawing2DLines`) zeigt, bisher aber im nativen
 * render3d/wgpu-Pfad fehlte (`RModel3d` kannte nur walls/slabs/meshes).
 * `positions` in MODELL-Metern (x, y, z=Höhe) wie `emitOpeningGlass`; render3d
 * rendert Kontext-Meshes ohnehin doppelseitig (`append_context_mesh`), daher
 * genügt ein flaches Ribbon (kein Quader) pro Strecke.
 */
function emitDrawingLines(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const d of project.drawings2d) {
    const segs = drawingSegments3d(d);
    if (segs.length === 0) continue;
    let baseZ = 0;
    try {
      baseZ = getFloor(project, d.levelId).baseElevation ?? 0;
    } catch {
      // Geschoss nicht (mehr) auflösbar: bei UK 0 zeichnen (Fallback).
    }
    const elev = baseZ + DRAWING_LINE_ELEVATION_EPS;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const [a, b] of segs) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const nx = (-dy / len) * DRAWING_LINE_HALF_WIDTH;
      const ny = (dx / len) * DRAWING_LINE_HALF_WIDTH;
      const base = positions.length / 3;
      positions.push(
        a.x + nx, a.y + ny, elev,
        a.x - nx, a.y - ny, elev,
        b.x - nx, b.y - ny, elev,
        b.x + nx, b.y + ny, elev,
      );
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    if (positions.length === 0) continue;
    out.push({ positions, indices, kind: "imported", color: drawingColor3d(project, d) });
  }
  return out;
}

/**
 * 3D-Farbe einer Stütze: die Bauteil-Albedo (`Component.color`), falls ein
 * `componentId` auflösbar ist, sonst der neutrale Tragwerks-Grauton {@link
 * COLUMN_RGB}. Eine explizite `column.color` (Grundriss-Umrissfarbe) wirkt
 * bewusst NICHT auf die 3D-Fläche (nur der 2D-Umriss), damit die 3D-Darstellung
 * material-/neutral bleibt — analog Wand (Umrissfarbe ≠ 3D-Albedo).
 */
function columnColor3d(project: Project, col: Column): RRgb {
  if (col.componentId) {
    try {
      return hexToRgb(getComponent(project, col.componentId).color, COLUMN_RGB);
    } catch {
      return COLUMN_RGB;
    }
  }
  return COLUMN_RGB;
}

/**
 * Baut ein geschlossenes Prisma-Mesh aus einem konvexen Grundriss-Polygon
 * `foot` (≥3 Punkte, CCW) zwischen `zBottom` und `zTop`. `positions` in MODELL-
 * Metern (x, y, z=Höhe) wie {@link emitMeshes}; render3d rendert Kontext-Meshes
 * doppelseitig, daher ist die Winding-Reihenfolge unerheblich. Die Deckel werden
 * als Dreiecks-Fächer ab dem ersten Vertex tesselliert (konvex → korrekt).
 */
function prismMesh(foot: Vec2[], zBottom: number, zTop: number, color: RRgb): RMesh {
  const n = foot.length;
  const positions: number[] = [];
  const indices: number[] = [];
  // 0..n-1 = untere Ring-Vertices, n..2n-1 = obere Ring-Vertices.
  for (const p of foot) positions.push(p.x, p.y, zBottom);
  for (const p of foot) positions.push(p.x, p.y, zTop);
  // Mantelflächen: je Kante ein Quad (2 Dreiecke).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = i, b1 = j, t0 = i + n, t1 = j + n;
    indices.push(b0, b1, t1, b0, t1, t0);
  }
  // Deckel (Fächer ab Vertex 0): unten + oben.
  for (let i = 1; i < n - 1; i++) {
    indices.push(0, i, i + 1); // unten
    indices.push(n, n + i, n + i + 1); // oben
  }
  return { positions, indices, kind: "extrusion", color };
}

/**
 * Extrudiert `project.columns` (Tragwerk) zu parametrischen Prisma-Meshes —
 * Rechteck-Box bzw. tesselliertes Kreis-Prisma, je Profil. SYNCHRON (anders als
 * die truck-Extrusion der `ExtrudedSolid`s, {@link emitExtrudedSolids}): die
 * Kontur kommt aus {@link columnFootprint}, die vertikale Lage aus {@link
 * columnVerticalExtent} (UK/OK-Anker bzw. Geschoss-UK + Höhe). Rust/render3d
 * bleibt unverändert (Kontext-Mesh-Pfad).
 */
function emitColumns(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const col of project.columns ?? []) {
    if (col.height <= 0) continue;
    const foot = columnFootprint(col);
    if (foot.length < 3) continue;
    const { zBottom, zTop } = columnVerticalExtent(project, col);
    if (zTop - zBottom <= EPS) continue;
    out.push(prismMesh(foot, zBottom, zTop, columnColor3d(project, col)));
  }
  return out;
}

/**
 * Trianguliert ein KONVEXES 3D-Polygon per Dreiecks-Fächer ab Vertex 0 und hängt
 * die Dreiecke an `positions`/`indices` an. `roofGeometry` (Vertrag in
 * `geometry/roof.ts`) liefert für `planes`/`gables` ausschliesslich konvexe
 * Polygone (Dreieck/Quader bei den meisten Formen, ein Fünfeck-Giebel bei
 * Mansarde) — ein Fächer trianguliert diese korrekt, ohne Ear-Clipping.
 */
function pushFanTriangles(positions: number[], indices: number[], pts: RoofVec3[]): void {
  if (pts.length < 3) return;
  const base = positions.length / 3;
  for (const p of pts) positions.push(p[0], p[1], p[2]);
  for (let i = 1; i < pts.length - 1; i++) indices.push(base, base + i, base + i + 1);
}

/**
 * Emittiert Dächer (`project.roofs`) als geschlossene Dreiecks-Meshes: sowohl die
 * geneigten Dachflächen (`RoofGeometry.planes`) als auch die Giebelflächen
 * (`RoofGeometry.gables`) — erst zusammen bilden sie einen von aussen
 * geschlossenen Körper (die Giebel schliessen die offenen Enden bei Sattel/
 * Mansarde, die First-/Grat-/Knicklinien sind reine Grundriss-Hilfslinien und
 * werden hier nicht gebraucht). Traufhöhe über {@link roofBaseElevation}
 * (Override oder Geschoss-Oberkante), Flächen über {@link roofGeometry}. Farbe:
 * `roof.color` (falls gültiges Hex), sonst {@link ROOF_RGB}. `positions` in
 * MODELL-Metern (x, y, z=Höhe) wie {@link emitOpeningGlass}/{@link emitMeshes};
 * render3d rendert Kontext-Meshes doppelseitig, die Winding-Reihenfolge ist also
 * unerheblich.
 */
function emitRoofs(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const roof of project.roofs ?? []) {
    const eavesZ = roofBaseElevation(project, roof);
    const g = roofGeometry(roof, eavesZ);
    const color = roof.color ? hexToRgb(roof.color, ROOF_RGB) : ROOF_RGB;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const plane of g.planes) pushFanTriangles(positions, indices, plane.pts);
    for (const gable of g.gables) pushFanTriangles(positions, indices, gable);
    if (indices.length === 0) continue;
    out.push({ positions, indices, kind: "extrusion", color });
  }
  return out;
}

/**
 * Emittiert die rohen Kontext-Meshes eines Projekts: Gelände-TINs (`terrainMesh`)
 * und importierte Volumen (`importedMesh`) aus `project.context`. `contourSet`
 * bleibt außen vor — das sind nur 2D-Linien (Höhenlinien/Footprints), keine
 * Dreiecksmeshes. Die `positions`/`indices` werden 1:1 durchgereicht (Modell-
 * Koordinaten, x,y,z=Höhe); render3d bildet sie selbst nach world ab.
 */
function emitMeshes(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const obj of project.context ?? []) {
    if (obj.type === "terrainMesh" || obj.type === "importedMesh") {
      // Leere/entartete Meshes überspringen (render3d würde sie ohnehin verwerfen).
      if (obj.positions.length < 9 || obj.indices.length < 3) continue;
      out.push({
        positions: obj.positions,
        indices: obj.indices,
        kind: obj.type === "terrainMesh" ? "terrain" : "imported",
        color: obj.type === "terrainMesh" ? TERRAIN_RGB : IMPORTED_RGB,
      });
    }
  }
  out.push(...emitExtrudedSolids(project));
  out.push(...emitColumns(project));
  out.push(...emitDrawingLines(project));
  return out;
}

// Faces eines Boxen-Quaders als Dreiecks-Indizes (Ecken-Index-Bits: bit0 =
// Achse from/to, bit1 = Höhe UK/OK, bit2 = Quer-Versatz nMin/nMax). Doppelseitig
// gerendert (append_context_mesh) ⇒ Winding egal; je Fläche 2 Dreiecke, 6
// Flächen = 12 Dreiecke. Gemeinsame Topologie für Glasscheiben UND Rahmen-/
// Sprossen-Riegel (s. {@link openingAxisBox}).
const OPENING_BOX_TRIS: number[] = [
  0, 1, 3, 0, 3, 2, // Quer-Versatz nMin
  4, 5, 7, 4, 7, 6, // Quer-Versatz nMax
  0, 1, 5, 0, 5, 4, // UK
  2, 3, 7, 2, 7, 6, // OK
  0, 2, 6, 0, 6, 4, // from
  1, 3, 7, 1, 7, 5, // to
];

/**
 * Baut EINEN geschlossenen Achsen-Quader (8 Ecken, 12 Dreiecke) für eine
 * Öffnung — die gemeinsame Basis von {@link emitOpeningGlass} (Scheiben) und
 * {@link emitOpeningFrames} (Rahmen-/Sprossen-Riegel). Achsen-Intervall
 * `[from,to]` (Meter ab `wall.start`, entlang der Wandrichtung u), Höhen-
 * Intervall `[zBottom,zTop]` (absolute Weltmeter) und Quer-Versatz-Intervall
 * `[nMin,nMax]` (Meter entlang der Grundriss-Normalen n=(uy,−ux), dieselbe
 * Konvention wie die bisherige Glas-Box — `nMin`/`nMax` MÜSSEN nicht sortiert
 * übergeben werden, die Box spannt zwischen beiden Werten). `positions` in
 * MODELL-Metern (x, y, z=Höhe) wie {@link emitMeshes}. Liefert `null` bei
 * entarteten Massen (Achse/Höhe/Dicke ≤ EPS) statt eines Nullquaders.
 */
function openingAxisBox(
  wall: Wall,
  from: number,
  to: number,
  zBottom: number,
  zTop: number,
  nMin: number,
  nMax: number,
  color: RRgb,
): RMesh | null {
  if (to - from <= EPS) return null;
  if (zTop - zBottom <= EPS) return null;
  if (Math.abs(nMax - nMin) <= EPS) return null;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Grundriss-Normale (Dicken-Achse) — dieselbe Konvention wie pushSegment.
  const nx = uy;
  const ny = -ux;
  const positions: number[] = [];
  for (let i = 0; i < 8; i++) {
    const s = i & 1 ? to : from;
    const z = i & 2 ? zTop : zBottom;
    const t = i & 4 ? nMax : nMin;
    positions.push(wall.start.x + ux * s + nx * t, wall.start.y + uy * s + ny * t, z);
  }
  return { positions, indices: [...OPENING_BOX_TRIS], kind: "imported", color };
}

/** Klemmt `v` auf `[lo,hi]`. */
function clampRange(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Rahmen-Tiefe quer zur Wand (Meter): `frameThickness` des Typs, sonst dessen
 * `frameDepth`, sonst die volle Wanddicke (Fallback, wenn der Typ keine
 * brauchbare Tiefe nennt). Beide Typ-Felder sind wörtlich Meter ≤ 0 ⇒ ungültig
 * (übersprungen, nächster Fallback greift).
 */
function resolveAcrossWallDepth(
  frameDepth: number | undefined,
  wallThickness: number,
): number {
  // Rahmen-Tiefe quer zur Wand: explizite `frameDepth` gewinnt, sonst füllt der
  // Rahmen die VOLLE Wanddicke (tiefe Laibung/Reveal). Das `frameThickness` ist
  // die Profil-Breite des Rahmenstabs (2D/Ansicht), NICHT die Einbautiefe — es
  // hier zu verwenden liess Fenster im 3D flach wirken (nur wenige cm tief).
  if (frameDepth !== undefined && frameDepth > EPS) return frameDepth;
  return wallThickness;
}

/**
 * Quer-Versatz-Intervall `[nMin,nMax]` (Meter entlang der Wand-Normalen, s.
 * {@link openingAxisBox}) des Rahmenkörpers — der 3D-Niederschlag des
 * Schichteinzugs (`insetFromFace`/`insetFace`): die Rahmen-VORDERKANTE liegt
 * bündig mit der gewählten Wandfläche, zurückversetzt um `insetFromFace`
 * (0/fehlt ⇒ bündig), der Rahmenkörper erstreckt sich von dort aus `depth`
 * Meter zur Wandmitte hin. "aussen" liegt an der POSITIVEN Normalen-Seite
 * (kleinster Schicht-Offset in {@link pushSegment}, s. dessen Kommentar zur
 * Aussenseiten-Konvention via `leftNormal`), "innen" an der negativen. Das
 * Ergebnis wird auf die halbe Wanddicke geklemmt — ein Schichteinzug darf den
 * Rahmen nie aus der Wand hinausschieben.
 */
function resolveFrameNormalRange(
  halfThickness: number,
  depth: number,
  insetFromFace: number,
  face: "aussen" | "innen",
): { nMin: number; nMax: number } {
  const sign = face === "innen" ? -1 : 1;
  const front = sign * (halfThickness - insetFromFace);
  const back = front - sign * depth;
  const a = clampRange(front, -halfThickness, halfThickness);
  const b = clampRange(back, -halfThickness, halfThickness);
  return { nMin: Math.min(a, b), nMax: Math.max(a, b) };
}

/**
 * Aufgelöste Rahmen-/Sprossen-Parameter EINER Öffnung (Tür oder Fenster) aus
 * ihrem {@link DoorType}/{@link WindowType} (via `getDoorType`/`getWindowType`).
 * `null`, wenn kein Typ auflösbar ist (`Opening.typeId` fehlt/verwaist) — DANN
 * emittieren weder {@link emitOpeningFrames} noch die Rahmen-/Sprossen-Logik in
 * {@link emitOpeningGlass} irgendetwas (Rückwärtskompatibilität: unveränderte
 * Alt-Darstellung, s. Moduldoc-Kommentar dort).
 */
interface OpeningFrameParams {
  /** Sichtbare Rahmen-/Flügelprofil-Breite in der Öffnungsebene (Meter). */
  frameWidth: number;
  /** Rahmen-Tiefe quer zur Wand (Meter, informativ — steckt bereits in nMin/nMax). */
  acrossWallDepth: number;
  /** Quer-Versatz-Intervall des Rahmenkörpers (s. {@link resolveFrameNormalRange}). */
  nMin: number;
  nMax: number;
  /** Oberlicht-Höhe (Meter); 0 = kein Oberlicht/Kämpfer. */
  transomHeight: number;
  /** Schwelle/Sohlbank zeichnen: Fenster immer, Tür nur mit `threshold`. */
  hasSill: boolean;
  /** Flügelzahl (vertikale Mittelpfosten = wingCount−1); Türen immer 1. */
  wingCount: number;
  /** Kämpfer-Zeilen (horizontale Teilung = mullionRows−1); Türen immer 1. */
  mullionRows: number;
  /** Ob eine Glasscheibe gezeichnet wird (Fenster immer, Tür nur `leafStyle: "glas"`). */
  glazed: boolean;
}

function resolveOpeningFrame(project: Project, wall: Wall, op: Opening): OpeningFrameParams | null {
  const wallThickness = wallThicknessSafe(project, wall);
  const halfThickness = wallThickness / 2;
  if (op.kind === "door") {
    const dt = getDoorType(project, op);
    if (!dt) return null;
    const acrossWallDepth = resolveAcrossWallDepth(dt.frameDepth, wallThickness);
    const { nMin, nMax } = resolveFrameNormalRange(
      halfThickness,
      acrossWallDepth,
      dt.insetFromFace ?? 0,
      dt.insetFace ?? "aussen",
    );
    return {
      frameWidth: dt.frameWidth ?? DEFAULT_FRAME_WIDTH,
      acrossWallDepth,
      nMin,
      nMax,
      transomHeight: Math.max(0, dt.transomHeight ?? 0),
      hasSill: dt.threshold === true,
      wingCount: 1,
      mullionRows: 1,
      glazed: dt.leafStyle === "glas",
    };
  }
  const wt = getWindowType(project, op);
  if (!wt) return null;
  const acrossWallDepth = resolveAcrossWallDepth(wt.frameDepth, wallThickness);
  const { nMin, nMax } = resolveFrameNormalRange(
    halfThickness,
    acrossWallDepth,
    wt.insetFromFace ?? 0,
    wt.insetFace ?? "aussen",
  );
  return {
    frameWidth: wt.frameWidth ?? DEFAULT_FRAME_WIDTH,
    acrossWallDepth,
    nMin,
    nMax,
    transomHeight: Math.max(0, wt.transomHeight ?? 0),
    hasSill: true,
    // Inline-Override `Opening.wingCount` gewinnt vor dem Typ-Default (analog
    // `windowSymbol` im 2D, das dieselbe Priorität kennt), sonst Typ, sonst 1.
    wingCount: Math.max(1, Math.round(op.wingCount ?? wt.wingCount ?? 1)),
    mullionRows: Math.max(1, Math.round(wt.mullionRows ?? 1)),
    glazed: true,
  };
}

/**
 * Rahmen-/Sprossen-Riegel EINER Öffnung: Pfosten (links/rechts, volle
 * Öffnungshöhe), Sturz (oben), Schwelle (nur wenn `params.hasSill`), optional
 * ein Kämpfer-Riegel (Oberlicht-Trennung, `transomHeight>0`) sowie die
 * Flügel-Mittelpfosten (`wingCount−1`, vertikal) und Kämpfer-Zeilen
 * (`mullionRows−1`, horizontal) im Flügel-Bereich zwischen Schwelle/Sturz
 * bzw. Schwelle/Kämpfer. Alle Riegel in {@link FRAME_RGB}.
 */
function frameMeshesForOpening(
  wall: Wall,
  iv: { from: number; to: number },
  vert: { zBottom: number; zTop: number },
  params: OpeningFrameParams,
  fine = true,
): RMesh[] {
  const out: RMesh[] = [];
  const fw = params.frameWidth;
  const push = (from: number, to: number, zBottom: number, zTop: number): void => {
    const mesh = openingAxisBox(wall, from, to, zBottom, zTop, params.nMin, params.nMax, FRAME_RGB);
    if (mesh) out.push(mesh);
  };
  // Pfosten (Laibungsseiten), über die volle Öffnungshöhe durchlaufend.
  push(iv.from, iv.from + fw, vert.zBottom, vert.zTop);
  push(iv.to - fw, iv.to, vert.zBottom, vert.zTop);
  // Sturz (oberer Riegel).
  push(iv.from + fw, iv.to - fw, vert.zTop - fw, vert.zTop);
  // Schwelle: Fenster immer, Tür nur mit Bodenanschlag (threshold).
  if (params.hasSill) push(iv.from + fw, iv.to - fw, vert.zBottom, vert.zBottom + fw);

  // Flügel-/Sash-Bereich zwischen Schwelle und Sturz, ggf. durch den Kämpfer
  // (Oberlicht-Trennung) oben beschnitten.
  const sashFrom = iv.from + fw;
  const sashTo = iv.to - fw;
  const sashBottom = vert.zBottom + (params.hasSill ? fw : 0);
  let sashTop = vert.zTop - fw;
  if (params.transomHeight > EPS) {
    const splitZ = clampRange(vert.zTop - params.transomHeight, sashBottom, sashTop);
    push(sashFrom, sashTo, splitZ - fw / 2, splitZ + fw / 2); // Kämpfer-Riegel
    sashTop = splitZ - fw / 2;
  }
  // Flügel-Mittelpfosten + Kämpfer-Zeilen (Sprossen) nur bei FEINEM Detailgrad —
  // bei „mittel" bleibt es beim reinen Rahmen (+ Oberlicht-Kämpfer oben).
  if (fine) {
    // Flügel-Mittelpfosten (vertikal, wingCount−1) im Sash-Bereich.
    if (params.wingCount > 1 && sashTo - sashFrom > EPS) {
      const cell = (sashTo - sashFrom) / params.wingCount;
      for (let i = 1; i < params.wingCount; i++) {
        const center = sashFrom + i * cell;
        push(center - fw / 2, center + fw / 2, sashBottom, sashTop);
      }
    }
    // Kämpfer-Zeilen (horizontal, mullionRows−1) im Sash-Bereich.
    if (params.mullionRows > 1 && sashTop - sashBottom > EPS) {
      const cell = (sashTop - sashBottom) / params.mullionRows;
      for (let i = 1; i < params.mullionRows; i++) {
        const center = sashBottom + i * cell;
        push(sashFrom, sashTo, center - fw / 2, center + fw / 2);
      }
    }
  }
  return out;
}

/**
 * Glasscheibe(n) EINER typisierten Öffnung (Fenster immer, Tür nur bei
 * `params.glazed`): eine Hauptscheibe im Flügel-Bereich (zwischen Schwelle und
 * Sturz bzw. Kämpfer), plus — bei `transomHeight>0` — eine ZWEITE Scheibe im
 * Oberlicht-Band oberhalb des Kämpfers. Die Sprossen/Mittelpfosten aus
 * {@link frameMeshesForOpening} liegen VOR dieser einen Hauptscheibe (keine
 * Pro-Feld-Aufteilung — bewusst einfach gehalten, s. Datei-weite Erläuterung).
 */
function glassPanesForOpening(
  wall: Wall,
  iv: { from: number; to: number },
  vert: { zBottom: number; zTop: number },
  params: OpeningFrameParams,
): RMesh[] {
  const out: RMesh[] = [];
  const fw = params.frameWidth;
  const sashFrom = iv.from + fw;
  const sashTo = iv.to - fw;
  const sashBottom = vert.zBottom + (params.hasSill ? fw : 0);
  const sashTopFull = vert.zTop - fw;
  // Die Scheibe ist eine DÜNNE Tafel NAHE der Aussenfläche (nMax = +n-Seite, s.
  // resolveFrameNormalRange) — mittig tief im Reveal wirkte sie schwach/kaum
  // sichtbar. Direkt hinter der Aussenkante (3 cm zurück) liest sich das Fenster
  // klar, die Laibung/Reveal-Tiefe zeigt nach innen.
  const glassThick = GLASS_HALF_THICK * 2;
  const gN1 = params.nMax - 0.03;
  const gN0 = Math.max(params.nMin, gN1 - glassThick);
  const push = (zBottom: number, zTop: number): void => {
    const mesh = openingAxisBox(wall, sashFrom, sashTo, zBottom, zTop, gN0, gN1, GLASS_RGB);
    if (mesh) out.push(mesh);
  };
  if (params.transomHeight > EPS) {
    const splitZ = clampRange(vert.zTop - params.transomHeight, sashBottom, sashTopFull);
    push(sashBottom, splitZ - fw / 2); // Hauptscheibe/-blatt unterhalb des Kämpfers.
    push(splitZ + fw / 2, sashTopFull); // Oberlicht-Scheibe oberhalb des Kämpfers.
  } else {
    push(sashBottom, sashTopFull);
  }
  return out;
}

/**
 * Emittiert je Fensteröffnung eine Glasscheibe (Türen nur bei glasfülligem
 * Blatt, `leafStyle: "glas"`) als rohes Quader-Mesh — damit Fenster im 3D als
 * Fenster lesbar sind statt als blosse Löcher in der Wand.
 *
 * OHNE auflösbaren Typ (`getWindowType`/`getDoorType` liefert `undefined`,
 * z. B. `Opening.typeId` fehlt): unverändertes ALT-Verhalten — EINE Vollscheibe
 * über die geklemmte Öffnungs-Achse ({@link openingInterval}) und -Höhe
 * ({@link openingVerticalExtent}), quer ±{@link GLASS_HALF_THICK} mittig in der
 * Wand (Rückwärtskompatibilität, s. Moduldoc-Kommentar).
 *
 * MIT Typ: die Scheibe(n) sitzen im Flügel-Bereich INNERHALB des Rahmens (s.
 * {@link glassPanesForOpening}), quer entlang des über den Schichteinzug
 * bestimmten Rahmen-Versatzes (s. {@link resolveFrameNormalRange}) statt fix
 * mittig — bei Oberlicht (`transomHeight>0`) kommt eine zweite Scheibe im
 * Oberlicht-Band dazu. Die zugehörigen Rahmen-/Sprossen-Riegel emittiert
 * separat {@link emitOpeningFrames} (eigene Farbe, eigene Funktion — leichter
 * einzeln zu testen/filtern als eine gemeinsame Emission).
 *
 * `positions` liegen — wie bei {@link emitMeshes} (Terrain/Import) — in MODELL-
 * Metern als flaches (x, y, z=Höhe)-Array; render3d bildet sie selbst nach world
 * (x, Höhe, y) ab und rendert die Meshes doppelseitig (append_context_mesh),
 * daher ist die Winding-Reihenfolge der Dreiecke unerheblich. `kind: "imported"`
 * mit gesetzter `color` ⇒ render3d zeichnet die Scheibe in GLASS_RGB.
 */
function emitOpeningGlass(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const wall of project.walls) {
    for (const op of openingsOfWall(project, wall.id)) {
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const vert = openingVerticalExtent(project, wall, op);
      if (vert.zTop - vert.zBottom <= EPS) continue;
      if (op.kind === "window") {
        const params = resolveOpeningFrame(project, wall, op);
        if (!params) {
          // Kein Typ auflösbar -> Alt-Verhalten (fixe Vollscheibe, mittig).
          const mesh = openingAxisBox(
            wall,
            iv.from,
            iv.to,
            vert.zBottom,
            vert.zTop,
            -GLASS_HALF_THICK,
            GLASS_HALF_THICK,
            GLASS_RGB,
          );
          if (mesh) out.push(mesh);
          continue;
        }
        out.push(...glassPanesForOpening(wall, iv, vert, params));
      } else {
        // Tür: nur bei glasfülligem Blatt eine Scheibe (Alt-Verhalten: offen).
        const params = resolveOpeningFrame(project, wall, op);
        if (params?.glazed) out.push(...glassPanesForOpening(wall, iv, vert, params));
      }
    }
  }
  return out;
}

/**
 * Emittiert je Öffnung MIT auflösbarem Typ ({@link getDoorType}/
 * {@link getWindowType}) die Rahmen-/Sprossen-Riegel (Zarge/Blendrahmen, Sturz,
 * Schwelle, Kämpfer, Mittelpfosten — s. {@link frameMeshesForOpening}) als rohe
 * Quader-Meshes in {@link FRAME_RGB}. Öffnungen OHNE auflösbaren Typ (`typeId`
 * fehlt/verwaist) bekommen KEINEN Rahmen — exakt das Alt-Verhalten vor der
 * Typ-Vertiefung (Rückwärtskompatibilität).
 */
function emitOpeningFrames(project: Project, detail: DetailLevel = "fein"): RMesh[] {
  // Grob: keine Rahmen/Sprossen — die Öffnung bleibt Loch + Scheibe (schlank).
  if (detail === "grob") return [];
  const fine = detail === "fein";
  const out: RMesh[] = [];
  for (const wall of project.walls) {
    for (const op of openingsOfWall(project, wall.id)) {
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const vert = openingVerticalExtent(project, wall, op);
      if (vert.zTop - vert.zBottom <= EPS) continue;
      const params = resolveOpeningFrame(project, wall, op);
      if (!params) continue;
      out.push(...frameMeshesForOpening(wall, iv, vert, params, fine));
    }
  }
  return out;
}

/**
 * Nur die Wände (Rückwärts-Kompatibilität / bestehende Aufrufer). Zerlegt Wände
 * mit Öffnungen in Teilquader.
 */
export function projectToWalls3d(project: Project, layered = true): RWall[] {
  const out: RWall[] = [];
  // Verschneidungs-Schnittlinien PRO GESCHOSS berechnen (wie generatePlan.ts sie
  // je Grundriss auf der gefilterten Wandmenge bildet) — nur für den layered-3D-
  // Pfad. Nach Geschoss gruppieren, damit deckungsgleiche Wände verschiedener
  // Geschosse (z. B. EG/OG an identischen XY-Knoten) NICHT fälschlich verschneiden.
  // Der Schnitt-Pfad (layered=false) bekommt KEINE Cuts (unverändert, seine
  // Dominanz macht toSection.ts). Anders als im 2D wird hier NICHT nach
  // Sichtbarkeit gefiltert — 3D zeigt alle Wände, alle nehmen an den Joins teil.
  const joins = layered ? computeJoinsByFloor(project) : undefined;
  for (const w of project.walls) emitWall(out, project, w, layered, joins?.get(w.id));
  return out;
}

/**
 * Berechnet {@link computeJoins} getrennt je Geschoss (`wall.floorId`) und führt
 * die Ergebnis-Maps zu einer flachen `wallId → WallCuts` zusammen. So bilden nur
 * Wände desselben Geschosses gemeinsame Ecken/T-Stösse (identisch zur 2D-Semantik,
 * wo `generatePlan` je Grundriss aufruft).
 */
function computeJoinsByFloor(project: Project): Map<string, WallCuts> {
  const byFloor = new Map<string, Wall[]>();
  for (const w of project.walls) {
    const key = w.floorId ?? "";
    const list = byFloor.get(key);
    if (list) list.push(w);
    else byFloor.set(key, [w]);
  }
  const merged = new Map<string, WallCuts>();
  for (const walls of byFloor.values()) {
    const cuts = computeJoins(project, walls);
    for (const [id, wc] of cuts) merged.set(id, wc);
  }
  return merged;
}

/**
 * Optionen für {@link projectToModel3d}. `layeredWalls` steuert, ob eine
 * mehrschichtige Wand als eigene Box je Materiallage (Default, 3D-Viewer) oder
 * als EINE Voll-Box über die ganze Dicke emittiert wird. Der Schnitt-Pfad
 * (`computeSection`) setzt `false`, damit die Cut-Polygone 1:1 zur Wand liegen
 * (die Schicht-Zerlegung macht dort `splitWallLayers` TS-seitig) — sonst
 * verschöben die per-Lage vervielfachten Boxen die `ComponentRef.index`
 * gegenüber `wallSegmentOwners` und die materialspezifische Schnitt-Schraffur
 * ginge verloren.
 */
export interface Model3dOptions {
  layeredWalls?: boolean;
  /**
   * Detailgrad der Öffnungs-Darstellung im 3D (wie im 2D-Grundriss):
   *  • "grob"  — keine Rahmen/Sprossen (nur Loch + Scheibe).
   *  • "mittel"— Rahmen (Pfosten/Sturz/Schwelle) + ggf. Kämpfer, keine Sprossen.
   *  • "fein"  — zusätzlich Flügel-Mittelpfosten + Kämpfer-Zeilen (Sprossen).
   * Fehlt es, gilt "fein" (= bisheriges Verhalten, volle Details).
   */
  detail?: DetailLevel;
}

/** Das volle 3D-Modell: Wände (mit Öffnungen) + Deckenplatten + Kontext-Meshes. */
export function projectToModel3d(project: Project, opts: Model3dOptions = {}): RModel3d {
  const layered = opts.layeredWalls ?? true;
  const detail = opts.detail ?? "fein";
  return {
    walls: projectToWalls3d(project, layered),
    // Decken + Treppen (Treppentritte als extrudierte Slabs) — so wird die Treppe
    // auch im WASM/wgpu-Renderer sichtbar (der three.js-Pfad rendert sie separat).
    slabs: [...emitSlabs(project), ...emitStairs(project)],
    // Kontext-Meshes (Terrain/Import) + Fenster-/Tür-Glasscheiben (eigenes Mesh
    // je Scheibe) + Rahmen-/Sprossen-Riegel typisierter Öffnungen (Zarge/
    // Blendrahmen/Kämpfer/Mittelpfosten, s. emitOpeningFrames) + glatte Beton-
    // Laufplatten (gerade Betontreppen als Mesh) + Dachflächen/-giebel
    // (s. emitRoofs) — pickGeometry/Highlight nutzen `meshes` bewusst NICHT (man
    // wählt Wand/Öffnung/Treppe; Treppen-Pick läuft über die pickGeometry-Boxen).
    meshes: [
      ...emitMeshes(project),
      ...emitOpeningGlass(project),
      ...emitOpeningFrames(project, detail),
      ...emitStairMeshes(project),
      ...emitRoofs(project),
    ],
  };
}

/**
 * Pick-Geometrie für den TS-seitigen 3D-Raycast (siehe viewport/raycast3d): die
 * Wand-Teilquader (mit `wallId`) und Decken-Prismen (mit `ceilingId`) desselben
 * geflachten Modells wie {@link projectToModel3d}, aber ohne die Kontext-Meshes
 * (die sind für die Bauteil-Auswahl irrelevant), PLUS die Öffnungs- (Fenster/
 * Türen) und Treppen-Boxen fürs Raycast-Picking. Reine TS-Nutzung — geht NICHT
 * an render3d; die Records tragen dieselben Geometriefelder wie die Serde-
 * Payload, plus die Ids fürs Picking.
 */
export function pickGeometry(
  project: Project,
): { walls: RWall[]; slabs: RSlab[]; openings: PickOpening[]; stairs: PickStair[] } {
  const openings: PickOpening[] = [];
  for (const o of project.openings ?? []) {
    const wall = project.walls.find((w) => w.id === o.hostWallId);
    if (!wall) continue;
    const jambs = openingJambs(wall, o);
    if (!jambs) continue;
    const thickness = wallTypeThickness(getWallType(project, wall));
    const { zBottom, zTop } = openingVerticalExtent(project, wall, o);
    if (zTop - zBottom <= 0) continue;
    openings.push({
      start: [jambs.jambStart.x, jambs.jambStart.y],
      end: [jambs.jambEnd.x, jambs.jambEnd.y],
      thickness,
      height: zTop - zBottom,
      baseElevation: zBottom,
      openingId: o.id,
    });
  }
  const stairs: PickStair[] = [];
  for (const st of project.stairs ?? []) {
    const { zBottom, zTop } = stairVerticalExtent(project, st);
    const totalRise = zTop - zBottom;
    if (totalRise <= 0) continue;
    const bbox = stairBBox(stairGeometry(st, totalRise));
    stairs.push({
      outline: [
        [bbox.minX, bbox.minY],
        [bbox.maxX, bbox.minY],
        [bbox.maxX, bbox.maxY],
        [bbox.minX, bbox.maxY],
      ],
      zBottom,
      zTop,
      stairId: st.id,
    });
  }
  return { walls: projectToWalls3d(project), slabs: emitSlabs(project), openings, stairs };
}

/**
 * Baut die Highlight-Linien der aktuellen 3D-Auswahl (Wand-/Decken-Ids) als
 * flaches LineList-Vertex-Array `[px,py,pz,r,g,b, ...]` (world-Meter, je 2
 * Vertices = 1 Kante) — genau das Format, das `set_highlight_lines` erwartet
 * (immer obenauf gezeichnete Akzent-Umrisslinie, s. useWasm3dRenderer). Leere
 * Auswahl → leeres Array (Highlight löschen).
 *
 * GEOMETRIE (dieselbe Welt-Konvention wie pickGeometry/raycast3d: model (x,y)
 * → world (x, elevation, y), Höhe entlang +Y):
 *  • Wand: derselbe orientierte Quader wie `rayWallBox` (raycast3d.ts) — Achse
 *    entlang der Wandlänge, Normale (Dicke) senkrecht dazu in der XZ-Ebene,
 *    Y = Höhe. Aus den 8 Ecken werden die 12 Kanten des Quaders emittiert.
 *    Wände MIT Öffnungen bestehen aus mehreren Teilquadern (Pfeiler/Brüstung/
 *    Sturz, s. emitWall) — alle tragen dieselbe `wallId` und werden hier ALLE
 *    umrandet, sodass Öffnungsränder mit hervorgehoben werden.
 *  • Decke: der Umriss oben (zTop) und unten (zBottom) je als geschlossener
 *    Kantenzug, plus eine vertikale Kante an jeder Umriss-Ecke.
 *
 * Kanten werden EINFACH (nicht versetzt/doppelt) ausgegeben — eine zweite,
 * leicht verschobene Kopie je Linie (für optisch "breitere" Linien bei
 * WebGPU-Linienbreite 1) würde die Vertexzahl verdoppeln und die Achse/Betrag
 * des Versatzes müsste in Bildschirm- statt Weltraum berechnet werden (hängt
 * von Kamera-Distanz/-Winkel ab) — außerhalb des schmalen TS-Rahmens dieser
 * Funktion. Der Renderer kann das bei Bedarf selbst tun (Rust-seitige
 * Linienbreite/Shader), ohne dass sich dieses Vertexformat ändert.
 */
export function selectionHighlightLines(
  project: Project,
  wallIds: string[],
  ceilingIds: string[],
  rgb: RRgb,
  openingIds: string[] = [],
  stairIds: string[] = [],
): Float32Array {
  if (
    wallIds.length === 0 &&
    ceilingIds.length === 0 &&
    openingIds.length === 0 &&
    stairIds.length === 0
  ) {
    return new Float32Array(0);
  }
  const { walls, slabs, openings, stairs } = pickGeometry(project);
  const wallSet = new Set(wallIds);
  const ceilingSet = new Set(ceilingIds);
  const openingSet = new Set(openingIds);
  const stairSet = new Set(stairIds);
  const out: number[] = [];
  const pushEdge = (a: RVec3, b: RVec3) => {
    out.push(a[0], a[1], a[2], rgb[0], rgb[1], rgb[2]);
    out.push(b[0], b[1], b[2], rgb[0], rgb[1], rgb[2]);
  };
  // 12 Kanten eines Quaders aus 8 Ecken (Ecken-Index-Bits: bit0=Achse,
  // bit1=Höhe, bit2=Dicke — je zwei Ecken, die sich in genau einem Bit
  // unterscheiden, bilden eine Kante).
  const BOX_EDGES: Array<[number, number]> = [
    [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
    [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
  ];
  // Orientierter Quader (Wand ODER Öffnung: gleiche Felder start/end/thickness/
  // height/baseElevation) → seine 12 Kanten.
  const boxEdges = (b: {
    start: readonly [number, number];
    end: readonly [number, number];
    thickness: number;
    height: number;
    baseElevation: number;
  }) => {
    const ax = b.end[0] - b.start[0];
    const az = b.end[1] - b.start[1];
    const len = Math.hypot(ax, az);
    if (len < EPS || b.height <= EPS || b.thickness <= EPS) return;
    const axis: RVec3 = [ax / len, 0, az / len];
    const normal: RVec3 = [az / len, 0, -ax / len];
    const halfLen = len / 2;
    const halfHeight = b.height / 2;
    const halfThick = b.thickness / 2;
    const center: RVec3 = [
      (b.start[0] + b.end[0]) / 2,
      b.baseElevation + b.height / 2,
      (b.start[1] + b.end[1]) / 2,
    ];
    const corners: RVec3[] = [];
    for (let i = 0; i < 8; i++) {
      const sL = i & 1 ? 1 : -1;
      const sH = i & 2 ? 1 : -1;
      const sT = i & 4 ? 1 : -1;
      corners.push([
        center[0] + sL * halfLen * axis[0] + sT * halfThick * normal[0],
        center[1] + sH * halfHeight,
        center[2] + sL * halfLen * axis[2] + sT * halfThick * normal[2],
      ]);
    }
    for (const [i, j] of BOX_EDGES) pushEdge(corners[i], corners[j]);
  };
  // Vertikales Prisma (Decke ODER Treppen-Fussabdruck) → Umriss oben/unten + Ecken.
  const prismEdges = (outline: ReadonlyArray<readonly [number, number]>, zBottom: number, zTop: number) => {
    const n = outline.length;
    if (n < 3 || zTop - zBottom <= EPS) return;
    const bottom: RVec3[] = outline.map((p) => [p[0], zBottom, p[1]]);
    const top: RVec3[] = outline.map((p) => [p[0], zTop, p[1]]);
    for (let i = 0, j = n - 1; i < n; j = i++) {
      pushEdge(bottom[j], bottom[i]);
      pushEdge(top[j], top[i]);
    }
    for (let i = 0; i < n; i++) pushEdge(bottom[i], top[i]);
  };
  for (const w of walls) if (wallSet.has(w.wallId)) boxEdges(w);
  for (const o of openings) if (openingSet.has(o.openingId)) boxEdges(o);
  for (const s of slabs) if (ceilingSet.has(s.ceilingId)) prismEdges(s.outline, s.zBottom, s.zTop);
  for (const st of stairs) if (stairSet.has(st.stairId)) prismEdges(st.outline, st.zBottom, st.zTop);
  return new Float32Array(out);
}
