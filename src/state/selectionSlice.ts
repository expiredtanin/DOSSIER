// Auswahl-Slice: die Auswahl als EIN Wert (`Selection`, je Art eine Menge, [130])
// plus der Isolations-Pfad der Gruppen. Bezeichner englisch, Kommentare deutsch.

import type { StoreApi } from "./store";
import { EMPTY_SELECTION, mergeSelection } from "./selection";
import type { Selection } from "./selection";

/** Felder, die diese Slice in den RootState beisteuert. */
export interface SelectionSlice {
  /** Gewählte Elemente je Art. Komponenten lesen schmal: `useStore(s => s.selection.walls)`. */
  selection: Selection;
  // Isolations-Pfad (Vectorworks „Gruppe betreten"): Stapel der Gruppen-IDs,
  // in die per Doppelklick navigiert wurde — leer = nicht isoliert (normal),
  // letztes Element = die AKTIVE (innerste) Gruppe. Alles ausserhalb ihrer
  // transitiven Mitgliedschaft wird gedimmt/gesperrt (s. `groupActions.ts`).
  groupPath: string[];

  /**
   * Ändert die genannten Arten (übrige bleiben). Gleicher Inhalt behält die alte
   * Referenz; ohne Änderung kein Benachrichtigen.
   */
  setSelection: (patch: Partial<Selection> | ((s: Selection) => Partial<Selection>)) => void;
  setGroupPath: (path: string[]) => void;
  /** Auswahl aller Arten (auch Gruppen) leeren. */
  clearSelection: () => void;
}

export function createSelectionSlice(
  api: StoreApi<SelectionSlice>,
): SelectionSlice {
  const { set } = api;
  return {
    selection: EMPTY_SELECTION,
    groupPath: [],
    setSelection: (patch) =>
      set((s) => ({ selection: mergeSelection(s.selection, typeof patch === "function" ? patch(s.selection) : patch) })),
    setGroupPath: (path) => set({ groupPath: path }),
    // groupPath (Isolation) bleibt bewusst erhalten — Leerraum-Klick INNERHALB
    // einer betretenen Gruppe soll nur deren Auswahl leeren, nicht aus der
    // Gruppe hinauswerfen (Vectorworks-Verhalten). Verlassen ist ein
    // expliziter Schritt (Knopf/Escape, s. `useGroupHandlers.ts`).
    clearSelection: () =>
      set((s) => ({ selection: mergeSelection(s.selection, EMPTY_SELECTION) })),
  };
}
