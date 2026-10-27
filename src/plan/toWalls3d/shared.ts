// Gemeinsame Grundlage der 3D-Ableitung: das Serde-Vokabular (`RWall`/`RSlab`/
// `RMesh`/…, matcht 1:1 render3d::types) sowie die Farb-/Schraffur-/Material-
// Auflösung, die über mehrere Bauteil-Domänen hinweg identisch gelten muss
// (Hex→RGB, dominante Schicht, Schnitt-Schraffur, Material-Textur-Ebene).
//
// Jede Datei unter `toWalls3d/` importiert von hier, NIE von `../toWalls3d`
// selbst — das hielte die Orchestrator-Datei (`toWalls3d.ts`) andernfalls in
// einem Zirkelimport mit jeder einzelnen Domäne.

import type { HatchPattern, Layer, Project } from "../../model/types";
import { getCeilingType, getComponent, getWallType, roofLayers } from "../../model/types";
import { resolveHatch } from "../generatePlan";
import type { Vec3 as RoofVec3 } from "../../geometry/roof";

export type RVec2 = [number, number];
export type RRgb = [number, number, number];

/**
 * Eine aufgelöste Wandschicht: Dicke + 3D-Albedo-Farbe (aus dem Component).
 * Wird seit der TS-seitigen Schicht-Zerlegung (Option B, siehe toWalls3d.ts-
 * Moduldoc) NICHT mehr an render3d durchgereicht — jede Schicht ist eine eigene
 * Voll-Box; das `RWall.layers`-Feld bleibt für Serde-Kompatibilität, aber stets leer.
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
  /**
   * Nur TS-intern: Grundwinkel der Schraffur (SVG-Konvention, vor Wandbezug) und ob das Muster
   * der Wandachse folgt (`relativeToWall`). `pushSegment` leitet daraus {@link topAngle} ab.
   */
  baseAngle?: number;
  relativeToWall?: boolean;
  /**
   * Musterdrehung (Grad, Modell-Winkel gegen den Uhrzeigersinn) für die Wand-OBERSEITE in der
   * Draufsicht — wie im 2D-Grundriss relativ zur Wandachse (render3d::Hatch.topAngle).
   */
  topAngle?: number;
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
 * render3d-relevanten Felder werden direkt aus dem `HatchStyle` gezogen, die
 * Farbe bleibt monochrom im Shader). `undefined`, wenn das Bauteil/die Schraffur
 * nicht auflösbar ist (der Cap-Shader fällt dann auf sein Diagonalmuster zurück).
 */
export function resolveComponentHatch(
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
    // Wandbezug für die Draufsicht: Grundwinkel + ob das Muster der Wandachse folgt.
    const abs = resolveHatch(project, comp.hatchId, undefined);
    const relativeToWall = resolveHatch(project, comp.hatchId, 90).angle !== abs.angle;
    return {
      pattern: hatchPatternId(hr.pattern),
      angle: hr.angle,
      scale: hr.scale,
      lineWeight: hr.lineWeight,
      baseAngle: abs.angle,
      relativeToWall,
    };
  } catch {
    return undefined;
  }
}

/**
 * Schnitt-Schraffur der dicksten (dominanten) Schicht eines Schichtstapels.
 * `axisAngleDeg` wie {@link resolveComponentHatch} (90 für Wand, undefined für Decke).
 */
export function dominantLayerHatch(
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
 * JS-Decoder (`viewport/materialTextures`) verwenden — so stimmen Band-Index und
 * hochgeladene Textur-Ebene ohne separaten Map-Transport überein. Memoisiert je
 * Projekt-REFERENZ (der Store ist immutabel — jede Änderung liefert ein neues
 * Objekt, also kein Stale-Risiko), damit die per-Band-Auflösung nicht quadratisch wird.
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
  for (const r of project.roofs ?? []) {
    for (const l of roofLayers(project, r)) {
      if (l.componentId) consider(l.componentId);
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
export function resolveComponentMaterialLayer(project: Project, componentId: string): number | undefined {
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
  /**
   * Absenkung der Oberkante (Meter ≥ 0) am Anfang / Ende der Box: die Oberseite ist eine
   * schräge Ebene — Wand unter einer Dachfläche, bündig an deren Unterkante. Fehlt = flach.
   * Nur für Boxen ohne Löcher/Öffnungen (render3d `WallInput::top_drop`).
   */
  topDrop?: [number, number];
  color: RRgb;
  /**
   * Immer leer: die Schichten werden TS-seitig in eigene Voll-Boxen zerlegt
   * (Option B, siehe toWalls3d.ts-Moduldoc). Feld bleibt nur zur Serde-
   * Kompatibilität mit render3d::WallInput (leer ⇒ Vollkörper-Extrusion in `color`).
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
   * {@link RHole}). Nur im 3D-Viewer-Pfad (`projectToModel3d` mit
   * `layeredWalls:true`) gesetzt: dort emittiert `emitWall` EINEN RWall pro
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
  /**
   * Monolith-Gruppe (z. B. Treppen-ID einer massiven/Beton-Treppe): Prismen
   * derselben Gruppe verdecken sich im Schnitt auch bei gleicher Tiefe —
   * render3d `SlabInput::monolith`.
   */
  monolith?: string;
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
  /** Optionale Pro-Vertex-Albedo (flach `[r,g,b, …]`, 0..1) — ein Wert je
   *  Positions-Vertex. Damit wird z. B. ein SWISSIMAGE-Luftbild aufs Gelände-TIN
   *  „drapiert" (jeder Vertex trägt seinen Bildpunkt). Fehlt/zu kurz -> `color`
   *  fürs ganze Mesh. Matcht `render3d::types::MeshInput.vertexColors`. */
  vertexColors?: number[];
  /** Material-Textur-Ebene (1-basiert, siehe {@link wallMaterialColorMaps}) für
   *  den Stil „Textured" — bislang nur von Dach-Schichten gesetzt. Fehlt sie,
   *  zeigt render3d das Fallback-Schachbrett. Matcht
   *  `render3d::types::MeshInput.materialIndex`. */
  materialIndex?: number;
}

/**
 * EINE Dachflächen-Schicht für den 3D-Live-Schnitt (`render3d::types::
 * RoofLayerInput`/`roof_cut::cut_roof_layer`) — GETRENNT vom Render-Mesh
 * ({@link RMesh}, `kind:"extrusion"`), weil `section.rs` kein beliebiges
 * Dreiecksnetz schneiden kann (nur Wand-Boxen/Decken-Polygone, s. dessen
 * Moduldoc „jedes Bauteil ist ein vertikales Prisma"). Eine Dachfläche ist
 * KEIN vertikales Prisma (geneigtes Polygon, entlang der eigenen Normalen
 * statt vertikal extrudiert) — daher dieser eigene, parallele Eingabetyp statt
 * Wiederverwendung von `RWall`/`RSlab`.
 */
export interface RRoofLayer {
  /** Eckpunkte der OBERSEITE dieser Schicht (näher am First/aussen), Welt-Meter. */
  polygon: RoofVec3[];
  /** Nach aussen/oben zeigende Flächennormale (normalisiert) — identisch zu
   *  der Normalen, mit der {@link RMesh} für dieselbe Schicht gebaut wird
   *  (`planeNormalUp`), damit Render-Mesh und Schnitt-Geometrie nicht
   *  auseinanderlaufen. */
  normal: RoofVec3;
  /** Schichtdicke (Meter), Extrusion entlang `-normal`. */
  thickness: number;
  color: RRgb;
  hatch?: RHatch;
  cut?: RCutMeta;
}

/** Modell-Bündel für den nativen 3D-Renderer (Wände + Decken + Kontext-Meshes). */
export interface RModel3d {
  walls: RWall[];
  slabs: RSlab[];
  meshes: RMesh[];
  /** Dach-Schichten für den Live-Schnitt (s. {@link RRoofLayer}) — separat von
   *  `meshes`, da render3d sie über einen eigenen Pfad schneidet. */
  roofLayers: RRoofLayer[];
}

/** Warmer, neutraler Wand-Grundton (wie render3d default). */
export const WALL_RGB: RRgb = [0.82, 0.8, 0.76];
/** Etwas hellerer, kühlerer Ton für Deckenplatten (heben sich von Wänden ab). */
export const SLAB_RGB: RRgb = [0.86, 0.86, 0.88];
/** Gedämpftes Lehm-/Geländegrün-grau (three.js mats.terrain = 0xa9b0a2). */
export const TERRAIN_RGB: RRgb = [169 / 255, 176 / 255, 162 / 255];
/** Neutrales Hellgrau für importierte Meshes (three.js mats.mesh = 0x9fa6ae). */
export const IMPORTED_RGB: RRgb = [159 / 255, 166 / 255, 174 / 255];
/** Fallback-Farbe für 2D-Zeichnungen ohne color/lineStyle/Kategorie (wie drawing2DColor in Viewport3D.tsx, "#888888"). */
export const DRAWING_LINE_FALLBACK_RGB: RRgb = [0x88 / 255, 0x88 / 255, 0x88 / 255];

/** Ignoriere entartete vertikale Ausschnitte (Rundungsrauschen). */
export const EPS = 1e-4;

/**
 * Wandelt eine Hex-Farbe ("#rrggbb", Component-Farbe im Plan) in float-RGB
 * (0..1, render3d-Konvention) um. Ungültiges/fehlendes Format fällt auf den
 * neutralen Wand-Grundton zurück (nie ein hartes Fehlbild).
 */
export function hexToRgb(hex: string, fallback: RRgb = WALL_RGB): RRgb {
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
export function dominantLayerColor(layers: Layer[], project: Project, fallback: RRgb): RRgb {
  if (layers.length === 0) return fallback;
  const dominant = layers.reduce((best, l) => (l.thickness > best.thickness ? l : best));
  try {
    return hexToRgb(getComponent(project, dominant.componentId).color, fallback);
  } catch {
    return fallback;
  }
}

/**
 * Löst den Schnitt-UMRISSLINIEN-Stil einer Schicht aus ihrem
 * `Layer.jointLineStyleId` (LineStyle) auf: Farbe (hex→RGB 0..1) + Strichstärke
 * (mm-Papier) — dieselbe Quelle wie die 2D-Schichtfuge (`generatePlan/walls.ts`).
 * Fehlt der Verweis/LineStyle, `undefined` (der 3D-Cut fällt dann auf seinen
 * Default-Schnittkanten-Stil zurück, siehe `section_fill::build_cut_cap_lines`).
 * Bewusst tolerant (`find` statt `getLineStyle`), wie im 2D — ein verwaister
 * Verweis darf den 3D-Push nicht werfen. Von {@link ../bands.resolveWallBands}
 * UND `../ceilings.emitSlabs` genutzt (Wand- wie Deckenschicht teilen dieselbe
 * Fugen-Auflösung).
 */
export function resolveCutLineStyle(
  project: Project,
  jointLineStyleId: string | undefined,
): { color?: RRgb; weight?: number } | undefined {
  if (!jointLineStyleId) return undefined;
  const ls = project.lineStyles.find((l) => l.id === jointLineStyleId);
  if (!ls) return undefined;
  return { color: hexToRgb(ls.color, DRAWING_LINE_FALLBACK_RGB), weight: ls.weight };
}
