// History-Slice: Undo/Redo für das Projekt-Modell ([8], [K4] S3). Der Verlauf liegt im Rust-Kern
// (`src-tauri/core/src/ops.rs`, `document.rs`): je Schritt die Vorwärts- und die inversen Ops —
// keine Projekt-Schnappschüsse mehr. Gleicher `coalesceKey` im Zeitfenster = ein Schritt (Drag,
// Regler), Gruppen (`groupChanges`) fassen mehrere Änderungen zusammen; begrenzt auf
// {@link HISTORY_LIMIT} Schritte und {@link HISTORY_MAX_BYTES}.
//
// `setProject` (projectSlice.ts) ist die EINZIGE Stelle, durch die jede Projekt-Mutation läuft: es
// übergibt die Ops dem Kern-Dokument des Stores ({@link storeDocument}). `undo`/`redo` holen die
// Ops vom Kern und führen die TS-Leseansicht damit nach (direkt über `set()`, kein neuer Schritt).
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Project } from "../model/types";
import { ProjectDocument, setPrimaryDocument } from "../core/document";
import type { StoreApi } from "./store";

/** Obergrenze der Undo-Tiefe — ältere Schritte fallen hinten raus. */
export const HISTORY_LIMIT = 100;
/** Ungefähre Speichergrenze des Verlaufs (Bytes) — ältere Schritte fallen hinten raus. */
export const HISTORY_MAX_BYTES = 256 * 1024 * 1024;

/** Felder, die diese Slice in den RootState beisteuert. */
export interface HistorySlice {
  /** Anzahl Undo-Schritte im Kern. */
  undoDepth: number;
  /** Anzahl Redo-Schritte im Kern. */
  redoDepth: number;
  /** Abgeleitet aus `undoDepth > 0` — bequem für UI-Bindings (Buttons/Menüs). */
  canUndo: boolean;
  /** Abgeleitet aus `redoDepth > 0`. */
  canRedo: boolean;
  /** Einen Schritt zurück. No-Op (kein Crash), wenn nichts rückgängig zu machen ist. */
  undo: () => void;
  /** Einen Schritt vor. No-Op (kein Crash), wenn nichts wiederherzustellen ist. */
  redo: () => void;
  /** Verlauf leeren. */
  clearHistory: () => void;
  /** Alle Projekt-Änderungen in `fn` werden EIN Undo-Schritt. */
  groupChanges: (fn: () => void) => void;
}

let doc: ProjectDocument | null = null;

/**
 * Das Kern-Dokument des Stores (mit Verlauf), beim ersten Gebrauch aus `project` geöffnet. Es ist
 * zugleich das Dokument, über das die Abfragen auf dem aktuellen Projekt laufen (`documentFor`).
 */
export function storeDocument(project: Project): ProjectDocument {
  if (!doc) {
    doc = new ProjectDocument(project);
    doc.setHistoryLimits(HISTORY_LIMIT, HISTORY_MAX_BYTES);
    setPrimaryDocument(doc);
  }
  return doc;
}

/** Verlaufs-Felder für den Store aus dem Stand im Kern. */
export function historyPatch(d: ProjectDocument): Pick<HistorySlice, "undoDepth" | "redoDepth" | "canUndo" | "canRedo"> {
  const h = d.historyState();
  return { undoDepth: h.undo, redoDepth: h.redo, canUndo: h.undo > 0, canRedo: h.redo > 0 };
}

/** Baut `undo`/`redo` + initialen Zustand. */
export function createHistorySlice(api: StoreApi<HistorySlice & { project: Project }>): HistorySlice {
  const { set, get } = api;

  const jump = (dir: "undo" | "redo") => {
    const { project } = get();
    const d = storeDocument(project);
    const next = dir === "undo" ? d.undo(project) : d.redo(project);
    set(next ? { project: next, ...historyPatch(d) } : historyPatch(d));
  };

  return {
    undoDepth: 0,
    redoDepth: 0,
    canUndo: false,
    canRedo: false,
    undo: () => jump("undo"),
    redo: () => jump("redo"),
    clearHistory: () => {
      const d = storeDocument(get().project);
      d.clearHistory();
      set(historyPatch(d));
    },
    groupChanges: (fn) => {
      const d = storeDocument(get().project);
      d.beginGroup();
      try {
        fn();
      } finally {
        d.endGroup();
      }
    },
  };
}
