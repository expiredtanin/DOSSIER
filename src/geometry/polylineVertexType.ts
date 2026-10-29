// Punkttypen einer Polylinie (ArchiCAD/Vectorworks-artig): Eckpunkt, Bogenpunkt, Splinepunkt — als
// Umrechnung der Segment-Bögen (`bulge`) der beiden am Punkt anliegenden Segmente. Gerechnet im
// Rust-Kern (`src-tauri/core/src/polyline_vertex.rs`): das Setzen als Griff-Änderung auf dem Dokument
// (Store `setPolylineVertexType`, Anfrage `vertexType`), die Abfrage für das Kontextmenü hier über die
// Bindung `polyline_vertex_info`.

import type { Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";

export type PolylineVertexType = "corner" | "arc" | "spline";

interface PolylineLike {
  pts: Vec2[];
  closed: boolean;
  bulge?: number[];
}

const TYPES: PolylineVertexType[] = ["corner", "arc", "spline"];

/** `[typ, ecke, bogen, spline]` des Kerns (typ −1 = gemischt/kein Punkt; danach setzbar 1/0). */
function info(g: PolylineLike, i: number): Float64Array {
  const pts = new Float64Array(g.pts.length * 2);
  for (let k = 0; k < g.pts.length; k++) {
    pts[2 * k] = g.pts[k].x;
    pts[2 * k + 1] = g.pts[k].y;
  }
  return core().polyline_vertex_info(pts, Float64Array.from(g.bulge ?? []), !!g.closed, i);
}

/** Ist Punkttyp `type` am Punkt `i` möglich? (Bogen/Spline brauchen beide Nachbarn.) */
export function canSetVertexType(g: PolylineLike, i: number, type: PolylineVertexType): boolean {
  return info(g, i)[1 + TYPES.indexOf(type)] === 1;
}

/** Aktueller Typ (Heuristik): beide Nachbarsegmente gerade → Eckpunkt, sonst null (gemischt). */
export function vertexTypeOf(g: PolylineLike, i: number): PolylineVertexType | null {
  return TYPES[info(g, i)[0]] ?? null;
}
