// Auswahl-Slice: gewählte Wände (Menge) und das gewählte 2D-Zeichenelement.
// Wand- und 2D-Auswahl schließen sich gegenseitig aus. Reiner Umzug aus
// App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { StoreApi } from "./store";

/** Felder, die diese Slice in den RootState beisteuert. */
export interface SelectionSlice {
  // Gewählte Wände als MENGE von IDs (Marquee/Einzelauswahl).
  selectedWallIds: string[];
  // Gewählte 2D-Zeichenelemente als MENGE (Marquee/Mehrfach/Einzel) — getrennt
  // von der Wand-Auswahl. Einzel-Auswahl = Array der Länge 1.
  selectedDrawingIds: string[];

  setSelectedWallIds: (ids: string[]) => void;
  setSelectedDrawingIds: (ids: string[]) => void;
  /** Auswahl (Wände + 2D-Elemente) vollständig leeren. */
  clearSelection: () => void;
}

export function createSelectionSlice(
  api: StoreApi<SelectionSlice>,
): SelectionSlice {
  const { set } = api;
  return {
    selectedWallIds: [],
    selectedDrawingIds: [],
    setSelectedWallIds: (ids) => set({ selectedWallIds: ids }),
    setSelectedDrawingIds: (ids) => set({ selectedDrawingIds: ids }),
    clearSelection: () =>
      set({ selectedWallIds: [], selectedDrawingIds: [] }),
  };
}
