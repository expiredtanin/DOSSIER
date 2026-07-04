// History-Slice: Undo/Redo für das Projekt-Modell. Reine Snapshot-Historie —
// dank immutabler Updates in `projectSlice.ts` (jede echte Änderung liefert
// eine NEUE `Project`-Referenz mit structural sharing) ist ein Stack aus
// `Project`-Werten billig (kein Deep-Clone nötig, unveränderte Teilbäume
// werden zwischen den Snapshots geteilt).
//
// Die eigentliche Buchführung (WANN wird gepusht, Koaleszenz von Drag-Serien)
// lebt bewusst in `projectSlice.ts` bei `setProject` selbst — das ist die
// EINZIGE Stelle, durch die jede Projekt-Mutation läuft. Dieses Modul liefert
// nur den reaktiven Zustand (Stacks + Flags) und die `undo`/`redo`-Aktionen,
// die DIREKT über `set()` schreiben (NICHT über `setProject`), damit sie
// keinen neuen History-Eintrag erzeugen (sonst Endlosschleife/kaputte
// Historie). Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Project } from "../model/types";
import type { StoreApi } from "./store";

/** Obergrenze der Undo-Tiefe — ältere Einträge fallen hinten raus (Speicher/Performance). */
export const HISTORY_LIMIT = 100;

/** Felder, die diese Slice in den RootState beisteuert. */
export interface HistorySlice {
  /** Ältere Projekt-Stände (oben = zuletzt verlassener Stand, für `undo`). */
  undoStack: Project[];
  /** Durch `undo` verlassene Stände (oben = zuletzt verlassener, für `redo`). */
  redoStack: Project[];
  /** Abgeleitet aus `undoStack.length > 0` — bequem für UI-Bindings (Buttons/Menüs). */
  canUndo: boolean;
  /** Abgeleitet aus `redoStack.length > 0`. */
  canRedo: boolean;
  /** Einen Schritt zurück. No-Op (kein Crash), wenn der Undo-Stack leer ist. */
  undo: () => void;
  /** Einen Schritt vor. No-Op (kein Crash), wenn der Redo-Stack leer ist. */
  redo: () => void;
}

/**
 * Reines Patch-Berechnen für einen History-Push — von `setProject` (in
 * `projectSlice.ts`) bei jeder ECHTEN Projekt-Änderung aufgerufen (kein
 * Store-Zugriff nötig, daher hier als freie Funktion statt Store-Aktion: so
 * lässt sich der Push in EINEM gemeinsamen `set()`-Aufruf mit der eigentlichen
 * `project`-Änderung zusammenfassen, statt einen zweiten, verschachtelten
 * `set()`-Aufruf auszulösen).
 *
 * Eine neue Aktion verwirft immer die Redo-Historie (Standardverhalten jedes
 * Undo/Redo-Systems: sobald der Nutzer nach einem `undo()` etwas Neues tut,
 * ist der alte "vordere" Zweig weg).
 */
export function pushHistoryPatch(
  undoStack: Project[],
  prevProject: Project,
): Pick<HistorySlice, "undoStack" | "redoStack" | "canUndo" | "canRedo"> {
  const next = [...undoStack, prevProject];
  if (next.length > HISTORY_LIMIT) next.shift();
  return { undoStack: next, redoStack: [], canUndo: true, canRedo: false };
}

/**
 * Baut `undo`/`redo` + initialen Zustand. `onAfterJump` wird nach jedem
 * Sprung aufgerufen (projectSlice.ts nutzt das, um die Koaleszenz-Buchführung
 * für Drag-Serien zurückzusetzen — sonst könnte eine neue Aktion direkt nach
 * einem `undo()` fälschlich mit der VORHERIGEN Serie verschmolzen und dadurch
 * NIE auf dem Undo-Stack landen).
 */
export function createHistorySlice(
  api: StoreApi<HistorySlice & { project: Project }>,
  onAfterJump?: () => void,
): HistorySlice {
  const { set, get } = api;

  return {
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,

    undo: () => {
      const { undoStack, redoStack, project } = get();
      if (undoStack.length === 0) return;
      const prev = undoStack[undoStack.length - 1];
      const rest = undoStack.slice(0, -1);
      set({
        project: prev,
        undoStack: rest,
        redoStack: [...redoStack, project],
        canUndo: rest.length > 0,
        canRedo: true,
      });
      onAfterJump?.();
    },

    redo: () => {
      const { undoStack, redoStack, project } = get();
      if (redoStack.length === 0) return;
      const next = redoStack[redoStack.length - 1];
      const rest = redoStack.slice(0, -1);
      set({
        project: next,
        undoStack: [...undoStack, project],
        redoStack: rest,
        canUndo: true,
        canRedo: rest.length > 0,
      });
      onAfterJump?.();
    },
  };
}
