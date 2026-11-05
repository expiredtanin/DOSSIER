// Grosses Testgebäude für Leistungsmessungen ([20]): N Geschosse × M Wohnungen, parametrisch und
// deterministisch (feste ids, keine Zufallszahlen). Nur Modell-Literal — braucht den Kern nicht.
// Kein Menüpunkt in der App; genutzt von `dossier-cli :gross bench`, Tests und dem Frame-Zeit-Spec
// (`e2e/bigBuilding.spec.ts`, per `window.__dossierLoadBig`).
//
// Aufbau je Geschoss: M Wohnungen (6 × 10 m) in einer Reihe entlang x, je 3 × 3 Zellen (Raum + Innenwände
// mit Tür), 3 Fenster Süd und Nord; am Ostende ein Treppenkern mit Treppe. Decke je Geschoss, Satteldach.

import type { Opening, Project, Room, Vec2, Wall } from "./types";
import { sampleProject } from "./sampleProject";

export interface BigBuildingOptions {
  /** Anzahl Geschosse (Standard 8). */
  floors?: number;
  /** Wohnungen je Geschoss (Standard 15). */
  apartments?: number;
}

const P = (x: number, y: number): Vec2 => ({ x, y });
const W = 6; // Wohnungsbreite
const D = 10; // Wohnungstiefe
const FH = 3; // Geschosshöhe
const CORE = 3; // Breite des Treppenkerns

export function buildBigSampleProject(opts: BigBuildingOptions = {}): Project {
  const nf = Math.max(1, Math.floor(opts.floors ?? 8));
  const na = Math.max(1, Math.floor(opts.apartments ?? 15));
  const total = na * W + CORE;
  const walls: Wall[] = [];
  const openings: Opening[] = [];
  const rooms: Room[] = [];
  const ceilings: NonNullable<Project["ceilings"]> = [];
  const stairs: NonNullable<Project["stairs"]> = [];
  const levels = Array.from({ length: nf }, (_, i) => ({
    id: `g${i}`, name: i === 0 ? "Erdgeschoss" : `${i}. Obergeschoss`, kind: "floor" as const, visible: true, locked: false,
    floorHeight: FH, cutHeight: 1.0, baseElevation: i * FH,
  }));

  for (let f = 0; f < nf; f++) {
    const fl = `g${f}`;
    let n = 0;
    let on = 0;
    const wall = (a: Vec2, b: Vec2, type: string, ext = false): string => {
      const id = `${fl}-w${++n}`;
      walls.push({ id, type: "wall", floorId: fl, categoryCode: "20", start: a, end: b, wallTypeId: type, height: FH, ...(ext ? { isExternal: true, loadBearing: true } : {}) });
      return id;
    };
    const win = (host: string, position: number) => openings.push({
      id: `${fl}-o${++on}`, type: "opening", hostWallId: host, categoryCode: "21", kind: "window", typeId: "window-standard",
      position, width: 1.2, height: 1.4, sillHeight: 0.9, isExternal: true,
    });
    const door = (host: string, position: number) => openings.push({
      id: `${fl}-o${++on}`, type: "opening", hostWallId: host, categoryCode: "21", kind: "door", typeId: "door-standard",
      position, width: 0.9, height: 2.1, sillHeight: 0, swing: "left", hinge: "start",
    });

    for (let a = 0; a < na; a++) {
      const x0 = a * W;
      const s = wall(P(x0, 0), P(x0 + W, 0), "aw", true);
      const nn = wall(P(x0 + W, D), P(x0, D), "aw", true);
      for (let i = 0; i < 3; i++) { win(s, 0.4 + 2 * i); win(nn, 0.4 + 2 * i); }
      wall(P(x0, 0), P(x0, D), "iw"); // Wohnungstrennwand
      for (const dx of [2, 4]) {
        for (let j = 0; j < 3; j++) door(wall(P(x0 + dx, j * 3.3), P(x0 + dx, j === 2 ? D : (j + 1) * 3.3), "iw"), 1.2);
      }
      for (const dy of [3.3, 6.6]) {
        for (let i = 0; i < 3; i++) door(wall(P(x0 + i * 2, dy), P(x0 + (i + 1) * 2, dy), "iw"), 0.55);
      }
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        const bx = x0 + i * 2 + 0.1, by = j * 3.3 + 0.1;
        rooms.push({
          id: `${fl}-r${a}-${i}${j}`, type: "room", floorId: fl, categoryCode: "60", siaCategory: "HNF", name: `Zimmer ${a + 1}.${i * 3 + j + 1}`,
          boundary: [P(bx, by), P(bx + 1.8, by), P(bx + 1.8, by + 3.1), P(bx, by + 3.1)], color: "#bcd0e4",
        } as Room);
      }
    }
    // Treppenkern am Ostende.
    const cx = na * W;
    wall(P(cx, 0), P(cx + CORE, 0), "aw", true);
    wall(P(cx + CORE, 0), P(cx + CORE, D), "aw", true);
    wall(P(cx + CORE, D), P(cx, D), "aw", true);
    wall(P(cx, 0), P(cx, D), "iw");
    if (f < nf - 1) {
      stairs.push({ id: `${fl}-tr`, type: "stair", floorId: fl, categoryCode: "40", shape: "straight", typeId: "stair-standard", start: P(cx + 1, 0.5), dir: P(0, 1), runLength: 4.5, width: 1.0, totalRise: FH, stepCount: 17, up: true });
    }
    ceilings.push({
      id: `${fl}-decke`, type: "ceiling", floorId: fl, categoryCode: "30", outline: [P(0, 0), P(total, 0), P(total, D), P(0, D)],
      wallTypeId: "aw", ceilingTypeId: "dg-massiv",
    });
  }

  return {
    ...sampleProject,
    id: "gross",
    name: `Grossgebäude ${nf}×${na}`,
    drawingLevels: [
      ...levels,
      { id: "schnitt-a", name: "Schnitt A", kind: "section", visible: true, locked: false, linePoints: [P(total / 2, -2), P(total / 2, D + 2)], directionSign: 1 },
      { id: "ansicht-sued", name: "Ansicht Süd", kind: "elevation", visible: true, locked: false, linePoints: [P(-2, -3), P(total + 2, -3)], directionSign: 1, shadows: true },
    ],
    walls,
    openings,
    ceilings,
    stairs,
    rooms,
    roofs: [{
      id: "dach", type: "roof", floorId: `g${nf - 1}`, categoryCode: "31", outline: [P(0, 0), P(total, 0), P(total, D), P(0, D)],
      shape: "sattel", pitchDeg: 30, overhang: 0.4, ridgeAxis: "x", thickness: 0.2,
    }],
    columns: [],
    extrudedSolids: [],
    drawings2d: [],
    context: [],
  };
}
