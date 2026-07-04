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
// SCHICHTEN (Putz/Dämmung/Mauerwerk/…): zusätzlich zur Gesamtdicke wird der
// aufgelöste Schichtaufbau des WallType mitgegeben (`layers`) — je Schicht
// Dicke + 3D-Farbe des zugehörigen Bauteil-Materials (Component). render3d
// extrudiert daraus je Schicht ein eigenes Band quer zur Wanddicke (siehe
// render3d::mesh); die Eck-Gehrung (Wandknoten-Verschneidung) berechnet
// render3d selbständig aus der Wandkonnektivität, braucht also keine
// zusätzlichen Felder von hier.

import type { Project, Wall, Layer } from "../model/types";
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

/** Eine aufgelöste Wandschicht: Dicke + 3D-Albedo-Farbe (aus dem Component). */
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
  /** Aufgelöster Schichtaufbau (leer = kein WallType auflösbar, siehe emitWall). */
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
 * Hängt einen Wand-Teilquader an: das Achsenstück [from..to] (Meter ab
 * Wand-Startpunkt) über den Höhenbereich [zBottom..zTop]. Entartete Stücke
 * (Länge ≤ 0 oder Höhe ≤ 0) werden übersprungen — so überleben Öffnungen dicht
 * an den Wandenden ohne Nullquader.
 */
function pushSegment(
  out: RWall[],
  wall: Wall,
  from: number,
  to: number,
  zBottom: number,
  zTop: number,
  thickness: number,
  layers: RLayer[],
  wallId: string,
  color: RRgb,
): void {
  if (to - from <= EPS) return;
  if (zTop - zBottom <= EPS) return;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return;
  const ux = dx / len;
  const uy = dy / len;
  const p1: RVec2 = [wall.start.x + ux * from, wall.start.y + uy * from];
  const p2: RVec2 = [wall.start.x + ux * to, wall.start.y + uy * to];
  out.push({
    start: p1,
    end: p2,
    thickness,
    height: zTop - zBottom,
    baseElevation: zBottom,
    color,
    layers,
    wallId,
  });
}

/** Emittiert die Teilquader EINER Wand (mit oder ohne Öffnungen). */
function emitWall(out: RWall[], project: Project, wall: Wall): void {
  let thickness = 0.2;
  // Aufgelöster Schichtaufbau (Dicke + 3D-Farbe je Schicht des WallType) —
  // leer, wenn kein WallType auflösbar ist (render3d extrudiert dann wie
  // bisher einen Vollkörper aus `thickness`/`color`, siehe RWall-Moduldoc).
  let layers: RLayer[] = [];
  // Repräsentative Vollkörper-Farbe = Farbe der dicksten Schicht (Option A,
  // siehe Moduldoc); Fallback WALL_RGB, wenn kein WallType auflösbar ist.
  let color: RRgb = WALL_RGB;
  try {
    const wt = getWallType(project, wall);
    thickness = wallTypeThickness(wt);
    layers = wt.layers.map((l) => ({
      thickness: l.thickness,
      color: hexToRgb(getComponent(project, l.componentId).color),
    }));
    color = dominantLayerColor(wt.layers, project, WALL_RGB);
  } catch {
    thickness = 0.2;
    layers = [];
    color = WALL_RGB;
  }
  const { zBottom, zTop } = wallVerticalExtent(project, wall);
  const axisLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  if (axisLen < 1e-9 || zTop - zBottom <= EPS) return;

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

  // Ohne Aussparungen: ein durchgehender Quader (wie bisher).
  if (cutouts.length === 0) {
    pushSegment(out, wall, 0, axisLen, zBottom, zTop, thickness, layers, wall.id, color);
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
      pushSegment(out, wall, cursor, from, zBottom, zTop, thickness, layers, wall.id, color);
    }
    if (to > segFrom) {
      // Brüstung unter der Öffnung (bei Türen entfällt sie, da oBottom == zBottom).
      if (oBottom > zBottom + EPS) {
        pushSegment(out, wall, segFrom, to, zBottom, oBottom, thickness, layers, wall.id, color);
      }
      // Sturz über der Öffnung (bis zum Wandkopf).
      if (oTop < zTop - EPS) {
        pushSegment(out, wall, segFrom, to, oTop, zTop, thickness, layers, wall.id, color);
      }
    }
    cursor = Math.max(cursor, to);
  }
  // Restlicher Wandpfeiler bis zum Achsenende.
  if (cursor < axisLen) {
    pushSegment(out, wall, cursor, axisLen, zBottom, zTop, thickness, layers, wall.id, color);
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
    meshes: emitMeshes(project),
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
