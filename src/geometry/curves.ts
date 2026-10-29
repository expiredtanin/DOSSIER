// Geometrie-Helfer für Ellipse/Bezier/Spline — reine Sample-/Tessellierungs-
// Funktionen, gemeinsam genutzt von den Zeichen-Werkzeugen (Vorschau), dem
// Grundriss-Generator (finales Rendering als Linien-/Polygon-Primitive) und
// dem Snapping (Kandidaten-Strecken). Fassade über den Rust-Kern
// (`src-tauri/core/src/curves.rs`, Bindungen `web/curves.rs`): die Formeln stehen nur dort.

import type { Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";

function toPoints(f: Float64Array): Vec2[] {
  const out: Vec2[] = new Array(f.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = { x: f[2 * i], y: f[2 * i + 1] };
  return out;
}

function toFlat(pts: Vec2[]): Float64Array {
  const f = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    f[2 * i] = pts[i].x;
    f[2 * i + 1] = pts[i].y;
  }
  return f;
}

/**
 * Tessellierte Punkte einer kubischen Bezier-Kette. `pts` folgt dem Muster
 * Anker·Griff·Griff·Anker·… (`pts.length` ≡ 1 mod 3). Mit weniger als 4
 * Punkten (noch im Bau) werden die Rohpunkte unverändert zurückgegeben
 * (Gummiband-Vorschau).
 */
export function sampleBezierChain(pts: Vec2[], segsPerCurve = 24): Vec2[] {
  if (pts.length < 4) return [...pts];
  return toPoints(core().curves_bezier_chain_flat(toFlat(pts), segsPerCurve));
}

/**
 * Tessellierte Punkte einer glatten Kurve DURCH `pts` (uniformer Catmull-
 * Rom-Spline). Mit weniger als 3 Punkten (noch im Bau bzw. entartet) werden
 * die Rohpunkte unverändert zurückgegeben (Gummiband-Vorschau bzw. Gerade).
 * `closed` schliesst den Ring OHNE expliziten Doppelpunkt am Ende — Aufrufer
 * schliessen wie bei `polyline` selbst mit einem letzten Segment zurück zu
 * `pts[0]`.
 */
export function sampleCatmullRom(pts: Vec2[], closed: boolean, segsPerSpan = 16): Vec2[] {
  if (pts.length < 3) return [...pts];
  return toPoints(core().curves_catmull_rom_flat(toFlat(pts), closed, segsPerSpan));
}

/**
 * Tessellierte Punkte eines kubischen B-Splines über den KONTROLLPUNKTEN
 * `pts` — Gegenstück zu `sampleCatmullRom`: die Kurve verläuft NICHT durch
 * die inneren Punkte, sie wird nur von ihnen „gezogen" (Kontrollnetz statt
 * Durchgangspunkte, wie CV-Modus in AutoCAD/Rhino). Offen: GEKLEMMT — die
 * Kurve berührt exakt `pts[0]`/`pts[n-1]`. Geschlossen: periodisch, die Kurve
 * berührt dann KEINEN der Punkte. Mit weniger als 3 Punkten identisches
 * Fallback-Verhalten wie `sampleCatmullRom` (Rohpunkte, Gummiband-Vorschau).
 */
export function sampleUniformBSpline(pts: Vec2[], closed: boolean, segsPerSpan = 16): Vec2[] {
  if (pts.length < 3) return [...pts];
  return toPoints(core().curves_uniform_bspline_flat(toFlat(pts), closed, segsPerSpan));
}
