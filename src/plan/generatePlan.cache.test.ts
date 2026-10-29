// Die 2D-Zeichnungen kommen aus dem Kern-Puffer ([K3d], `plan/drawings.rs`): der GPU-Chunk-Cache
// erkennt Unverändertes am Inhalts-Hash je Primitiv. Er darf nur dann gleich bleiben, wenn sich
// nichts geändert hat, was die Ausgabe bestimmt — und Mono (färbt Primitive in place um) darf den
// normalen Plan nicht verändern.

import { describe, it, expect } from "vitest";
import { generatePlan, type Plan } from "./generatePlan";
import type { Drawing2D, Project } from "../model/types";

const draw = (id: string, ax: number): Drawing2D => ({
  id,
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "60",
  geom: { shape: "polyline", pts: [{ x: ax, y: 0 }, { x: ax + 1, y: 0 }, { x: ax + 2, y: 1 }], closed: false },
});

const SHARED = {
  lineStyles: [] as Project["lineStyles"],
  hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }] as Project["hatches"],
  layers: [{ code: "60", name: "Zeichnung", color: "#0a0a0a", lw: 0.25, visible: true, locked: false }] as Project["layers"],
};

function project(drawings: Drawing2D[]): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: SHARED.lineStyles,
    hatches: SHARED.hatches,
    components: [],
    wallTypes: [],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: SHARED.layers,
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: drawings,
    context: [],
  } as unknown as Project;
}

const visible = new Set(["60"]);
const lines = (p: Plan, id: string) => p.primitives.filter((pr) => pr.kind === "line" && pr.drawingId === id);
/** Inhalts-Hashes der Linien einer Zeichnung (aus den Kern-Abschnitten des Plans). */
function hashes(p: Plan, id: string): number[] {
  const out: number[] = [];
  for (const r of p.bufRuns ?? []) {
    for (let i = r.from; i < r.to; i++) {
      const q = r.buf.prim(i);
      if (q.kind === "line" && q.drawingId === id) out.push(r.buf.hashes![i]);
    }
  }
  return out;
}

describe("Inhalts-Hashes der 2D-Zeichnungen (GPU-Chunk-Cache)", () => {
  it("bleiben für unveränderte Zeichnungen gleich, auch wenn andere sich ändern", () => {
    const a = draw("A", 0), b = draw("B", 10);
    const p1 = generatePlan(project([a, b]), "eg", visible);
    const p2 = generatePlan(project([a, draw("B", 20)]), "eg", visible);
    expect(hashes(p1, "A").length).toBe(2);
    expect(hashes(p2, "A")).toEqual(hashes(p1, "A"));
    expect(hashes(p2, "B")).not.toEqual(hashes(p1, "B"));
    // B zeigt die NEUE Geometrie.
    expect((lines(p2, "B")[0] as { a: { x: number } }).a.x).toBe(20);
  });

  it("ändern sich mit dem Kontext (Ebenen → Farbe)", () => {
    const base = project([draw("A", 0)]);
    const p1 = generatePlan(base, "eg", visible);
    const recolored = { ...base, layers: [{ ...base.layers[0], color: "#ff0000" }] };
    const p2 = generatePlan(recolored, "eg", visible);
    expect((lines(p1, "A")[0] as { color: string }).color).toBe("#0a0a0a");
    expect((lines(p2, "A")[0] as { color: string }).color).toBe("#ff0000");
    expect(hashes(p2, "A")).not.toEqual(hashes(p1, "A"));
  });

  it("mono verändert Primitive in place, ohne den normalen Plan zu vergiften", () => {
    const proj = project([draw("A", 0)]);
    const normal1 = generatePlan(proj, "eg", visible);
    generatePlan(proj, "eg", visible, undefined, "mittel", false, true);
    const normal2 = generatePlan(proj, "eg", visible);
    expect((lines(normal1, "A")[0] as { color: string }).color).toBe("#0a0a0a");
    expect((lines(normal2, "A")[0] as { color: string }).color).toBe("#0a0a0a");
    expect(hashes(normal2, "A")).toEqual(hashes(normal1, "A"));
  });

  it("gedimmt ist Teil des Inhalts", () => {
    const proj = project([draw("A", 0)]);
    const normal = generatePlan(proj, "eg", visible);
    const dimmed = generatePlan(proj, "eg", visible, () => ({ render: true, greyed: true, locked: false }));
    expect((lines(normal, "A")[0] as { greyed?: boolean }).greyed).toBeFalsy();
    expect((lines(dimmed, "A")[0] as { greyed?: boolean }).greyed).toBe(true);
    expect(hashes(dimmed, "A")).not.toEqual(hashes(normal, "A"));
  });
});
