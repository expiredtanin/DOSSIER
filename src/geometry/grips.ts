// Griff-Geometrie der Bauteile ([K4] S3): dünne Fassade über den Rust-Kern (`src-tauri/core/src/grips.rs`,
// Bindungen `web/grips.rs`). Die Griff-Änderungen selbst (Eckpunkt/Kante ziehen, verschieben, Grösse,
// Decke/Dach/Treppe/Raum, Polylinien-Punkte, Dicken) rechnet der Kern auf dem Dokument und wendet sie
// gleich an (`ProjectDocument.commitGrip`, Anfrage {@link GripRequest}); hier stehen die Griff-Listen
// für die Anzeige (`drawingVertices`, Kanten-Griffe).
//
// Bewusst TS: die Rahmen-Ecken einer Textspalte (`textFrameCorners` braucht die Schrift-Metrik der
// Hülle) — der Kern meldet dafür nur „Textspalte".

import type { Drawing2D, Drawing2DGeom, EdgeGrip, Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";
import { toMarkedJson } from "../core/ops";
import { DEFAULT_SCALE_DENOMINATOR } from "../model/dimension";
import { textFrameCorners } from "../text/textFrame";

/** Punkt als `[x, y]` (Anfragen an den Kern). */
type P = [number, number];

/** Eine Griff-Änderung für den Kern (`grips.rs::run`); Zahlen dürfen NaN/±∞ sein (Marken). */
export type GripRequest =
  | { op: "moveGrip"; drawingId: string | null; wallId: string | null; index: number; pt: P; scale: number }
  | { op: "moveBy"; drawingId: string | null; wallId: string | null; delta: P }
  | { op: "moveEdge"; drawingId: string | null; wallId: string | null; a: number; b: number; delta: P }
  | { op: "resize"; kind: string; id: string; w: number; h: number; fx: number; fy: number }
  | { op: "ceilingGrip" | "roomGrip" | "roofGrip"; id: string; index: number; pt: P }
  | { op: "ceilingBy" | "roofBy" | "stairBy" | "roomBy" | "roomStamp"; id: string; delta: P }
  | { op: "ceilingEdge" | "roomEdge"; id: string; a: number; b: number; delta: P }
  | { op: "insertPoint"; id: string; seg: number; pt: P }
  | { op: "deletePoint"; id: string; index: number }
  | { op: "wallThickness" | "ceilingThickness"; id: string; thickness: number; newId: string; newName: string };

/** Punkt als Anfrage-Paar. */
export const gripPt = (p: Vec2): P => [p.x, p.y];

/**
 * Editier-Griffe (Eckpunkte) eines 2D-Zeichenelements in Modell-Metern — dieselbe Reihenfolge, in der
 * der Kern einen Griff-Index auflöst (`moveGrip`). line/polyline/rect: Eckpunkte (Polylinie zusätzlich je
 * Segment ein Bogen-Mitten-Griff); Kreis Ost/Nord; Bogen Start/Ende/Mitte; Ellipse je Halbachse;
 * Bemassung Kettenpunkte · Masslinie · je Segment die Masszahl (`scaleDenominator`: Papier-Massstab, die
 * Masszahl-Lage hängt an der Schrifthöhe in Papier-mm); Text Anker · Knicke · Spitze, Pfadpunkte oder
 * die vier Rahmen-Ecken einer Textspalte.
 */
export function drawingVertices(d: Drawing2D, scaleDenominator: number = DEFAULT_SCALE_DENOMINATOR): Vec2[] {
  const g = d.geom;
  if (g.shape === "polyline") {
    // Flach (Kataster-Umrisse mit tausenden Punkten): ein fehlender/null-Bogen ist gerade.
    const f = core().grip_vertices_polyline(flat(g.pts), Float64Array.from(g.bulge ?? []), !!g.closed);
    const out: Vec2[] = new Array(f.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = { x: f[2 * i], y: f[2 * i + 1] };
    return out;
  }
  // NaN/±∞ als Marken (JSON hätte null daraus gemacht, das rechnet wie 0).
  const f = core().grip_vertices(toMarkedJson(g), scaleDenominator);
  if (f[0] === -1 && g.shape === "text") {
    return textFrameCorners({ at: g.at, text: g.text, heightM: g.height, angle: g.angle, marks: g.marks, doc: g.doc, wrapWidth: g.width });
  }
  const n = f[0] ?? 0;
  const out: Vec2[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { x: f[1 + 2 * i], y: f[2 + 2 * i] };
  return out;
}

type Owner = { drawingId?: string; wallId?: string };

function flat(verts: readonly Vec2[]): Float64Array {
  const f = new Float64Array(verts.length * 2);
  for (let i = 0; i < verts.length; i++) {
    f[2 * i] = verts[i].x;
    f[2 * i + 1] = verts[i].y;
  }
  return f;
}

function edges(verts: readonly Vec2[], closed: boolean, bulge: readonly number[] | null, owner: Owner): EdgeGrip[] {
  const f = core().edge_grips(flat(verts), closed, Float64Array.from(bulge ?? []), bulge !== null);
  const out: EdgeGrip[] = [];
  for (let i = 0; i + 5 < f.length; i += 6) {
    const e: EdgeGrip = { mid: { x: f[i + 2], y: f[i + 3] }, normal: { x: f[i + 4], y: f[i + 5] }, aIndex: f[i], bIndex: f[i + 1] };
    if (!closed) e.free = true;
    e.owner = owner;
    out.push(e);
  }
  return out;
}

/** Geschlossener Ring → Kanten-Griffe mit Aussennormale (vom Eckpunkt-Mittel weg), inkl. Schlusskante. */
export function ringEdges(verts: readonly Vec2[], owner: Owner): EdgeGrip[] {
  return edges(verts, true, null, owner);
}

/**
 * Offene Kette (Linie/offene Polylinie) → ein Griff je Segment, OHNE Schlusskante. `normal` dient nur
 * der Darstellung (linke Normale der Kante); die Bewegung ist frei (`free: true`).
 */
export function openEdges(verts: readonly Vec2[], owner: Owner): EdgeGrip[] {
  return edges(verts, false, null, owner);
}

/**
 * Kanten-Griffe einer Polylinie: nur über die Eckpunkte und nur an geraden Segmenten — ein Bogen hat
 * seinen Bogen-Mitten-Griff (`drawingVertices`), die Sehnen-Mitte läge neben der Linie.
 */
export function polylineEdgeGrips(g: Extract<Drawing2DGeom, { shape: "polyline" }>, owner: Owner): EdgeGrip[] {
  return edges(g.pts, !!g.closed, g.bulge ?? [], owner);
}
