// Geometrie-Helfer für Treppen (Stairs) — Fassade über den Rust-Kern (`src-tauri/kernel2d/src/lib.rs`:
// `stair_outline`; Bindung `src-tauri/core/src/web/stair.rs`, Kodierung `src-tauri/core/src/stair.rs`):
// die Plan-Aussenlinie (`stairOutline`, Fang). Tritte, Podest, Lauflinie und Schnitt rechnet der Kern
// direkt (Plan, 3D, Zeichenbefehl `cmd_create.rs`).
//
// Bezeichner englisch, Kommentare deutsch.

import type { Stair, Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";

export const IDEAL_TREAD = 0.29;
export const MIN_STEPS = 2;

const FORM = { straight: 0, L: 1, spiral: 2 } as const;
const REFERENZ = { mitte: 0, links: 1, rechts: 2 } as const;

const pt = (f: Float64Array, i: number): Vec2 => ({ x: f[i], y: f[i + 1] });

function ptsAt(f: Float64Array, i: number, n: number): Vec2[] {
  const out: Vec2[] = new Array(n);
  for (let k = 0; k < n; k++) out[k] = pt(f, i + 2 * k);
  return out;
}

/** Treppen-Parameter als 16 Zahlen (Aufbau: `src-tauri/core/src/stair.rs`); fehlend = NaN. */
export function encodeStair(s: Stair): Float64Array {
  const n = (v: number | undefined) => (v === undefined ? Number.NaN : v);
  return Float64Array.of(
    FORM[s.shape] ?? 0,
    s.start.x, s.start.y,
    s.dir.x, s.dir.y,
    s.runLength,
    n(s.run2Length),
    n(s.turn),
    n(s.center?.x), n(s.center?.y),
    n(s.radius),
    n(s.sweep),
    s.width,
    s.stepCount,
    s.up === undefined ? Number.NaN : s.up ? 1 : 0,
    REFERENZ[s.referenz ?? "mitte"] ?? 0,
  );
}

/**
 * Spiral-Outline: Innenbogen + Aussenbogen + zwei radiale Schliesslinien.
 * Die Bögen werden als Kreisbogen-Parameter geliefert (cx/cy/r/a0/a1), die
 * radialen Schliesslinien als Segment-Paare.
 */
export interface SpiralOutlineSegments {
  /** Radiale Abschlusslinien (jeweils Innenpunkt → Aussenpunkt). */
  lines: [Vec2, Vec2][];
  /** Kreisbogen-Parameter: Innen- und Aussenkreis. */
  arcs: { cx: number; cy: number; r: number; a0: number; a1: number }[];
}

/**
 * Aussenlinie einer Treppe im Grundriss je nach Form:
 *   • gerade → geschlossenes Rechteck als Polygon-Punkte.
 *   • L       → L-Polygon via Linien-Schnittpunkten.
 *   • Wendel  → `SpiralOutlineSegments` (Bögen + radiale Linien).
 *
 * Genau einer von `polygon` / `spiral` ist nicht null (bei Unsinn-Eingabe beide null).
 */
export function stairOutline(
  stair: Stair,
  totalRise: number,
): { polygon: Vec2[] | null; spiral: SpiralOutlineSegments | null } {
  void totalRise; // Signatur-Konsistenz; derzeit ungenutzt
  const f = core().stair_outline_flat(encodeStair(stair));
  if (f.length === 0) return { polygon: null, spiral: null };
  if (f[0] === 0) return { polygon: ptsAt(f, 2, f[1]), spiral: null };
  const l = ptsAt(f, 1, 4);
  const arcs = [0, 1].map((k) => {
    const j = 9 + 5 * k;
    return { cx: f[j], cy: f[j + 1], r: f[j + 2], a0: f[j + 3], a1: f[j + 4] };
  });
  return { polygon: null, spiral: { lines: [[l[0], l[1]], [l[2], l[3]]], arcs } };
}
