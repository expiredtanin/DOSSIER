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

import type { Project, Wall } from "../model/types";
import { getWallType, wallTypeThickness, openingsOfWall } from "../model/types";
import { wallVerticalExtent, ceilingVerticalExtent } from "../model/wall";
import { openingInterval, openingVerticalExtent } from "../geometry/opening";

export type RVec2 = [number, number];
export type RRgb = [number, number, number];

export interface RWall {
  start: RVec2;
  end: RVec2;
  thickness: number;
  height: number;
  baseElevation: number;
  color: RRgb;
}

/** Eine extrudierte Deckenplatte: geschlossener Grundriss-Umriss + Z-Ausdehnung. */
export interface RSlab {
  outline: RVec2[];
  zBottom: number;
  zTop: number;
  color: RRgb;
}

/** Modell-Bündel für den nativen 3D-Renderer (Wände + Decken). */
export interface RModel3d {
  walls: RWall[];
  slabs: RSlab[];
}

/** Warmer, neutraler Wand-Grundton (wie render3d default). */
const WALL_RGB: RRgb = [0.82, 0.8, 0.76];
/** Etwas hellerer, kühlerer Ton für Deckenplatten (heben sich von Wänden ab). */
const SLAB_RGB: RRgb = [0.86, 0.86, 0.88];

/** Ignoriere entartete vertikale Ausschnitte (Rundungsrauschen). */
const EPS = 1e-4;

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
    color: WALL_RGB,
  });
}

/** Emittiert die Teilquader EINER Wand (mit oder ohne Öffnungen). */
function emitWall(out: RWall[], project: Project, wall: Wall): void {
  let thickness = 0.2;
  try {
    thickness = wallTypeThickness(getWallType(project, wall));
  } catch {
    thickness = 0.2;
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
    pushSegment(out, wall, 0, axisLen, zBottom, zTop, thickness);
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
      pushSegment(out, wall, cursor, from, zBottom, zTop, thickness);
    }
    if (to > segFrom) {
      // Brüstung unter der Öffnung (bei Türen entfällt sie, da oBottom == zBottom).
      if (oBottom > zBottom + EPS) {
        pushSegment(out, wall, segFrom, to, zBottom, oBottom, thickness);
      }
      // Sturz über der Öffnung (bis zum Wandkopf).
      if (oTop < zTop - EPS) {
        pushSegment(out, wall, segFrom, to, oTop, zTop, thickness);
      }
    }
    cursor = Math.max(cursor, to);
  }
  // Restlicher Wandpfeiler bis zum Achsenende.
  if (cursor < axisLen) {
    pushSegment(out, wall, cursor, axisLen, zBottom, zTop, thickness);
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
    out.push({
      outline: c.outline.map((p) => [p.x, p.y] as RVec2),
      zBottom,
      zTop,
      color: SLAB_RGB,
    });
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

/** Das volle 3D-Modell: Wände (mit Öffnungen) + Deckenplatten. */
export function projectToModel3d(project: Project): RModel3d {
  return { walls: projectToWalls3d(project), slabs: emitSlabs(project) };
}
