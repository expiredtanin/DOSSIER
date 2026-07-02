// Leitet aus den Wänden eines Projekts die serialisierbaren WallInput-Records
// für den nativen render3d-Renderer ab. Matcht 1:1 render3d::types::WallInput
// { start:[x,y], end:[x,y], thickness, height, baseElevation, color:[r,g,b] }
// mit Modell-Metern und Y-up-Extrusion (Rust-Seite: plan liegt in XZ, +Y hoch).
//
// Alle Geschosse werden einbezogen und über wallVerticalExtent korrekt
// gestapelt (EG baseElevation 0, OG 2.6 …), sodass das 3D-Fenster das ganze
// Gebäude zeigt.

import type { Project } from "../model/types";
import { getWallType, wallTypeThickness } from "../model/types";
import { wallVerticalExtent } from "../model/wall";

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

/** Warmer, neutraler Wand-Grundton (wie render3d default). */
const WALL_RGB: RRgb = [0.82, 0.8, 0.76];

export function projectToWalls3d(project: Project): RWall[] {
  const out: RWall[] = [];
  for (const w of project.walls) {
    let thickness = 0.2;
    try {
      thickness = wallTypeThickness(getWallType(project, w));
    } catch {
      thickness = 0.2;
    }
    const { zBottom, zTop } = wallVerticalExtent(project, w);
    const height = Math.max(0.01, zTop - zBottom);
    out.push({
      start: [w.start.x, w.start.y],
      end: [w.end.x, w.end.y],
      thickness,
      height,
      baseElevation: zBottom,
      color: WALL_RGB,
    });
  }
  return out;
}
