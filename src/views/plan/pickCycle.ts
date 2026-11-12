// [137] Klick-Zyklus (übliches CAD-Verhalten): ein erneuter einfacher Klick an derselben Stelle wählt das nächste
// Objekt unter dem Cursor — so erreicht man in dichten Plänen (Situation 1:500: Bemassung über Schatten und Gelände)
// auch die unteren Objekte ohne Cmd/Strg+Klick-Liste. Doppelklick (< 400 ms) schaltet nicht; ebenso wenig, wenn die
// Auswahl inzwischen anders ist (Escape, Panel), der Plan wechselte oder nur ein Objekt dort liegt.

import type { PickKind } from "../../core";
import { t } from "../../i18n";
import type { Selection, SelectionKind } from "../../state/selection";

/** Toleranz der „gleichen Stelle" (Bildschirm-px) und Doppelklick-Zeit (ms). */
export const CYCLE_RADIUS_PX = 5;
export const DOUBLE_CLICK_MS = 400;

export interface CycleItem {
  kind: PickKind;
  id: string;
}

/** Zustand nach dem letzten einfachen Klick: Kandidaten an der Stelle und der angewandte Index. */
export interface PlainCycle<T extends CycleItem = CycleItem> {
  x: number;
  y: number;
  t: number;
  /** Plan-Identität (anderer Plan = neue Liste). */
  planKey: unknown;
  items: T[];
  idx: number;
}

const KIND_FIELD: Record<PickKind, SelectionKind> = {
  section: "sectionLines",
  opening: "openings",
  wall: "walls",
  column: "columns",
  drawing: "drawings",
  solid: "solids",
  tree: "trees",
  camera: "cameras",
  ceiling: "ceilings",
  stair: "stairs",
  room: "rooms",
  roof: "roofs",
  site: "site",
  context: "contextObjects",
};

/** Ist das Objekt (noch) gewählt? */
export function selectionHas(sel: Selection | undefined, c: CycleItem): boolean {
  return !!sel && sel[KIND_FIELD[c.kind]].includes(c.id);
}

/**
 * Index des nächsten Kandidaten, wenn dieser Klick den Zyklus fortsetzt — sonst `null` (normaler Klick mit
 * Standard-Priorität).
 */
export function plainCycleNext(
  prev: PlainCycle | null,
  click: { x: number; y: number; t: number; planKey: unknown },
  selection: Selection | undefined,
): number | null {
  if (!prev || prev.items.length < 2 || prev.planKey !== click.planKey) return null;
  if (Math.hypot(click.x - prev.x, click.y - prev.y) > CYCLE_RADIUS_PX) return null;
  if (click.t - prev.t < DOUBLE_CLICK_MS) return null;
  if (!selectionHas(selection, prev.items[prev.idx])) return null;
  return (prev.idx + 1) % prev.items.length;
}

/** Statusleisten-Hinweis „2/3 Treffer — erneut klicken zum Wechseln" (nur bei mehreren Objekten). */
export function cycleHint(n: number, idx: number): string | null {
  return n > 1 ? t("pick.cycle.hint", { i: idx + 1, n }) : null;
}
