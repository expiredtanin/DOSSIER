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
  // Gewählte Decken als MENGE von IDs — getrennt von Wand-/2D-Auswahl.
  selectedCeilingIds: string[];
  // Gewählte Öffnungen (Fenster/Türen) als MENGE von IDs — getrennt.
  selectedOpeningIds: string[];
  // Gewählte Treppen als MENGE von IDs — getrennt von den übrigen Kanälen.
  selectedStairIds: string[];
  // Gewählte Räume als MENGE von IDs — getrennt von den übrigen Kanälen.
  selectedRoomIds: string[];
  // Gewählte extrudierte Körper (truck-Integration) als MENGE von IDs — getrennt.
  selectedExtrudedSolidIds: string[];
  // Gewählte Stützen (Tragwerk) als MENGE von IDs — getrennt von den übrigen Kanälen.
  selectedColumnIds: string[];
  // Gewählte Dächer als MENGE von IDs — getrennt von den übrigen Kanälen.
  selectedRoofIds: string[];
  // Gewählte Schnitt-/Ansichtslinie (DrawingLevel-Id) — EINZELauswahl (eine Linie
  // zur Zeit), getrennt von den übrigen Kanälen. `null` = keine Linie gewählt.
  selectedSectionLineId: string | null;

  setSelectedWallIds: (ids: string[]) => void;
  setSelectedDrawingIds: (ids: string[]) => void;
  setSelectedCeilingIds: (ids: string[]) => void;
  setSelectedOpeningIds: (ids: string[]) => void;
  setSelectedStairIds: (ids: string[]) => void;
  setSelectedRoomIds: (ids: string[]) => void;
  setSelectedExtrudedSolidIds: (ids: string[]) => void;
  setSelectedColumnIds: (ids: string[]) => void;
  setSelectedRoofIds: (ids: string[]) => void;
  setSelectedSectionLineId: (id: string | null) => void;
  /** Auswahl (Wände + Decken + Öffnungen + Treppen + Dächer + 2D-Elemente) leeren. */
  clearSelection: () => void;
}

export function createSelectionSlice(
  api: StoreApi<SelectionSlice>,
): SelectionSlice {
  const { set } = api;
  return {
    selectedWallIds: [],
    selectedDrawingIds: [],
    selectedCeilingIds: [],
    selectedOpeningIds: [],
    selectedStairIds: [],
    selectedRoomIds: [],
    selectedExtrudedSolidIds: [],
    selectedColumnIds: [],
    selectedRoofIds: [],
    selectedSectionLineId: null,
    setSelectedWallIds: (ids) => set({ selectedWallIds: ids }),
    setSelectedDrawingIds: (ids) => set({ selectedDrawingIds: ids }),
    setSelectedCeilingIds: (ids) => set({ selectedCeilingIds: ids }),
    setSelectedOpeningIds: (ids) => set({ selectedOpeningIds: ids }),
    setSelectedStairIds: (ids) => set({ selectedStairIds: ids }),
    setSelectedRoomIds: (ids) => set({ selectedRoomIds: ids }),
    setSelectedExtrudedSolidIds: (ids) => set({ selectedExtrudedSolidIds: ids }),
    setSelectedColumnIds: (ids) => set({ selectedColumnIds: ids }),
    setSelectedRoofIds: (ids) => set({ selectedRoofIds: ids }),
    setSelectedSectionLineId: (id) => set({ selectedSectionLineId: id }),
    clearSelection: () =>
      set({
        selectedWallIds: [],
        selectedDrawingIds: [],
        selectedCeilingIds: [],
        selectedOpeningIds: [],
        selectedStairIds: [],
        selectedRoomIds: [],
        selectedExtrudedSolidIds: [],
        selectedColumnIds: [],
        selectedRoofIds: [],
        selectedSectionLineId: null,
      }),
  };
}
