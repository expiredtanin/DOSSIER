// Lokaler Ursprung des SVG-Overlays der Plan-Ansicht ([G10], 29.10.).
//
// Das Overlay (Griffe, Fang-Marken, Hervorhebung, Vorschau, Texte, Raster, Lineal, HUD, Marquee)
// zeichnet in viewBox-Einheiten = Modell-m · PX_PER_M. Browser rechnen SVG-Koordinaten in f32 und
// klemmen CSS-Längen (`cx`, `x`, `width` …) auf ±33.5 Mio.: bei Landeskoordinaten LV95
// (≈ 2.6e6 m → 2.3e8 Einheiten) lagen Griffe beim Hineinzoomen pixelweit neben der Ecke, Lineal und
// Kreise fehlten ganz. Darum zieht die Ansicht vor dem Schreiben ins DOM (in f64) einen Ursprung
// nahe dem Ausschnitt ab — alle Werte im DOM bleiben klein. Ausschnitt (`view`), Treffer und Fang
// rechnen weiter absolut in f64; nur die Darstellung ist verschoben.
//
// Der Ursprung bleibt stehen, solange der Ausschnitt in f32 genau genug darstellbar ist (sonst
// müsste jedes Schwenken den ganzen Overlay-Baum neu aufbauen). Bei lokal gezeichneten Projekten
// bleibt er praktisch immer (0, 0) — das Overlay ist dann gleich wie vor der Umstellung.

import type { Vec2 } from "../../../model/types";
import type { ViewBox__plan_planView_geometry as ViewBox } from "../../../core";
import { PX_PER_M } from "../../../core";

/**
 * Höchster Abstand (in Ausschnitt-Grössen) einer Ausschnitt-Kante vom Ursprung. f32 hat ~6e-8
 * relative Genauigkeit: bei Abstand d und Ausschnitt-Breite w (≈ 2000 px) ist der Fehler
 * ≈ d/w · 1.2e-4 px; 64 → unter 0.01 px.
 */
export const ORIGIN_REACH = 64;

const ZERO: Vec2 = Object.freeze({ x: 0, y: 0 });

/** Weitester Abstand einer Ausschnitt-Kante vom Ursprung, gemessen in Ausschnitt-Grössen. */
function reach(view: ViewBox, o: Vec2): number {
  const size = Math.max(view.w, view.h);
  const d = Math.max(
    Math.abs(view.x - o.x),
    Math.abs(view.x + view.w - o.x),
    Math.abs(view.y - o.y),
    Math.abs(view.y + view.h - o.y),
  );
  return d / size;
}

/**
 * Ursprung (viewBox-Einheiten) für den Ausschnitt `view`. `prev` bleibt (gleiches Objekt), solange
 * er nah genug liegt; sonst (0, 0), wenn das reicht, sonst die auf eine Zehnerpotenz unter der
 * Ausschnitt-Grösse gerundete Mitte. Unsinnige Ausschnitte → `prev` bzw. (0, 0).
 */
export function pickOverlayOrigin(view: ViewBox, prev: Vec2 | null): Vec2 {
  const size = Math.max(view.w, view.h);
  if (![view.x, view.y, view.w, view.h].every(Number.isFinite) || !(size > 0)) return prev ?? ZERO;
  if (prev && reach(view, prev) <= ORIGIN_REACH) return prev;
  if (reach(view, ZERO) <= ORIGIN_REACH) return ZERO;
  const step = Math.pow(10, Math.floor(Math.log10(size)));
  return {
    x: Math.round((view.x + view.w / 2) / step) * step,
    y: Math.round((view.y + view.h / 2) / step) * step,
  };
}

/** Modell (m) → lokale viewBox-Einheiten: wie `toScreen`, minus Ursprung (in f64). */
export function makeToLocal(o: Vec2): (p: Vec2) => Vec2 {
  return (p) => ({ x: p.x * PX_PER_M - o.x, y: -p.y * PX_PER_M - o.y });
}

/** Absoluter Ausschnitt → lokaler. */
export function localView(view: ViewBox, o: Vec2): ViewBox {
  return { x: view.x - o.x, y: view.y - o.y, w: view.w, h: view.h };
}

/** `viewBox`-Attribut des lokalen Ausschnitts. */
export function localViewBoxAttr(view: ViewBox, o: Vec2): string {
  return `${view.x - o.x} ${view.y - o.y} ${view.w} ${view.h}`;
}
