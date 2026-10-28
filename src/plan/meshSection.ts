// Ebenenschnitt beliebiger Dreiecksnetze (docs/boolean-geometrie-plan.md, Baustein 1 / [G1]).
//
// Schneidet ein Netz (Modell-Koordinaten x, y, z = Höhe — wie `ImportedMesh`/`TerrainMesh`/truck-
// Meshes) mit einer SENKRECHTEN Ebene (Schnitt) oder einer WAAGRECHTEN Ebene (Grundriss auf
// Schnitthöhe) und liefert Linienzüge bzw. Ringe in den Ebenen-Koordinaten:
//   • senkrecht:  (u, v) wie die Schnitt-Pipeline (u entlang der Ebene, v = Höhe),
//   • waagrecht:  (x, y).
// Geschlossene Netze (Körper) ergeben geschlossene Ringe → Polygone mit Löchern; offene Netze
// (Gelände) ergeben offene Linienzüge (Geländelinie im Schnitt).
//
// Die Rechnung liegt im Rust-Kern (`src-tauri/core/src/mesh_section.rs`, [K3c]); hier nur die
// Fassade mit unveränderter Signatur.

import { core } from "../engine/coreWasm";

export type Pt2 = [number, number];

export interface CutResult {
  /** Geschlossene Ringe (Körper). */
  rings: Pt2[][];
  /** Offene Linienzüge (offene Netze, z. B. Gelände). */
  lines: Pt2[][];
}

/** Ebene durch `point` (Modell x,y) in Richtung `dir` (Einheitsvektor): senkrechter Schnitt. */
export interface VerticalPlane {
  kind: "vertical";
  point: { x: number; y: number };
  dir: { x: number; y: number };
}
/** Waagrechte Ebene auf Höhe `z`. */
export interface HorizontalPlane {
  kind: "horizontal";
  z: number;
}
export type CutPlane = VerticalPlane | HorizontalPlane;

/** Liest `[n, (k, u, v …) × n]` ab `i` (Index wandert mit). */
function readRings(f: Float64Array, at: { i: number }): Pt2[][] {
  const out: Pt2[][] = [];
  for (let k = 0, n = f[at.i++]; k < n; k++) {
    const count = f[at.i++];
    const ring = new Array<Pt2>(count);
    for (let j = 0; j < count; j++, at.i += 2) ring[j] = [f[at.i], f[at.i + 1]];
    out.push(ring);
  }
  return out;
}

/**
 * Schneidet das Netz mit `plane`. `positions` flach [x,y,z,…], `indices` je 3 ein Dreieck.
 * Entartete Segmente (Länge ~0) werden verworfen.
 */
export function cutMeshWithPlane(positions: ArrayLike<number>, indices: ArrayLike<number>, plane: CutPlane): CutResult {
  const pl =
    plane.kind === "vertical"
      ? [0, plane.point.x, plane.point.y, plane.dir.x, plane.dir.y]
      : [1, plane.z];
  const f = core().mesh_section_cut_flat(Float64Array.from(positions), Float64Array.from(indices), Float64Array.from(pl));
  if (f.length === 0) return { rings: [], lines: [] };
  const at = { i: 0 };
  const rings = readRings(f, at);
  const lines = readRings(f, at);
  return { rings, lines };
}

/** Ring mit Löchern (Aussenring zuerst, dann Löcher). */
export type RingSet = Pt2[][];

/**
 * Ordnet geschlossene Ringe zu Aussenring + Löchern (Schachtelungstiefe gerade = aussen, ungerade =
 * Loch). Unabhängig vom Umlaufsinn. Aussenringe zuerst-gross; Löcher folgen ihrem Aussenring.
 */
export function ringsToPolygons(rings: Pt2[][]): RingSet[] {
  const b: number[] = [rings.length];
  for (const r of rings) {
    b.push(r.length);
    for (const p of r) b.push(p[0], p[1]);
  }
  const f = core().mesh_section_polygons_flat(Float64Array.from(b));
  if (f.length === 0) return [];
  const at = { i: 1 };
  const out: RingSet[] = [];
  for (let k = 0; k < f[0]; k++) {
    const nr = f[at.i++];
    const set: RingSet = [];
    for (let r = 0; r < nr; r++) {
      const count = f[at.i++];
      const ring = new Array<Pt2>(count);
      for (let j = 0; j < count; j++, at.i += 2) ring[j] = [f[at.i], f[at.i + 1]];
      set.push(ring);
    }
    out.push(set);
  }
  return out;
}
