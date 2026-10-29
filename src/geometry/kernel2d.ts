// 2D-Geometrie-Kernel — Fassade über den Rust-Kern (`src-tauri/kernel2d`, gebunden in
// `src-tauri/core/src/web/kernel2d.rs`, geladen über `engine/coreWasm.ts`). Offset / Trim /
// Fillet / Split / Segment löschen, auch mit Bogen-Segmenten (bulge); Trim/Extend/Fase/Bruch/
// Offset/Join rufen die Editier-Befehle direkt im Kern auf (`core/src/cmd_edit.rs`). Die
// Rechenlogik liegt ausschliesslich in Rust; hier wird nur kodiert/dekodiert (flache
// Float64Arrays, Formate s. Kopf von `web/kernel2d.rs`).
//
// Konvention: Polylinien sind `Vec2[]`; `closed` heisst, die letzte Kante geht von pts[n-1]
// zu pts[0] (Schlusspunkt NICHT dupliziert). Offsets: positiv = nach LINKS bezogen auf die
// Laufrichtung, negativ = nach rechts. `bulge[i]` krümmt die Kante pts[i]→pts[i+1]; ein
// fehlender Eintrag gilt als Gerade.
//
// Bewusst in TS geblieben (je ein WASM-Aufruf wäre teurer als die Rechnung selbst):
//   • `vecEqual` — zwei Betragsvergleiche, wird von Aufrufern je Punkt verwendet;
//   • `polylineEdges` — reines Umordnen der Eingabe zu Kantenpaaren (keine Geometrie),
//     liefert die Original-Punktobjekte zurück.

import type { Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";

/** Numerische Toleranz (Meter) für Schnitt-/Gleichheitstests (wie `kernel2d::EPS`). */
export const EPS = 1e-7;

/** Punkt-Gleichheit innerhalb Toleranz. */
export function vecEqual(a: Vec2, b: Vec2, eps = EPS): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

// ── Kodierung ────────────────────────────────────────────────────────────────

function decPts(buf: Float64Array, from = 0, count = (buf.length - from) / 2): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k < count; k++) out.push({ x: buf[from + 2 * k], y: buf[from + 2 * k + 1] });
  return out;
}

// ── Punkt/Strecke, Fläche ───────────────────────────────────────────────────

/** Schnittpunkte zweier Kreise (0/1/2 Punkte). */
export function circleCircleIntersect(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  return decPts(core().k2_circle_circle_intersect(c1.x, c1.y, r1, c2.x, c2.y, r2));
}

// ── Offset ───────────────────────────────────────────────────────────────────

// ── Fillet / Fase ────────────────────────────────────────────────────────────

