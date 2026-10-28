// Objektfang auf Strecken über den Kern ([K3d], `src-tauri/core/src/snap.rs`): Lotfusspunkt,
// Endpunkte, Mittelpunkte, Schnittpunkte, Punkt auf der Kante und die nächste Strecke (Verweilen).
// Die Strecken eines Projekt-Geschosses liegen einmal im Kern ({@link holdSnapSegments}); je
// Mausbewegung gehen nur Cursor und Zusatzstrecken über die Grenze. Die Sammlung der Strecken
// und die übrigen Fang-Arten (Raster, Winkel, Kreise, Teilpunkte) bleiben in `tools/snapping.ts`.

import type { Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";

export type SnapSeg = [Vec2, Vec2];

/** Fang-Arten des Kerns (Code → Name wie `SnapKind`). */
const KINDS = ["perpendicular", "endpoint", "midpoint", "intersection", "onEdge"] as const;
export type SegSnapKind = (typeof KINDS)[number];

export interface SegSnapCand {
  point: Vec2;
  kind: SegSnapKind;
  distPx: number;
  /** `distPx − Priorität` (kleiner gewinnt). */
  score: number;
}

export interface SegSnapResult {
  /** Nächste Strecke innerhalb der Toleranz (Lotfusspunkt-Abstand) oder null. */
  nearest: SnapSeg | null;
  /** Block A: Lot vom letzten Punkt, Endpunkte der Strecken. */
  a: SegSnapCand | null;
  /** Block B: Mittelpunkte, Schnittpunkte, Punkt auf der Kante. */
  b: SegSnapCand | null;
}

export interface SegSnapQuery {
  raw: Vec2;
  tolM: number;
  pxPerMeter: number;
  perpendicular: boolean;
  endpoint: boolean;
  midpoint: boolean;
  intersection: boolean;
  onEdge: boolean;
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

/** Strecken im Kern ablegen; Nummer für {@link snapOnSegments} (freigeben: {@link releaseSnapSegments}). */
export function holdSnapSegments(segs: readonly SnapSeg[]): number {
  return core().snap_segs_hold(flat(segs));
}

export function releaseSnapSegments(id: number): void {
  if (id) core().snap_segs_release(id);
}

const cand = (f: Float64Array, k: number): SegSnapCand | null =>
  Number.isNaN(f[k + 2]) ? null : { point: { x: f[k], y: f[k + 1] }, kind: KINDS[f[k + 2]], distPx: f[k + 3], score: f[k + 4] };

/**
 * Fang über die abgelegten Strecken `held` (0 = keine) und `extra` (in dieser Reihenfolge);
 * Schnittpunkte aus `intSegs` (null = aus denselben Strecken). null, wenn `held` nicht (mehr) im
 * Kern liegt.
 */
export function snapOnSegments(held: number, extra: readonly SnapSeg[], intSegs: readonly SnapSeg[] | null, q: SegSnapQuery): SegSnapResult | null {
  const flags = (q.perpendicular ? 1 : 0) | (q.endpoint ? 2 : 0) | (q.midpoint ? 4 : 0) | (q.intersection ? 8 : 0) | (q.onEdge ? 16 : 0);
  const f = core().snap_eval(
    held,
    flat(extra),
    intSegs ? 1 : 0,
    intSegs ? flat(intSegs) : new Float64Array(0),
    q.raw.x,
    q.raw.y,
    q.tolM,
    q.pxPerMeter,
    flags,
    q.lastPoint ? q.lastPoint.x : NaN,
    q.lastPoint ? q.lastPoint.y : NaN,
  );
  if (f.length < 15) return null;
  return {
    nearest: f[0] >= 0 ? [{ x: f[1], y: f[2] }, { x: f[3], y: f[4] }] : null,
    a: cand(f, 5),
    b: cand(f, 10),
  };
}
