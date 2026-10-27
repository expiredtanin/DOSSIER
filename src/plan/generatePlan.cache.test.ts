// Der Primitiv-Cache je Drawing2D-Objekt (drawing2d.ts) darf nur dann
// Primitive wiederverwenden, wenn sich nichts geändert hat, was ihre Ausgabe
// bestimmt — und nie in Modi, die Primitive in place verändern (mono).

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Drawing2D, Project } from "../model/types";

const draw = (id: string, ax: number): Drawing2D => ({
  id,
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "60",
  geom: { shape: "polyline", pts: [{ x: ax, y: 0 }, { x: ax + 1, y: 0 }, { x: ax + 2, y: 1 }], closed: false },
});

// Wie im echten Projekt: unveränderte Teile sind dieselben Objekte (Structural Sharing).
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
const lines = (p: ReturnType<typeof generatePlan>, id: string) =>
  p.primitives.filter((pr) => pr.kind === "line" && pr.drawingId === id);

describe("Primitiv-Cache je Drawing2D", () => {
  it("liefert für unveränderte Zeichnungen dieselben Primitiv-OBJEKTE, auch wenn andere sich ändern", () => {
    const a = draw("A", 0), b = draw("B", 10);
    const p1 = generatePlan(project([a, b]), "eg", visible);
    const b2 = draw("B", 20); // B geändert (neues Objekt), A bleibt dasselbe Objekt
    const p2 = generatePlan(project([a, b2]), "eg", visible);
    const la1 = lines(p1, "A"), la2 = lines(p2, "A");
    expect(la1.length).toBeGreaterThan(0);
    expect(la2.every((pr, i) => pr === la1[i])).toBe(true);
    // B wurde neu erzeugt und zeigt die NEUE Geometrie.
    expect((lines(p2, "B")[0] as any).a.x).toBe(20);
  });

  it("verwirft den Cache, wenn sich der Kontext ändert (Ebenen → Farbe)", () => {
    const a = draw("A", 0);
    const base = project([a]);
    const p1 = generatePlan(base, "eg", visible);
    const recolored = { ...base, layers: [{ ...base.layers[0], color: "#ff0000" }] };
    const p2 = generatePlan(recolored, "eg", visible);
    expect((lines(p1, "A")[0] as any).color).toBe("#0a0a0a");
    expect((lines(p2, "A")[0] as any).color).toBe("#ff0000");
  });

  it("mono verändert Primitive in place, ohne den normalen Cache zu vergiften", () => {
    const a = draw("A", 0);
    const proj = project([a]);
    const normal1 = generatePlan(proj, "eg", visible);
    generatePlan(proj, "eg", visible, undefined, "mittel", false, true);
    const normal2 = generatePlan(proj, "eg", visible);
    expect((lines(normal1, "A")[0] as any).color).toBe("#0a0a0a");
    expect((lines(normal2, "A")[0] as any).color).toBe("#0a0a0a");
  });

  it("greyed ist Teil des Schlüssels", () => {
    const a = draw("A", 0);
    const proj = project([a]);
    const normal = generatePlan(proj, "eg", visible);
    const dimmed = generatePlan(proj, "eg", visible, () => ({ render: true, greyed: true, locked: false }));
    expect((lines(normal, "A")[0] as any).greyed).toBeFalsy();
    expect((lines(dimmed, "A")[0] as any).greyed).toBe(true);
  });
});
