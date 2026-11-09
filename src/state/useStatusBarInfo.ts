// Status-Leiste der App ([163], aus App.tsx herausgelöst): Werkzeug-Hinweis („Auswahl: n Wände")
// und aktive Ebene (Kategorie der einzeln gewählten Wand, sonst die aktive Kategorie). Gewählte Wände,
// die es nicht mehr gibt, fallen heraus. Aufgerufen von `App.tsx`; die Werte gehen an `StatusBar`.

import { useMemo } from "react";
import type { Project } from "../model/types";
import { categoryLabel } from "../model/layers";
import { t } from "../i18n";
import type { useSelectionState } from "./useSelectionState";

export function useStatusBarInfo(opts: {
  project: Project;
  selection: ReturnType<typeof useSelectionState>["selection"];
  activeCategoryCode: string;
}) {
  const { project, selection, activeCategoryCode } = opts;

  // Tatsächlich (noch) existierende gewählte Wände — IDs, die es nicht mehr gibt
  // (z. B. nach Löschen/Geschosswechsel), fallen heraus.
  const selectedWalls = useMemo(() => {
    const ids = new Set(selection.walls);
    return project.walls.filter((w) => ids.has(w.id));
  }, [project.walls, selection.walls]);
  const selectionCount = selectedWalls.length;
  // Erste gewählte Wand (für Status-Leiste / Kontextmenü-Aktionen mit Einzelbezug).
  const selectedWall = selectedWalls[0] ?? null;

  // Aktive Ebene (Kategorie) der Status-Leiste: die Kategorie der (ersten)
  // gewählten Wand, sonst „—" (es gibt keine eigenständige Kategorie-Selektion).
  const activeLayerName =
    selectionCount === 1 && selectedWall
      ? categoryLabel(project.layers, selectedWall.categoryCode)
      : categoryLabel(project.layers, activeCategoryCode);
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
