// Wand-Mesh MIT echtem Loch-Ausschnitt (Fenster/Türen) für die Datei-Exporte
// (STL/OBJ/IFC): aus einem RWall-Band (Achse `start→end`, `thickness`,
// `baseElevation`, `height` + rechteckige `holes`) entsteht das Dreiecks-Mesh mit
// ausgestanzten Öffnungen inkl. Laibungen — so sehen die Exporte aus wie die
// 3D-Ansicht. Gerechnet wird im Rust-Kern (`src-tauri/core/src/wall_mesh_cut.rs`,
// dieselbe Zerlegung wie `render3d/src/mesh.rs::extrude_layer_segment_with_holes`,
// ohne Gehrung: die Bänder sind an den Enden schon gekürzt). Hier bleibt die
// flache Übergabe.
//
// ACHSEN: Modell (x, y) → Welt (x, Höhe, y), Y-UP — wie exportMesh.ts und der
// 3D-Viewer.

import { core } from "../engine/coreWasm";
import { FlatWriter } from "../geometry/coreFlat";
import type { RWall } from "./toWalls3d";

/**
 * Ein Dreiecks-Mesh in LOKALEN (0-basierten) Indizes: `positions` flach
 * (x,y,z, …) in Weltmetern (Y-up), `indices` je 3 = ein Dreieck.
 */
export interface CutMesh {
  positions: number[];
  indices: number[];
}

/**
 * Zerlegt das Rechteck `[uLo,uHi]×[zLo,zHi]` MINUS `holes` (`[u0,u1,z0,z1]`) in
 * achsparallele, disjunkte solide Teilrechtecke (Koordinaten-Kompression wie
 * `mesh.rs::solid_subrects`).
 */
export function solidSubrects(
  uLo: number,
  uHi: number,
  zLo: number,
  zHi: number,
  holes: Array<[number, number, number, number]>,
): Array<[number, number, number, number]> {
  const flat = new Float64Array(holes.length * 4);
  holes.forEach((h, i) => flat.set(h, i * 4));
  const r = core().solid_subrects_flat(uLo, uHi, zLo, zHi, flat);
  const out: Array<[number, number, number, number]> = [];
  for (let i = 0; i + 4 <= r.length; i += 4) out.push([r[i], r[i + 1], r[i + 2], r[i + 3]]);
  return out;
}

/**
 * Ob ein Mesh eine GESCHLOSSENE, nach aussen gewundene Fläche ist — Gauss-
 * Kriterium (∮ n dA = 0 und signiertes Volumen > 0) statt eines Kanten-Zählers,
 * damit die legitimen T-Stösse der vollen Deckel/Boden-Streifen nicht als
 * „offen" gelten. Rechnet im Kern; die Übergabe-Puffer werden wiederverwendet
 * (frische Typed Arrays je Aufruf kosteten mehr als die Rechnung selbst).
 */
export function isWatertight(mesh: CutMesh, eps = 1e-6): boolean {
  const p = mesh.positions;
  const x = mesh.indices;
  if (scratchPos.length < p.length) scratchPos = new Float64Array(p.length * 2);
  if (scratchIdx.length < x.length) scratchIdx = new Uint32Array(x.length * 2);
  for (let i = 0; i < p.length; i++) scratchPos[i] = p[i];
  // Ungültige Indizes (negativ, gebrochen, NaN) zeigen ins Leere ⇒ „nicht dicht".
  for (let i = 0; i < x.length; i++) scratchIdx[i] = Number.isInteger(x[i]) && x[i] >= 0 && x[i] < 0xffffffff ? x[i] : 0xffffffff;
  return core().is_watertight_flat(scratchPos.subarray(0, p.length), scratchIdx.subarray(0, x.length), eps);
}

let scratchPos = new Float64Array(1024);
let scratchIdx = new Uint32Array(1024);

/**
 * Loch-Ausschnitt-Meshes vieler Bänder in EINEM Kern-Aufruf (Reihenfolge wie
 * `walls`). Aufbau je Band: Langseiten (Gitter minus Löcher), Deckel/Boden und
 * Stirnkappen minus randständiger Löcher, Laibungen je Loch. Ohne Löcher die
 * volle Box; entartete Bänder liefern ein leeres Mesh.
 */
export function wallCutMeshes(walls: readonly RWall[]): CutMesh[] {
  const w = new FlatWriter().num(walls.length);
  for (const b of walls) {
    const holes = b.holes ?? [];
    w.num(b.start[0], b.start[1], b.end[0], b.end[1], b.thickness, b.baseElevation, b.height, holes.length);
    for (const h of holes) w.num(h.from, h.to, h.zBottom, h.zTop);
  }
  const buf = core().wall_cut_meshes_flat(w.done());
  const out: CutMesh[] = [];
  let i = 1;
  for (let k = 0; k < walls.length; k++) {
    const len = i < buf.length ? buf[i++] : 0;
    const positions = new Array<number>(len);
    for (let j = 0; j < len; j++) positions[j] = buf[i + j];
    i += len;
    const indices = new Array<number>(len / 3);
    for (let j = 0; j < len / 3; j++) indices[j] = j;
    out.push({ positions, indices });
  }
  return out;
}

/** Loch-Ausschnitt-Mesh EINES Bandes (s. {@link wallCutMeshes}). */
export function wallCutMesh(w: RWall): CutMesh {
  return wallCutMeshes([w])[0];
}
