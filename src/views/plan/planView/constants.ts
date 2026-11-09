// Konstanten und kleine Hilfen der Plan-Ansicht (`PlanView.tsx`): Culling-Schwellen, Zoom-Grenzen,
// Treffer-Toleranzen, Pick-Reihenfolge. [165] aus `PlanView.tsx` herausgelöst; gerufen von
// `PlanView.tsx` und den Hooks in `planView/`.

import type { PickKind } from "../../../core";
import { expandRegion, regionContains, type Bounds } from "../../../core";
import type { ViewBox__plan_planView_geometry as ViewBox } from "../../../core";
import type { PickIds } from "./types";

// Viewport-Culling (s. `cullPrimitives.ts`): erst ab dieser Primitiv-Anzahl
// aktiv — normale Projekte liegen weit darunter und bleiben unverändert.
export const CULL_THRESHOLD = 5000;
// Puffer um `view` als Vielfaches der View-Grösse je Seite (50 % → ein
// Schwenk muss schon über die halbe Bildschirmbreite hinausgehen, bevor neu
// gerechnet wird).
export const CULL_MARGIN_FACTOR = 0.5;
export const cullMargin = (vb: ViewBox) => Math.max(vb.w, vb.h) * CULL_MARGIN_FACTOR;
// Text-Primitive unter dieser Höhe (als Anteil der aktuellen View-Höhe)
// gelten als unleserlich und werden gar nicht erst gerendert (s.
// `isTooSmallToRead` in cullPrimitives.ts) — unabhängig von der Position.
// 0.5 % einer typischen Bildschirmhöhe (~800 px) sind ~4 px, die Schwelle,
// ab der Text praktisch ohnehin nicht mehr lesbar ist.
export const MIN_RELATIVE_TEXT_HEIGHT = 0.002;
// Reingezoomt seit der letzten Neuberechnung (View < 75 % der Grösse, für die
// die Lesbarkeits-Schwelle berechnet wurde) → neu rechnen, auch wenn `view`
// noch in der gepufferten Region liegt — sonst bliebe die Schwelle (an der
// ALTEN, grösseren View-Höhe bemessen) zu streng und Text, der beim aktuellen
// Zoom längst lesbar wäre, bliebe unsichtbar. Früher 30 %: da lief das Culling
// noch über ALLE Primitive (Mio. bei Kataster-Importen) und durfte selten
// laufen; seit `svgCandidates` filtert es nur noch die SVG-Elemente (Texte,
// ~10^4–10^5) und ist billig — bei 30 % blieben Beschriftungen beim Reinzoomen
// bis zu 3,3× zu lange ausgeblendet.
export const CULL_RESCALE_FACTOR = 0.75;

export interface CullState {
  region: Bounds;
  minTextHeightVb: number;
  forViewW: number;
  forViewH: number;
}
export function computeCullState(view: ViewBox): CullState {
  return {
    region: expandRegion(view, cullMargin(view)),
    minTextHeightVb: view.h * MIN_RELATIVE_TEXT_HEIGHT,
    forViewW: view.w,
    forViewH: view.h,
  };
}
export function cullStateStale(s: CullState, view: ViewBox): boolean {
  if (!regionContains(s.region, view)) return true;
  return view.w < s.forViewW * CULL_RESCALE_FACTOR || view.h < s.forViewH * CULL_RESCALE_FACTOR;
}

// Zoom-Grenzen relativ zur eingepassten Default-Ansicht. Kleinere viewBox-
// Breite = stärkerer Zoom. ZOOM_MAX → max. Hineinzoomen, ZOOM_MIN → Herauszoomen.
// Grosszügig bemessen (CAD-Anspruch: vom Milimeter-Detail bis zum Siedlungs-
// Kontext) statt der früheren 250×-Spanne (50/0.2), die für Detailarbeit an
// einem Gebäude deutlich zu eng war.
export const ZOOM_MAX = 20000; // bis 20 000× hinein (Sub-Millimeter-Details)
export const ZOOM_MIN = 0.005; // bis 200× heraus (Siedlungs-/Site-Kontext)
export const WHEEL_STEP = 0.001; // Empfindlichkeit des Mausrads
export const WHEEL_MAX_DELTA = 100; // grosse Rad-/Trackpad-Ausschläge pro Ereignis begrenzen

// Schwelle (Bildschirm-Pixel), ab der ein Links-Ziehen als Marquee gilt; darunter
// bleibt es ein Klick (Einzelwahl). Verhindert versehentliche Mini-Rechtecke.
export const MARQUEE_THRESHOLD_PX = 4;

// Trefferradius (Bildschirm-Pixel) für das Greifen eines Editier-Griffs.
export const GRIP_HIT_PX = 9;
// Toleranz (Bildschirm-Pixel) für die Linien-Auswahl von 2D-Zeichenelementen.
export const LINE_PICK_PX = 6;

export const PICK_ORDER: readonly PickKind[] = [
  "section", "opening", "wall", "column", "drawing", "solid", "tree",
  "ceiling", "stair", "room", "roof", "site", "context",
];

export const EMPTY_PICK: PickIds = {
  hitIndex: null,
  wallId: null,
  drawingId: null,
  ceilingId: null,
  openingId: null,
  stairId: null,
  roomId: null,
  extrudedSolidId: null,
  columnId: null,
  roofId: null,
  sectionLineId: null,
  contextObjectId: null,
  siteId: null,
  treeId: null,
};

/** Mac: Cmd+Klick; sonst Strg+Klick (Alt+Klick ist die Schere, Ctrl+Klick unter macOS das Kontextmenü). */
/** [149] Präfix der Baum-Pick-Id im Feld `contextObjectId` (Kern `tree::TREE_PICK_PREFIX`). */
export const TREE_PICK = "@tree:";

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const cycleModifier = (e: { metaKey: boolean; ctrlKey: boolean }): boolean => (IS_MAC ? e.metaKey : e.ctrlKey);
