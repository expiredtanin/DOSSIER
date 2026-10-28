// Gewichteter Straight Skeleton ([B2]) — Fassade über den Rust-Kern (`src-tauri/core/src/skeleton.rs`,
// Bindung `web/skeleton.rs`). Grundlage der Dachflächen (`roof_skeleton.rs`); hier als Abfrage für
// beliebige Umrisse mit Höfen und Geschwindigkeit je Kante (0 = stehende Giebelkante).

import type { Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";

/** Eckpunkt einer Skelett-Fläche: Lage und Zeit, zu der die Wellenfront ihn erreicht. */
export interface SkeletonPoint {
  x: number;
  y: number;
  t: number;
}

/** Warum kein Skelett entstand. */
export type SkeletonError = "input" | "noSlope" | "fenced" | "budget" | "degenerate";

const ERRORS: SkeletonError[] = ["input", "input", "noSlope", "fenced", "budget", "degenerate"];

/**
 * Flächen, die die Kanten von `rings` (Ring 0 aussen gegen den Uhrzeigersinn, weitere = Höfe im
 * Uhrzeigersinn; Kanten Ring für Ring nummeriert) mit `speeds` je Kante überstreichen. Je Kante
 * ihre Umläufe (zuerst aussen, dann Löcher), für stehende Kanten keine. `budget` = höchstens so
 * viele Ereignisse (fehlt ⇒ Standard). Nie eine Ausnahme: Fehler kommen als `{ error }`.
 */
export function straightSkeleton(rings: Vec2[][], speeds: number[], budget = 0): { faces: SkeletonPoint[][][] } | { error: SkeletonError } {
  const buf: number[] = [rings.length];
  for (const r of rings) {
    buf.push(r.length);
    for (const p of r) buf.push(p.x, p.y);
  }
  const out = core().straight_skeleton(new Float64Array(buf), new Float64Array(speeds), budget);
  if (out.length === 0 || out[0] !== 0) return { error: ERRORS[out[0] ?? 1] ?? "input" };
  let i = 1;
  const faces: SkeletonPoint[][][] = [];
  for (let e = out[i++]; e > 0; e--) {
    const loops: SkeletonPoint[][] = [];
    for (let l = out[i++]; l > 0; l--) {
      const loop: SkeletonPoint[] = [];
      for (let n = out[i++]; n > 0; n--) loop.push({ x: out[i++], y: out[i++], t: out[i++] });
      loops.push(loop);
    }
    faces.push(loops);
  }
  return { faces };
}
