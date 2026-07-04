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

import type { Project, Wall, Ceiling, Layer } from "../model/types";
import {
  getComponent,
  getWallType,
  getCeilingType,
  wallTypeThickness,
  openingsOfWall,
} from "../model/types";
import { wallVerticalExtent, ceilingVerticalExtent } from "../model/wall";
import { openingInterval, openingVerticalExtent } from "../geometry/opening";

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
}

/** Art eines rohen Kontext-Meshes (bestimmt in render3d die Default-Einfärbung). */
export type RMeshKind = "terrain" | "imported";

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
/** Helles, leicht bläuliches Fenster-Glas (Scheibe in der Öffnung). */
const GLASS_RGB: RRgb = [0.62, 0.76, 0.85];
/** Halbe Dicke der Fensterscheibe (Meter) — sehr dünn, mittig in der Wand. */
const GLASS_HALF_THICK = 0.01;

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
function resolveWallBands(project: Project, wall: Wall): WallBand[] {
  try {
    const wt = getWallType(project, wall);
    if (wt.layers.length > 0) {
      // Gesamtdicke = Summe der Lagen (konsistent mit den Offsets); wenn diese
      // von wallTypeThickness abwiche, gewinnt die Lagen-Summe (keine Lücken).
      const total = wt.layers.reduce((s, l) => s + l.thickness, 0);
      const bands: WallBand[] = [];
      let prefix = 0;
      for (const l of wt.layers) {
        const color = hexToRgb(getComponent(project, l.componentId).color);
        bands.push({ thickness: l.thickness, color, offset: -total / 2 + prefix + l.thickness / 2 });
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
): void {
  if (to - from <= EPS) return;
  if (zTop - zBottom <= EPS) return;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return;
  const ux = dx / len;
  const uy = dy / len;
  // Grundriss-Normale (identisch zur Dicken-Achse in raycast3d /
  // selectionHighlightLines: n = (uy, −ux)). Der Schicht-Versatz verschiebt
  // Start/Ende der Box quer zur Wand, sodass render3d/raycast die Box um ihre
  // eigene (versetzte) Achse zentriert aufbaut.
  const ox = uy * normalOffset;
  const oy = -ux * normalOffset;
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
 * Repräsentative `joinPriority` einer Wand (höchste ihrer Schichten) — analog
 * `wallRepresentativePriority` in `toSection.ts` (2D-Schnitt-Dominanz), hier
 * fürs 3D-Trim gegen überlappende Decken (s. {@link trimWallTopForCeilings}).
 * `undefined`, wenn kein WallType/keine Schicht auflösbar ist (dann findet nie
 * ein Trim statt — konservativ, kein Verhaltensbruch für unbekannte Typen).
 */
function wallDominantPriority(project: Project, wall: Wall): number | undefined {
  try {
    const wt = getWallType(project, wall);
    let best: number | undefined;
    for (const layer of wt.layers) {
      const p = getComponent(project, layer.componentId).joinPriority;
      if (best === undefined || p > best) best = p;
    }
    return best;
  } catch {
    return undefined;
  }
}

/**
 * Repräsentative `joinPriority` einer Decke (höchste ihrer Schichten, analog
 * {@link wallDominantPriority}) — bestimmt, ob die Decke am Wand/Decke-Stoss
 * "durchläuft" (gewinnt) und die Wand kappt.
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
 * Kappt `zTop` einer Wand an der Unterkante jeder überlappenden Decke mit
 * HÖHERER `joinPriority` (Prioritäts-Join, Phase 3 — behebt das Wand/Decke-
 * Z-Fighting aus `wallVerticalExtent`/`ceilingVerticalExtent`, s. Moduldoc):
 * wächst `wall.height` bis zur Deckenoberkante (Standardfall, häufig bündig
 * mit dem Geschoss-Wandkopf) und die Decke wächst vom selben Z nach unten, so
 * überlappen sich beide Volumen exakt über die Deckendicke im Wand-Footprint.
 * Gewinnt die Decke (höhere Priorität), endet die Wand VOR der Deckenunterkante
 * statt sie zu durchdringen.
 *
 * Kriterien je Decke (alle müssen zutreffen, sonst kein Effekt):
 *  • dasselbe Geschoss (`ceiling.floorId === wall.floorId`),
 *  • vertikale Überlappung mit der (ungekappten) Wand-Ausdehnung,
 *  • grober Footprint-Überlapp (Bounding-Box, s. {@link boundsOverlap}) —
 *    KEIN exakter Polygon-Test; eine Decke, deren Umriss die Wand nur knapp
 *    berührt/verfehlt, kann so fälschlich als überlappend gelten. Das ist eine
 *    bekannte Restlücke (siehe Moduldoc-Kommentar in dieser Datei): für den
 *    Regelfall (Decken-Umriss = Gebäude-/Raumgrundriss inkl. Wand-Footprints)
 *    ist die Bounding-Box exakt genug, um das Haupt-Z-Fighting zu beheben.
 *  • Decke hat eine HÖHERE (strikt) repräsentative `joinPriority` als die Wand.
 *
 * Bei mehreren qualifizierenden Decken gewinnt die NIEDRIGSTE Deckenunterkante
 * (kappt am weitesten). Ohne auflösbare Wand-Priorität (unbekannter WallType)
 * bleibt `zTop` unverändert (konservativ, wie heute).
 */
function trimWallTopForCeilings(
  project: Project,
  wall: Wall,
  zBottom: number,
  zTop: number,
): number {
  const wallPriority = wallDominantPriority(project, wall);
  if (wallPriority === undefined) return zTop;
  const halfThickness = wallThicknessSafe(project, wall) / 2;
  const wallBounds = wallFootprintBounds(wall, halfThickness);
  let top = zTop;
  for (const c of project.ceilings ?? []) {
    if (c.floorId !== wall.floorId) continue;
    if (!c.outline || c.outline.length < 3) continue;
    const cExtent = ceilingVerticalExtent(project, c);
    // Keine vertikale Überlappung mit der (ungekappten) Wand-Ausdehnung -> Decke
    // liegt komplett ausserhalb des Wandkörpers, betrifft ihn nicht.
    if (cExtent.zBottom >= zTop - EPS || cExtent.zTop <= zBottom + EPS) continue;
    const ceilingPriority = ceilingDominantPriority(project, c);
    if (ceilingPriority === undefined || ceilingPriority <= wallPriority) continue;
    if (!boundsOverlap(wallBounds, outlineBounds(c.outline))) continue;
    if (cExtent.zBottom < top) top = cExtent.zBottom;
  }
  return Math.max(zBottom, top);
}

/** Emittiert die Teilquader EINER Wand (mit oder ohne Öffnungen). */
function emitWall(out: RWall[], project: Project, wall: Wall): void {
  const bands = resolveWallBands(project, wall);
  const { zBottom, zTop: rawZTop } = wallVerticalExtent(project, wall);
  const zTop = trimWallTopForCeilings(project, wall, zBottom, rawZTop);
  const axisLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  if (axisLen < 1e-9 || zTop - zBottom <= EPS) return;

  // Ein Achsen-Teilquader × jede Materiallage = eine Box (Schichtstapel quer
  // zur Wanddicke). Alle tragen die Wand-Id, sodass ein Klick auf irgendeine
  // Schicht die GANZE Wand selektiert und das Highlight alle Bänder umrandet.
  const emitSeg = (from: number, to: number, zb: number, zt: number): void => {
    for (const b of bands) {
      pushSegment(out, wall, from, to, zb, zt, b.thickness, b.offset, b.color, wall.id);
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

  // Ohne Aussparungen: ein durchgehender Quader je Schicht (wie bisher, aber
  // in Lagen aufgeteilt).
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

/** Emittiert die Deckenplatten eines Projekts (falls vorhanden). */
function emitSlabs(project: Project): RSlab[] {
  const out: RSlab[] = [];
  for (const c of project.ceilings ?? []) {
    if (!c.outline || c.outline.length < 3) continue;
    // zBottom/zTop (und damit die Deckendicke) berechnet ceilingVerticalExtent
    // bereits über ceilingThickness (respektiert Typ-Dicke + Übersteuerung).
    const { zBottom, zTop } = ceilingVerticalExtent(project, c);
    if (zTop - zBottom <= EPS) continue;
    // Repräsentative Farbe = dickste Schicht des Deckentyps (analog Wände);
    // kein auflösbarer Deckentyp ⇒ SLAB_RGB-Fallback.
    let color: RRgb = SLAB_RGB;
    try {
      color = dominantLayerColor(getCeilingType(project, c).layers, project, SLAB_RGB);
    } catch {
      color = SLAB_RGB;
    }
    out.push({
      outline: c.outline.map((p) => [p.x, p.y] as RVec2),
      zBottom,
      zTop,
      color,
      ceilingId: c.id,
    });
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
  return out;
}

/**
 * Emittiert je Fensteröffnung eine dünne Glasscheibe als rohes Quader-Mesh —
 * damit Fenster im 3D als Fenster lesbar sind statt als blosse Löcher in der
 * Wand. Nur `kind === "window"`; Türen bleiben offen (keine Scheibe).
 *
 * Für jede Scheibe wird ein geschlossener Quader (8 Ecken, 12 Dreiecke) gebaut:
 *   • entlang der Wandachse: das geklemmte Öffnungs-Intervall (openingInterval),
 *   • vertikal: die absolute Öffnungs-Ausdehnung (openingVerticalExtent, also
 *     UK = baseElevation+sillHeight … OK = +height, an den Wandkopf geklemmt) —
 *     exakt der Bereich, den emitWall als Loch freilässt,
 *   • quer zur Wand: ±GLASS_HALF_THICK um die Wandachse (mittig in der Dicke).
 *
 * `positions` liegen — wie bei {@link emitMeshes} (Terrain/Import) — in MODELL-
 * Metern als flaches (x, y, z=Höhe)-Array; render3d bildet sie selbst nach world
 * (x, Höhe, y) ab und rendert die Meshes doppelseitig (append_context_mesh),
 * daher ist die Winding-Reihenfolge der Dreiecke unerheblich. `kind: "imported"`
 * mit gesetzter `color` ⇒ render3d zeichnet die Scheibe in GLASS_RGB.
 */
function emitOpeningGlass(project: Project): RMesh[] {
  // Faces eines Boxen-Quaders als Dreiecks-Indizes (Ecken-Index-Bits:
  // bit0 = Achse from/to, bit1 = Höhe UK/OK, bit2 = Dicke −/+). Doppelseitig
  // gerendert ⇒ Winding egal; je Fläche 2 Dreiecke, 6 Flächen = 12 Dreiecke.
  const BOX_TRIS: number[] = [
    0, 1, 3, 0, 3, 2, // Dicke −
    4, 5, 7, 4, 7, 6, // Dicke +
    0, 1, 5, 0, 5, 4, // UK
    2, 3, 7, 2, 7, 6, // OK
    0, 2, 6, 0, 6, 4, // from
    1, 3, 7, 1, 7, 5, // to
  ];
  const out: RMesh[] = [];
  for (const wall of project.walls) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len;
    const uy = dy / len;
    // Grundriss-Normale (Dicken-Achse) — dieselbe Konvention wie pushSegment.
    const nx = uy;
    const ny = -ux;
    for (const op of openingsOfWall(project, wall.id)) {
      if (op.kind !== "window") continue; // Türen bekommen keine Scheibe.
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const { zBottom, zTop } = openingVerticalExtent(project, wall, op);
      if (zTop - zBottom <= EPS) continue;
      const positions: number[] = [];
      // 8 Ecken: Achse s ∈ {from,to} × Höhe z ∈ {UK,OK} × Dicke t ∈ {−,+}.
      for (let i = 0; i < 8; i++) {
        const s = i & 1 ? iv.to : iv.from;
        const z = i & 2 ? zTop : zBottom;
        const t = i & 4 ? GLASS_HALF_THICK : -GLASS_HALF_THICK;
        const px = wall.start.x + ux * s + nx * t;
        const py = wall.start.y + uy * s + ny * t;
        // MODELL-Koordinaten (x, y, z=Höhe) wie emitMeshes.
        positions.push(px, py, z);
      }
      out.push({ positions, indices: [...BOX_TRIS], kind: "imported", color: GLASS_RGB });
    }
  }
  return out;
}

/**
 * Nur die Wände (Rückwärts-Kompatibilität / bestehende Aufrufer). Zerlegt Wände
 * mit Öffnungen in Teilquader.
 */
export function projectToWalls3d(project: Project): RWall[] {
  const out: RWall[] = [];
  for (const w of project.walls) emitWall(out, project, w);
  return out;
}

/** Das volle 3D-Modell: Wände (mit Öffnungen) + Deckenplatten + Kontext-Meshes. */
export function projectToModel3d(project: Project): RModel3d {
  return {
    walls: projectToWalls3d(project),
    slabs: emitSlabs(project),
    // Kontext-Meshes (Terrain/Import) + Fenster-Glasscheiben (eigenes Mesh je
    // Fensteröffnung) — pickGeometry/Highlight nutzen `meshes` bewusst NICHT,
    // daher sind die Scheiben nicht selektierbar (man wählt Wand/Öffnung).
    meshes: [...emitMeshes(project), ...emitOpeningGlass(project)],
  };
}

/**
 * Pick-Geometrie für den TS-seitigen 3D-Raycast (siehe viewport/raycast3d): die
 * Wand-Teilquader (mit `wallId`) und Decken-Prismen (mit `ceilingId`) desselben
 * geflachten Modells wie {@link projectToModel3d}, aber ohne die Kontext-Meshes
 * (die sind für die Bauteil-Auswahl irrelevant). Reine TS-Nutzung — geht NICHT an
 * render3d; die Records tragen dieselben Geometriefelder wie die Serde-Payload,
 * plus die Ids fürs Picking.
 */
export function pickGeometry(project: Project): { walls: RWall[]; slabs: RSlab[] } {
  return { walls: projectToWalls3d(project), slabs: emitSlabs(project) };
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
): Float32Array {
  if (wallIds.length === 0 && ceilingIds.length === 0) return new Float32Array(0);
  const { walls, slabs } = pickGeometry(project);
  const wallSet = new Set(wallIds);
  const ceilingSet = new Set(ceilingIds);
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
  for (const w of walls) {
    if (!wallSet.has(w.wallId)) continue;
    const ax = w.end[0] - w.start[0];
    const az = w.end[1] - w.start[1];
    const len = Math.hypot(ax, az);
    if (len < EPS || w.height <= EPS || w.thickness <= EPS) continue;
    const axis: RVec3 = [ax / len, 0, az / len];
    const normal: RVec3 = [az / len, 0, -ax / len];
    const halfLen = len / 2;
    const halfHeight = w.height / 2;
    const halfThick = w.thickness / 2;
    const center: RVec3 = [
      (w.start[0] + w.end[0]) / 2,
      w.baseElevation + w.height / 2,
      (w.start[1] + w.end[1]) / 2,
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
  }
  for (const s of slabs) {
    if (!ceilingSet.has(s.ceilingId)) continue;
    const n = s.outline.length;
    if (n < 3 || s.zTop - s.zBottom <= EPS) continue;
    const bottom: RVec3[] = s.outline.map((p) => [p[0], s.zBottom, p[1]]);
    const top: RVec3[] = s.outline.map((p) => [p[0], s.zTop, p[1]]);
    for (let i = 0, j = n - 1; i < n; j = i++) {
      pushEdge(bottom[j], bottom[i]);
      pushEdge(top[j], top[i]);
    }
    for (let i = 0; i < n; i++) pushEdge(bottom[i], top[i]);
  }
  return new Float32Array(out);
}
