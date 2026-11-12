// Status-Leiste der App ([163], aus App.tsx herausgelöst): Werkzeug-Hinweis („Auswahl: n Wände")
// und aktive Ebene (Kategorie der einzeln gewählten Wand, sonst die aktive Kategorie). Gewählte Wände,
// die es nicht mehr gibt, fallen heraus. Aufgerufen von `App.tsx`; die Werte gehen an `StatusBar`.

import { categoryLabel } from "../model/layers";
import { useStore } from "./appStore";
import { t } from "../i18n";
import type { useSelectionState } from "./useSelectionState";
import { ELEMENT_KINDS, type Selection } from "./selection";

export function useStatusBarInfo(opts: {
  selection: ReturnType<typeof useSelectionState>["selection"];
  activeCategoryCode: string;
}) {
  const { selection, activeCategoryCode } = opts;

  // Tatsächlich (noch) existierende gewählte Wände — IDs, die es nicht mehr gibt
  // (z. B. nach Löschen/Geschosswechsel), fallen heraus. Schmale Selektoren ([121]): nur Anzahl und
  // Kategorie der ersten gewählten Wand, damit eine Wand-Änderung den Aufrufer (`App`) nicht rendert.
  const selWalls = selection.walls;
  const selectionCount = useStore((s) => {
    if (selWalls.length === 0) return 0;
    const ids = new Set(selWalls);
    let n = 0;
    for (const w of s.project.walls) if (ids.has(w.id)) n++;
    return n;
  });
  // Kategorie der ersten gewählten Wand (Reihenfolge des Projekts, wie zuvor `filter(...)[0]`).
  const selectedWallCategory = useStore((s) => {
    if (selWalls.length === 0) return null;
    const ids = new Set(selWalls);
    return s.project.walls.find((w) => ids.has(w.id))?.categoryCode ?? null;
  });
  const layers = useStore((s) => s.project.layers);

  // Aktive Ebene (Kategorie) der Status-Leiste: die Kategorie der (ersten)
  // gewählten Wand, sonst „—" (es gibt keine eigenständige Kategorie-Selektion).
  const activeLayerName =
    selectionCount === 1 && selectedWallCategory !== null
      ? categoryLabel(layers, selectedWallCategory)
      : categoryLabel(layers, activeCategoryCode);
  // Kontextueller Werkzeug-Hinweis (links), s. `selectionHint`.
  const toolHint = selectionHint(selection, selectionCount);

  return { toolHint, activeLayerName };
}

/**
 * Werkzeug-Hinweis der Status-Leiste: 0 → „Auswahl", nur Wände → „Auswahl: 1 Wand" / „n Wände", sonst
 * „Auswahl: n Element(e)" über alle Bauteilarten. [204] Vorher zählten nur Wände: eine gewählte Tür oder Treppe
 * zeigte „Auswahl", eine eingefügte Wand samt Öffnungen „1 Wand". `wallCount` = noch vorhandene gewählte Wände;
 * Gruppen zählen nicht (ihre Mitglieder stehen in den übrigen Arten).
 */
export function selectionHint(selection: Selection, wallCount: number): string {
  const others = ELEMENT_KINDS.reduce((n, k) => (k === "walls" ? n : n + selection[k].length), 0);
  const n = wallCount + others;
  if (n === 0) return t("status.selection");
  const noun = others === 0 ? (n === 1 ? t("status.wall") : t("status.walls")) : n === 1 ? t("status.element") : t("status.elements");
  return t("status.selectionN", { n, noun });
}
