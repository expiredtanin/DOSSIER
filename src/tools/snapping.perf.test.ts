// [K4] Messung: Objektfang je Mausbewegung (`computeSnap`) auf grossen Projekten — 3000 Wände +
// 20 000 Zeichnungen (Nahmodus), 3000 Wände + 1500 Zeichnungen (Normalmodus) und ein Kataster mit
// 150 000 Linien/Polylinien. Werte gehen nach stderr (TODO [K4]); geprüft wird vor allem, dass der
// Fang etwas findet. Die Grenzen sind grosszügig (Container unter Last).
import { describe, expect, it } from "vitest";
import { computeSnap, type SnapInput } from "./snapping";
import { DEFAULT_SNAP } from "./types";
import { sampleProject } from "../model/sampleProject";
import { getState } from "../state/appStore";
import { generatePlan, replaceItem } from "../core";
import type { Drawing2D, Project, Vec2, Wall } from "../model/types";

function wallsAndDrawings(nDrawings: number): Project {
  const base = sampleProject.walls;
  const walls: Wall[] = Array.from({ length: 3000 }, (_, i) => ({
    ...base[i % base.length],
    id: `w${i}`,
    floorId: sampleProject.drawingLevels[0].id,
    start: { x: (i % 60) * 4, y: Math.floor(i / 60) * 4 },
    end: { x: (i % 60) * 4 + 4, y: Math.floor(i / 60) * 4 },
  }));
  const level = sampleProject.drawingLevels[0].id;
  const drawings: Drawing2D[] = Array.from({ length: nDrawings }, (_, i) => ({
    id: `d${i}`,
    type: "drawing2d",
    levelId: level,
    categoryCode: sampleProject.layers[0].code,
    geom: { shape: "polyline", closed: false, pts: [{ x: (i % 200) * 1.2, y: Math.floor(i / 200) * 2 + 0.5 }, { x: (i % 200) * 1.2 + 1, y: Math.floor(i / 200) * 2 + 1.5 }, { x: (i % 200) * 1.2 + 2, y: Math.floor(i / 200) * 2 + 0.5 }] },
  }));
  return { ...structuredClone(sampleProject), walls, drawings2d: drawings };
}

/** Kataster: 150 000 Zeichnungen (Linien und geschlossene Parzellen) auf ~4 × 4 km. */
function cadastre(): Project {
  const level = sampleProject.drawingLevels[0].id;
  const drawings: Drawing2D[] = [];
  for (let i = 0; i < 150000; i++) {
    const x = (i % 400) * 10;
    const y = Math.floor(i / 400) * 10;
    drawings.push({
      id: `k${i}`,
      type: "drawing2d",
      levelId: level,
      categoryCode: sampleProject.layers[0].code,
      geom:
        i % 3 === 0
          ? { shape: "line", a: { x, y }, b: { x: x + 10, y: y + 3 } }
          : { shape: "polyline", closed: true, pts: [{ x, y }, { x: x + 9, y }, { x: x + 9, y: y + 8 }, { x, y: y + 9 }] },
    });
  }
  return { ...structuredClone(sampleProject), walls: [], drawings2d: drawings };
}

function input(project: Project, raw: Vec2, lastPoint: Vec2 | null): SnapInput {
  return {
    raw,
    project,
    levelId: project.drawingLevels[0].id,
    visibleCodes: CODES.get(project)!,
    settings: { ...DEFAULT_SNAP, perpendicular: true, tangent: true },
    draftPoints: lastPoint ? [lastPoint] : [],
    lastPoint,
    pxPerMeter: 40,
    shift: false,
    ctrl: false,
  };
}
const CODES = new Map<Project, Set<string>>();

/** Mittelwert (µs) je Mausbewegung: kleinster aus `rounds` Läufen à `n` Positionen. */
function bench(project: Project, at: (k: number) => Vec2, n = 400, rounds = 3): { us: number; hits: number } {
  let best = Infinity;
  let hits = 0;
  for (let r = 0; r < rounds; r++) {
    hits = 0;
    const t = performance.now();
    for (let k = 0; k < n; k++) if (computeSnap(input(project, at(k), { x: 1, y: 1 }))) hits++;
    best = Math.min(best, ((performance.now() - t) * 1000) / n);
  }
  return { us: best, hits };
}

function measure(name: string, project: Project, at: (k: number) => Vec2, out: string[]): void {
  // Über den Store (wie in der App): das Dokument ist offen, Änderungen gehen als Ops hinein.
  getState().loadProject(project);
  const p = getState().project;
  CODES.set(p, new Set(p.layers.map((l) => l.code)));
  // Wie in der App: der Plan steht, bevor das erste Werkzeug fängt (typisierte Sicht im Kern gebaut).
  generatePlan(p, p.drawingLevels[0].id, CODES.get(p)!).primitives.length;
  const t0 = performance.now();
  computeSnap(input(p, at(0), null));
  const first = performance.now() - t0;
  const { us, hits } = bench(p, at);
  expect(hits).toBeGreaterThan(0);
  // Nach einer Änderung (Griff ziehen: eine Wand bzw. eine Zeichnung je Schritt): erster Fang danach.
  const step = (change: () => void): number => {
    let sum = 0;
    for (let k = 0; k < 5; k++) {
      change();
      const p2 = getState().project;
      CODES.set(p2, CODES.get(p)!);
      const t = performance.now();
      computeSnap(input(p2, at(k), { x: 1, y: 1 }));
      sum += performance.now() - t;
    }
    return sum / 5;
  };
  let k = 0;
  const wallMs = p.walls.length
    ? step(() => {
        const w = getState().project.walls[7];
        getState().applyChange([replaceItem("walls", { ...w, end: { x: w.end.x + 0.01 * ++k, y: w.end.y } })]);
      })
    : NaN;
  const drawMs = step(() => {
    const d = getState().project.drawings2d[11];
    getState().applyChange([replaceItem("drawings2d", { ...d, categoryCode: d.categoryCode })]);
  });
  out.push(`${name}: erster Fang ${first.toFixed(1)} ms, je Mausbewegung ${us.toFixed(0)} µs (${hits} Treffer), nach Wand-Änderung ${wallMs.toFixed(1)} ms, nach Zeichnungs-Änderung ${drawMs.toFixed(1)} ms`);
}

describe("Messung Objektfang je Mausbewegung", () => {
  it("3000 Wände + 20 000 / 1500 Zeichnungen, Kataster 150 000", { timeout: 600000 }, () => {
    const out: string[] = [];
    const wave = (k: number): Vec2 => ({ x: (k * 7.31) % 230, y: ((k * 3.17) % 190) + 0.02 });
    measure("3000 Wände + 20 000 Zeichnungen", wallsAndDrawings(20000), wave, out);
    measure("3000 Wände + 1500 Zeichnungen", wallsAndDrawings(1500), wave, out);
    measure("Kataster 150 000", cadastre(), (k) => ({ x: (k * 37.3) % 3990, y: ((k * 11.9) % 3700) + 0.05 }), out);
    process.stderr.write(`Fang:\n  ${out.join("\n  ")}\n`);
  });
});
