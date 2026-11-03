// Test-Naht für die UI-Suite (`e2e/`), nur mit `?dossierTest` in der URL geladen (main.tsx): Dinge, die
// sich über die Oberfläche nicht auslösen lassen. Hier: ein absichtlicher Kern-Panic ([118],
// `__debug_panic` in `src-tauri/core/src/web/document.rs`), um den Wiederanlauf in echtem Chromium zu prüfen.

import { core, coreEpoch, coreReady } from "../engine/coreWasm";
import { getState } from "./appStore";
import { storeDocument } from "./historySlice";

declare global {
  interface Window {
    __dossierTest?: {
      /** Panic im Kern mitten im Zugriff auf das Store-Dokument; Ergebnis: Name des geworfenen Fehlers. */
      corePanic: () => string;
      /** Erfüllt, wenn der Kern wieder läuft. */
      coreReady: () => Promise<void>;
      coreEpoch: () => number;
      /** Zahl der Elemente je Liste des Projekts (Wände, Öffnungen, Zeichnungsebenen) und das Projekt im Kern als JSON-Länge. */
      counts: () => { walls: number; openings: number; drawingLevels: number; coreJson: number };
    };
  }
}

export function installTestHooks(): void {
  window.__dossierTest = {
    corePanic: () => {
      try {
        core().__debug_panic(storeDocument(getState().project).id);
      } catch (e) {
        return e instanceof Error ? e.name : String(e);
      }
      return "";
    },
    coreReady,
    coreEpoch,
    counts: () => {
      const p = getState().project;
      return { walls: p.walls.length, openings: p.openings?.length ?? 0, drawingLevels: p.drawingLevels.length, coreJson: storeDocument(p).json().length };
    },
  };
}
