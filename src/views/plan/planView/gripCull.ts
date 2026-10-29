// Welche Editier-Griffe die Plan-Ansicht zeichnet, wenn ein Element sehr viele Stützpunkte hat
// (Kataster: Strassenparzellen, Bodenbedeckung mit tausenden Ecken; Fehlerbericht 29.10.). Je Griff
// ein SVG-Element wären dann zehntausende DOM-Knoten. Gezeichnet werden nur die Griffe im Ausschnitt
// (mit Rand, damit kleines Schwenken nichts abschneidet) und je Bildschirmzelle nur einer —
// übereinanderliegende Griffe sähe man ohnehin nicht. Das Treffen eines Griffs (Ziehen) rechnet
// weiter über alle Griffe, unabhängig davon, was gezeichnet ist.
//
// Unterhalb von `GRIP_CULL_FROM` Griffen ändert sich nichts: alle werden gezeichnet.

import type { Vec2 } from "../../../model/types";
import type { ViewBox__plan_planView_geometry as ViewBox } from "../../../core";

/** Ab so vielen Griffen wird ausgedünnt. */
export const GRIP_CULL_FROM = 400;
/** Höchstens so viele Griffe gleichzeitig im DOM. */
export const GRIP_DRAW_MAX = 4000;
/** Kantenlänge einer Bildschirmzelle in px (Griff-Radius ≈ 4.5 px). */
const CELL_PX = 3;

/**
 * Indizes der zu zeichnenden Griffe in Reihenfolge, oder `null` = alle zeichnen (wenige Griffe).
 * `toVb` bildet Modell → viewBox-Einheiten ab (`toScreen`), `view` ist der aktuelle Ausschnitt,
 * `meet` Bildschirm-px je viewBox-Einheit.
 */
export function visibleGripIndices(
  pts: readonly Vec2[],
  toVb: (p: Vec2) => Vec2,
  view: ViewBox,
  meet: number,
): number[] | null {
  if (pts.length < GRIP_CULL_FROM) return null;
  // Rand = grössere Ausschnitt-Kante je Seite: deckt auch die Streifen ab, die `meet` bei anderem
  // Seitenverhältnis des Fensters zusätzlich zeigt.
  const pad = Math.max(view.w, view.h);
  const x0 = view.x - pad;
  const x1 = view.x + view.w + pad;
  const y0 = view.y - pad;
  const y1 = view.y + view.h + pad;
  const cell = meet > 0 && Number.isFinite(meet) ? CELL_PX / meet : 0;
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i < pts.length && out.length < GRIP_DRAW_MAX; i++) {
    const s = toVb(pts[i]);
    if (!(s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1)) continue;
    if (cell > 0) {
      // Zelle relativ zum Ausschnitt: bei LV95 (≈ 2.3e8 Einheiten) bleiben die Schlüssel klein.
      const key = `${Math.floor((s.x - x0) / cell)},${Math.floor((s.y - y0) / cell)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(i);
  }
  return out;
}
