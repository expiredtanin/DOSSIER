// [271] „Beispiel Umbau": das Demo-Haus (sampleProject) als Bestand, umgebaut in zwei Etappen — Vorlage für Tests, die
// Kurzanleitung (Abschnitt Umbau) und die Prüfbilder (`doc/review-271`).
//
// Etappe 1 (innen): die Zwischenwand W9 wird abgebrochen, das Nordfenster O2 zugemauert (Öffnung „Abbruch“: im Neubau-
// und Endzustand ist die Wand dort zu, mit roter Ausfachung im Umbauplan), in die Westwand W4 kommt ein neues Fenster O3
// (Öffnung „Neu“ in Bestandswand: im Bestand ist die Wand dort zu, im Umbauplan gelbes Abbruch-Stück).
// Etappe 2 (Anbau): ein eingeschossiger Anbau im Norden (Wände, Decke, Raum, Fenster) und eine neue Tür in W3.
// Nur Modellfelder, keine Kern-Befehle: das Modul ist ohne geladenen Kern auswertbar.

import type { Ceiling, DrawingLevel, Opening, Project, Renovation, Room, Wall } from "./types";
import { sampleProject } from "./sampleProject";

const E1: Renovation = { status: "new", phase: "etappe-1" };
const E2: Renovation = { status: "new", phase: "etappe-2" };
const D1: Renovation = { status: "demolish", phase: "etappe-1" };

const wall = (id: string, x0: number, y0: number, x1: number, y1: number): Wall => ({
  id, type: "wall", floorId: "eg", categoryCode: "20", start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, wallTypeId: "aw", height: 2.6, renovation: E2,
});

const win = (id: string, hostWallId: string, position: number, width: number, renovation?: Renovation): Opening => ({
  id, type: "opening", hostWallId, categoryCode: "21", kind: "window", typeId: "window-standard", position, width, height: 1.2, sillHeight: 0.9,
  ...(renovation ? { renovation } : {}),
});

/** Das Umbau-Beispiel (frische Kopie bei jedem Aufruf). */
export function buildUmbauSampleProject(): Project {
  const base = structuredClone(sampleProject);
  const levels: DrawingLevel[] = [
    ...base.drawingLevels,
    // Schnitt durch den Anbau (Nord–Süd, Blick nach Osten): zeigt Bestand, Abbruch W9 nicht, aber Anbau und neue Tür.
    { id: "schnitt-b", name: "Schnitt B", kind: "section", visible: true, locked: false, linePoints: [{ x: 1.4, y: -1 }, { x: 1.4, y: 8 }], directionSign: -1 },
  ];
  const walls: Wall[] = base.walls.map((w) => (w.id === "W9" ? { ...w, renovation: D1 } : w));
  walls.push(wall("W10", 0, 4, 0, 7), wall("W11", 0, 7, 3, 7), wall("W12", 3, 7, 3, 4));
  const openings: Opening[] = (base.openings ?? []).map((o) => (o.id === "O2" ? { ...o, renovation: D1 } : o));
  openings.push(
    win("O3", "W4", 1.5, 1.0, E1),
    // Neue Tür in der Bestandswand W3 (W3 läuft von x 5 nach x 0: Tür x 1.9–1.0) zum Anbau.
    { id: "O4", type: "opening", hostWallId: "W3", categoryCode: "21", kind: "door", typeId: "door-standard", position: 3.1, width: 0.9, height: 2.1, sillHeight: 0, swing: "left", hinge: "start", renovation: E2 },
    // Fenster des Anbaus: ohne eigenen Status, folgt der neuen Wand.
    win("O5", "W11", 0.9, 1.2),
  );
  const c1 = (base.ceilings ?? [])[0];
  const ceilings: Ceiling[] = [
    ...(base.ceilings ?? []),
    { ...c1, id: "C2", outline: [{ x: 0, y: 4 }, { x: 3, y: 4 }, { x: 3, y: 7 }, { x: 0, y: 7 }], renovation: E2 },
  ];
  const r1 = (base.rooms ?? [])[0];
  const h = 0.1725;
  const rooms: Room[] = [
    ...(base.rooms ?? []),
    {
      ...r1, id: "R2", name: "Anbau", siaCategory: "HNF",
      boundary: [{ x: h, y: 4 + h }, { x: 3 - h, y: 4 + h }, { x: 3 - h, y: 7 - h }, { x: h, y: 7 - h }],
      stampAnchor: { x: 1.5, y: 5.8 },
      renovation: E2,
    },
  ];
  return {
    ...base,
    id: "beispiel-umbau",
    name: "Beispiel Umbau",
    drawingLevels: levels,
    walls,
    openings,
    ceilings,
    rooms,
    renovation: {
      phases: [
        { id: "etappe-1", name: "Etappe 1" },
        { id: "etappe-2", name: "Etappe 2" },
      ],
    },
  };
}
