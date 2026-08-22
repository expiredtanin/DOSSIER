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
  // Gewählte Kontext-Objekte (importierte Gebäude/Terrain) als MENGE von IDs.
  selectedContextObjectIds: string[];
  // Gewählte Schnitt-/Ansichtslinie (DrawingLevel-Id) — EINZELauswahl (eine Linie
  // zur Zeit), getrennt von den übrigen Kanälen. `null` = keine Linie gewählt.
  selectedSectionLineId: string | null;
  // Gewählte Gruppen (Vectorworks-artig) als MENGE von IDs — rein informativ/
  // fürs UI (Bounding-Box, Doppelklick-Ziel); die eigentlichen Mitglieder
  // stehen zusätzlich in den übrigen `selected…Ids`-Kanälen (Verschieben/
  // Löschen/etc. brauchen so keine Gruppen-Sonderbehandlung), s. `groupActions.ts`.
  selectedGroupIds: string[];
  // Isolations-Pfad (Vectorworks „Gruppe betreten"): Stapel der Gruppen-IDs,
  // in die per Doppelklick navigiert wurde — leer = nicht isoliert (normal),
  // letztes Element = die AKTIVE (innerste) Gruppe. Alles ausserhalb ihrer
  // transitiven Mitgliedschaft wird gedimmt/gesperrt (s. `groupActions.ts`).
  groupPath: string[];

  setSelectedWallIds: (ids: string[]) => void;
  setSelectedDrawingIds: (ids: string[]) => void;
  setSelectedCeilingIds: (ids: string[]) => void;
  setSelectedOpeningIds: (ids: string[]) => void;
  setSelectedStairIds: (ids: string[]) => void;
  setSelectedRoomIds: (ids: string[]) => void;
  setSelectedExtrudedSolidIds: (ids: string[]) => void;
  setSelectedColumnIds: (ids: string[]) => void;
  setSelectedRoofIds: (ids: string[]) => void;
  setSelectedContextObjectIds: (ids: string[]) => void;
  setSelectedSectionLineId: (id: string | null) => void;
  setSelectedGroupIds: (ids: string[]) => void;
  setGroupPath: (path: string[]) => void;
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
    selectedContextObjectIds: [],
    selectedSectionLineId: null,
    selectedGroupIds: [],
    groupPath: [],
    setSelectedWallIds: (ids) => set({ selectedWallIds: ids }),
    setSelectedDrawingIds: (ids) => set({ selectedDrawingIds: ids }),
    setSelectedCeilingIds: (ids) => set({ selectedCeilingIds: ids }),
    setSelectedOpeningIds: (ids) => set({ selectedOpeningIds: ids }),
    setSelectedStairIds: (ids) => set({ selectedStairIds: ids }),
    setSelectedRoomIds: (ids) => set({ selectedRoomIds: ids }),
    setSelectedExtrudedSolidIds: (ids) => set({ selectedExtrudedSolidIds: ids }),
    setSelectedColumnIds: (ids) => set({ selectedColumnIds: ids }),
    setSelectedRoofIds: (ids) => set({ selectedRoofIds: ids }),
    setSelectedContextObjectIds: (ids) => set({ selectedContextObjectIds: ids }),
    setSelectedSectionLineId: (id) => set({ selectedSectionLineId: id }),
    setSelectedGroupIds: (ids) => set({ selectedGroupIds: ids }),
    setGroupPath: (path) => set({ groupPath: path }),
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
        selectedContextObjectIds: [],
        selectedSectionLineId: null,
        selectedGroupIds: [],
        // groupPath (Isolation) bleibt bewusst erhalten — Leerraum-Klick INNERHALB
        // einer betretenen Gruppe soll nur deren Auswahl leeren, nicht aus der
        // Gruppe hinauswerfen (Vectorworks-Verhalten). Verlassen ist ein
        // expliziter Schritt (Knopf/Escape, s. `useGroupHandlers.ts`).
      }),
  };
}
