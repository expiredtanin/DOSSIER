// Test-Naht für die UI-Suite (`e2e/`), nur mit `?dossierTest` in der URL geladen (main.tsx): Dinge, die
// sich über die Oberfläche nicht auslösen lassen. Hier: ein absichtlicher Kern-Panic ([118],
// `__debug_panic` in `src-tauri/core/src/web/document.rs`), um den Wiederanlauf in echtem Chromium zu prüfen.

import { core, coreEpoch, coreReady } from "../engine/coreWasm";
import { getState } from "./appStore";
import { storeDocument } from "./historySlice";
import { computeSection, generatePlan, generateSectionPlan } from "../core";

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
      /** [173] Linien einer Klasse (z. B. "door-lintel") im Grundriss der aktiven Ebene (alle Kategorien, 1:50, Detailgrad der Anzeige). */
      planLines: (cls: string) => number;
      /** [173] Modelldarstellung der aktiven Ebene (Feld `modelViewOptionId`). */
      modelView: () => string | undefined;
      /** [173] Schnitt der aktiven Ebene (1:50, Detailgrad der Anzeige): Zahl der Wand-Schnittflächen und ihre Fläche (m²). */
      sectionWalls: () => Promise<{ n: number; area: number }>;
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
    planLines: (cls) => {
      const s = getState();
      const codes = new Set<string>();
      const walk = (cs: { code: string; children?: unknown[] }[]): void => {
        for (const c of cs) {
          codes.add(c.code);
          walk((c.children ?? []) as { code: string; children?: unknown[] }[]);
        }
      };
      walk(s.project.layers);
      return generatePlan(s.project, s.activeLevelId, codes, undefined, s.detail, false, false, true, 50).primitives.filter((q) => q.kind === "line" && q.cls === cls).length;
    },
    modelView: () => getState().project.drawingLevels.find((l) => l.id === getState().activeLevelId)?.modelViewOptionId,
    sectionWalls: async () => {
      const s = getState();
      const level = s.project.drawingLevels.find((l) => l.id === s.activeLevelId);
      const out = level ? await computeSection(s.project, level) : null;
      if (!out) return { n: 0, area: 0 };
      const polys = generateSectionPlan(out, false, { scaleDenominator: 50, detail: s.detail }).primitives.filter((q) => q.kind === "polygon" && !!q.wallId);
      const area = (pts: { x: number; y: number }[]) => Math.abs(pts.reduce((a, p, i) => a + p.x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * p.y, 0)) / 2;
      return { n: polys.length, area: polys.reduce((a, q) => a + (q.kind === "polygon" ? area(q.pts) : 0), 0) };
    },
    selected: () => ({ drawings: [...getState().selection.drawings], groups: [...getState().selection.groups], all: JSON.stringify(getState().selection) }),
  };
}
