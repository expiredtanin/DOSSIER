// B-Rep-Spezifikation einer Wand(schicht) (`RWall`) für truck: Wandprofil (Achse × Höhe) mit
// den Öffnungen als Löcher bzw. Kerben, um die Dicke extrudiert — OHNE Boolean (B-Rep-Booleans
// scheitern an den bündigen Laibungsflächen). Gerechnet im Kern (`src-tauri/core/src/solid_specs.rs`,
// dort auch für die Abzugskörper im 3D); diese Fassade dient STEP-Export und Kollisionsprüfung.

import type { SolidSpec } from "../engine/truckSolid";
import { core } from "../engine/coreWasm";
import type { RWall } from "./toWalls3d/shared";

type WallLike = Pick<RWall, "start" | "end" | "thickness" | "height" | "baseElevation" | "holes">;

/** Wand als `extrudePlane` (Profil in der Wandebene, Tiefe = Dicke); null bei entarteter Wand. */
export function wallSpec(w: WallLike): SolidSpec | null {
  const f = [w.start[0], w.start[1], w.end[0], w.end[1], w.thickness, w.height, w.baseElevation];
  for (const h of w.holes ?? []) f.push(h.from, h.to, h.zBottom, h.zTop);
  const s = core().wall_spec_flat(Float64Array.from(f));
  return s ? (JSON.parse(s) as SolidSpec) : null;
}

/**
 * Wandprofil (u = Achse, v = Höhe über Wandfuss) mit Öffnungen: Löcher, die ganz im Profil
 * liegen; Öffnungen am Wandfuss (Türen) als Kerben im Aussenring. Öffnungen am Wandkopf
 * werden um 1 mm gekappt. Über {@link wallSpec} einer Wand entlang +x (entartet: leer).
 */
export function wallProfile(
  length: number,
  height: number,
  holes: Array<{ from: number; to: number; zBottom: number; zTop: number }>,
  baseElevation: number,
): { outer: number[]; holes: number[][] } {
  const s = wallSpec({ start: [0, 0], end: [length, 0], thickness: 1, height, baseElevation, holes });
  return s && s.kind === "extrudePlane" ? { outer: s.points, holes: s.holes ?? [] } : { outer: [], holes: [] };
}
