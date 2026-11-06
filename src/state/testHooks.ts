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
      /** Endpunkte aller 2D-Linien des Projekts ([123] Transformations-Test). */
      lines: () => { a: { x: number; y: number }; b: { x: number; y: number } }[];
      /** [137] Polylinien-Punkte der 2D-Elemente mit Id-Präfix (Präsentations-Massstabsbalken). */
      polylines: (prefix: string) => { id: string; pts: { x: number; y: number }[] }[];
      /** [137] Gewählte 2D-Elemente und Gruppen. */
      selected: () => { drawings: string[]; groups: string[]; all: string };
      /** [144] Öffnungen (id, Wirtswand, Lage ab Wandanfang). */
      openings: () => { id: string; hostWallId: string; position: number }[];
      /** [144] Auswahl setzen (wie ein Klick), z. B. `{ openings: ["D1"] }`. */
      select: (patch: Record<string, string[]>) => void;
      /** [144] Punkte einer Bemassung (Kette) — folgt sie der Öffnung? */
      dimPts: (id: string) => { x: number; y: number }[];
      /** [144] Texte der Hinweise (Benachrichtigungen). */
      notices: () => string[];
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
    lines: () =>
      getState().project.drawings2d.flatMap((d) => (d.geom.shape === "line" ? [{ a: d.geom.a, b: d.geom.b }] : [])),
    polylines: (prefix) =>
      getState().project.drawings2d.flatMap((d) => (d.id.startsWith(prefix) && d.geom.shape === "polyline" ? [{ id: d.id, pts: d.geom.pts }] : [])),
    openings: () => (getState().project.openings ?? []).map((o) => ({ id: o.id, hostWallId: o.hostWallId, position: o.position })),
    select: (patch) => getState().setSelection(patch),
    dimPts: (id) => {
      const g = getState().project.drawings2d.find((d) => d.id === id)?.geom;
      return g?.shape === "dimension" ? g.pts.map((p) => ({ x: p.x, y: p.y })) : [];
    },
    notices: () => getState().notifications.map((n) => n.message),
    selected: () => ({ drawings: [...getState().selection.drawings], groups: [...getState().selection.groups], all: JSON.stringify(getState().selection) }),
  };
}
