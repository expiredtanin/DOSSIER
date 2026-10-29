// Objektfang aus dem Modell über den Kern ([K4] S3, `src-tauri/core/src/snap_model.rs` + `snap.rs`):
// Der Kern sammelt die Fang-Kandidaten eines Geschosses (Wandachsen, Schichtgrenzen, Umrisse von
// Raum/Decke/Dach/Treppe/Stütze, 2D-Zeichnungen, Kreise/Bögen, Raum-Anker, Ellipsen-Mittelpunkte)
// einmal je Dokument-Stand ({@link holdModelSnap}); je Mausbewegung gehen nur Cursor, Toleranz und
// die Zusatzstrecken (Entwurf, Blatt-Geometrie) über die Grenze ({@link queryModelSnap}). Die
// Bildschirm-Toleranz, Verweilen/Teilpunkte, Parallele, Raster und Winkel bleiben in
// `tools/snapping.ts`.

import type { Project, Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";
import { documentFor } from "../core/document";

export type SnapSeg = [Vec2, Vec2];

/** Fang-Arten des Kerns (Code → Name wie `SnapKind`). */
const KINDS = ["perpendicular", "endpoint", "midpoint", "intersection", "onEdge", "center", "quadrant", "tangent"] as const;
export type ModelSnapKind = (typeof KINDS)[number];

export interface ModelSnapCand {
  point: Vec2;
  kind: ModelSnapKind;
  distPx: number;
  /** `distPx − Priorität` (kleiner gewinnt). */
  score: number;
}

/** Ergebnis in der Reihenfolge, in der `computeSnap` die Kandidaten zusammenführt. */
export interface ModelSnapResult {
  /** Nächste Strecke innerhalb der Toleranz (Lotfusspunkt-Abstand) oder null (Verweilen). */
  nearest: SnapSeg | null;
  /** Lot vom letzten Punkt, Strecken-Endpunkte. */
  a: ModelSnapCand | null;
  /** Raum-Stempel-Anker (Endpunkt). */
  anchors: ModelSnapCand | null;
  /** Mittelpunkte, Schnittpunkte, Punkt auf der Kante. */
  b: ModelSnapCand | null;
  /** Kreise/Bögen (Mittelpunkt, Quadranten, Bogen-Endpunkte, Tangente), Ellipsen-Mittelpunkte. */
  c: ModelSnapCand | null;
}

export interface ModelSnapQuery {
  raw: Vec2;
  tolM: number;
  pxPerMeter: number;
  /** Strecken-Fang überhaupt (auch nur für Verweilen/Parallele). */
  segs: boolean;
  perpendicular: boolean;
  endpoint: boolean;
  midpoint: boolean;
  intersection: boolean;
  onEdge: boolean;
  center: boolean;
  tangent: boolean;
  lastPoint: Vec2 | null;
}

function flat(segs: readonly SnapSeg[]): Float64Array {
  const out = new Float64Array(segs.length * 4);
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i];
    out[4 * i] = a.x;
    out[4 * i + 1] = a.y;
    out[4 * i + 2] = b.x;
    out[4 * i + 3] = b.y;
  }
  return out;
}

/**
 * Kandidaten des Geschosses `levelId` (sichtbare Ebenen `codes`) im Kern sammeln bzw. wiederfinden:
 * dieselbe Nummer, solange sich die betroffenen Felder des Dokuments nicht ändern. 0 = kein Dokument.
 */
export function holdModelSnap(project: Project, levelId: string, codes: ReadonlySet<string>): number {
  const doc = documentFor(project);
  return doc.id ? core().doc_snap_hold(doc.id, levelId, [...codes].join("\n")) : 0;
}

const cand = (f: Float64Array, k: number): ModelSnapCand | null =>
  Number.isNaN(f[k + 2]) ? null : { point: { x: f[k], y: f[k + 1] }, kind: KINDS[f[k + 2]], distPx: f[k + 3], score: f[k + 4] };

/**
 * Fang je Mausbewegung über die abgelegten Kandidaten `held` plus Entwurfs- (`draft`) und
 * Blatt-Strecken (`sheet`, nahe am Cursor, nächste zuerst). null, wenn `held` nicht (mehr) im Kern liegt.
 */
export function queryModelSnap(held: number, draft: readonly SnapSeg[], sheet: readonly SnapSeg[], q: ModelSnapQuery): ModelSnapResult | null {
  const flags =
    (q.perpendicular ? 1 : 0) |
    (q.endpoint ? 2 : 0) |
    (q.midpoint ? 4 : 0) |
    (q.intersection ? 8 : 0) |
    (q.onEdge ? 16 : 0) |
    (q.center ? 32 : 0) |
    (q.tangent ? 64 : 0) |
    (q.segs ? 128 : 0);
  const f = core().snap_query(
    held,
    flat(draft),
    flat(sheet),
    q.raw.x,
    q.raw.y,
    q.tolM,
    q.pxPerMeter,
    flags,
    q.lastPoint ? q.lastPoint.x : NaN,
    q.lastPoint ? q.lastPoint.y : NaN,
  );
  if (f.length < 25) return null;
  return {
    nearest: f[0] >= 0 ? [{ x: f[1], y: f[2] }, { x: f[3], y: f[4] }] : null,
    a: cand(f, 5),
    anchors: cand(f, 10),
    b: cand(f, 15),
    c: cand(f, 20),
  };
}
