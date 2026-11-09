// Status-Leiste der App ([163], aus App.tsx herausgelöst): Werkzeug-Hinweis („Auswahl: n Wände")
// und aktive Ebene (Kategorie der einzeln gewählten Wand, sonst die aktive Kategorie). Gewählte Wände,
// die es nicht mehr gibt, fallen heraus. Aufgerufen von `App.tsx`; die Werte gehen an `StatusBar`.

import { categoryLabel } from "../model/layers";
import { useStore } from "./appStore";
import { t } from "../i18n";
import type { useSelectionState } from "./useSelectionState";

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
  // Kontextueller Werkzeug-Hinweis (links). Zeigt die Anzahl gewählter Wände:
  // 0 → „Auswahl", 1 → „Auswahl: 1 Wand", n → „Auswahl: n Wände".
  const toolHint =
    selectionCount === 0
      ? t("status.selection")
      : t("status.selectionN", {
          n: selectionCount,
          noun: selectionCount === 1 ? t("status.wall") : t("status.walls"),
        });

  return { toolHint, activeLayerName };
}
