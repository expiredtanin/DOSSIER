// Auswahl-Slice: die Auswahl als EIN Wert (`Selection`, je Art eine Menge, [130])
// plus der Isolations-Pfad der Gruppen. Bezeichner englisch, Kommentare deutsch.

import type { StoreApi } from "./store";
import { EMPTY_SELECTION, mergeSelection } from "./selection";
import type { Selection } from "./selection";
import { unlockedSelection } from "../core";
import type { DesignOptionTarget } from "../core";
import type { Project } from "../model/types";

/** [272] Teil des Gesamtzustands, den die Varianten-Sperre liest (Projekt, Stift, Häkchen „sperren“). */
type LockState = { project?: Project; drawDesignOption?: DesignOptionTarget | null; designOptionLock?: boolean };

/** [272] Bearbeitungsvariante, deren Aussenstehendes gesperrt ist (Stift + Häkchen „sperren“), sonst `null`. */
function lockEdit(s: unknown): { project: Project; edit: DesignOptionTarget } | null {
  const r = s as LockState;
  return r.designOptionLock && r.drawDesignOption && r.project ? { project: r.project, edit: r.drawDesignOption } : null;
}

/**
 * [272] „Elemente ausserhalb der Variante sperren“: die Auswahl nimmt sie nie auf — EIN Ort für Klick, Rechteck, 3D-Pick,
 * „Alles wählen“ und Befehle; Griffe, Objekt-Info und Bearbeitungsbefehle sehen sie darum nicht.
 */
function withoutLocked(s: unknown, sel: Partial<Selection>): Partial<Selection> {
  const l = lockEdit(s);
  return l ? unlockedSelection(l.project, l.edit, sel) : sel;
}

/** [272] Nach Wechsel von Stift oder Häkchen „sperren“: gesperrte Elemente aus der Auswahl nehmen. */
export function pruneLockedSelection(api: { set: (patch: (s: SelectionSlice) => Partial<SelectionSlice>) => void }): void {
  api.set((s) => {
    const next = withoutLocked(s, s.selection);
    return next === s.selection ? {} : { selection: mergeSelection(s.selection, next) };
  });
}

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
      set((s) => ({ selection: mergeSelection(s.selection, withoutLocked(s, typeof patch === "function" ? patch(s.selection) : patch)) })),
    setGroupPath: (path) => set({ groupPath: path }),
    // groupPath (Isolation) bleibt bewusst erhalten — Leerraum-Klick INNERHALB
    // einer betretenen Gruppe soll nur deren Auswahl leeren, nicht aus der
    // Gruppe hinauswerfen (Vectorworks-Verhalten). Verlassen ist ein
    // expliziter Schritt (Knopf/Escape, s. `useGroupHandlers.ts`).
    clearSelection: () =>
      set((s) => ({ selection: mergeSelection(s.selection, EMPTY_SELECTION) })),
  };
}
