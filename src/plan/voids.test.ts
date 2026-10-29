import { describe, expect, it } from "vitest";
import type { Pair } from "../geometry/polygonBool";
import { generatePlan } from "./generatePlan";
import { sampleProject } from "../model/sampleProject";
import type { ExtrudedSolid, Project } from "../model/types";
import { subtractRings } from "./voids";

const sq = (x0: number, y0: number, x1: number, y1: number): Pair[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const area = (r: Pair[]) => Math.abs(r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2);

function withVoid(p: Project, v: Partial<ExtrudedSolid>): Project {
  const solid: ExtrudedSolid = { id: "void1", type: "extrudedSolid", levelId: p.walls[0].floorId, operation: "subtract", height: 2, points: [], ...v };
  return { ...p, extrudedSolids: [...(p.extrudedSolids ?? []), solid] };
}

describe("Abzugskoerper — Polygon-Kern", () => {
  it("Loch ganz innen: Schluesselloch mit zwei ungestrichenen Stegkanten, Flaeche stimmt", () => {
    const r = subtractRings(sq(0, 0, 4, 2), [sq(1, 0.5, 2, 1.5)])!;
    expect(r).toHaveLength(1);
    expect(area(r[0].pts)).toBeCloseTo(8 - 1, 9);
    expect(r[0].noStrokeEdges).toHaveLength(2);
  });
  it("Durchbruch quer: zwei Restteile", () => {
    const r = subtractRings(sq(0, 0, 4, 0.3), [sq(1, -1, 2, 1)])!;
    expect(r).toHaveLength(2);
    // Polygon-Kern rechnet auf einem Ganzzahlraster (≈ Ausdehnung / 2³⁰): Mikrometer-genau.
    expect(r.reduce((s, x) => s + area(x.pts), 0)).toBeCloseTo(0.9, 6);
  });
  it("ohne Ueberschneidung: null (Original bleibt)", () => {
    expect(subtractRings(sq(0, 0, 1, 1), [sq(5, 5, 6, 6)])).toBeNull();
  });
  it("zwei getrennte Aussparungen wirken beide (drei Restteile)", () => {
    // Früher: der Überschneidungstest schnitt mit ALLEN Schneidern zugleich → keine Subtraktion.
    const r = subtractRings(sq(0, 0, 10, 2), [sq(1, -1, 2, 3), sq(6, -1, 7, 3)])!;
    expect(r).toHaveLength(3);
  });
  it("ungestrichene Originalkanten bleiben ungestrichen", () => {
    // Kante 1 (rechts, x=4) ungestrichen; der Schnitt links lässt sie unberührt.
    const r = subtractRings(sq(0, 0, 4, 2), [sq(-1, -1, 1, 3)], [1])!;
    const edges = r[0].noStrokeEdges.map((i) => [r[0].pts[i], r[0].pts[(i + 1) % r[0].pts.length]]);
    expect(edges.every(([a, b]) => a[0] === 4 && b[0] === 4)).toBe(true);
  });
});

describe("Abzugskoerper — Grundriss und Schnitt", () => {
  const w = sampleProject.walls[0];
  const mx = (w.start.x + w.end.x) / 2;
  const my = (w.start.y + w.end.y) / 2;
  const box = [{ x: mx - 0.3, y: my - 1 }, { x: mx + 0.3, y: my - 1 }, { x: mx + 0.3, y: my + 1 }, { x: mx - 0.3, y: my + 1 }];
  const vis = new Set(sampleProject.layers.map((l) => l.code));
  const wallPolys = (p: Project) => generatePlan(p, w.floorId, vis).primitives.filter((q) => q.kind === "polygon" && q.wallId === w.id);

  it("Durchbruch auf Schnitthoehe teilt die Wand-Poché, Umrisslinien enden am Koerper", () => {
    const p = withVoid(sampleProject, { points: box });
    const before = wallPolys(sampleProject).length;
    expect(wallPolys(p).length).toBeGreaterThan(before);
    const lines = generatePlan(p, w.floorId, vis).primitives.filter(
      (q) => q.kind === "line" && (q.cls === "wall-outline" || q.cls === "layer-joint"),
    );
    for (const l of lines) {
      if (l.kind !== "line") continue;
      const cx = (l.a.x + l.b.x) / 2;
      const cy = (l.a.y + l.b.y) / 2;
      const inside = cx > mx - 0.3 + 1e-6 && cx < mx + 0.3 - 1e-6 && cy > my - 1 && cy < my + 1;
      expect(inside).toBe(false);
    }
  });
  it("Koerper ueber der Schnitthoehe aendert den Grundriss nicht", () => {
    const p = withVoid(sampleProject, { points: box, baseOffset: 1.5, height: 0.5 });
    expect(wallPolys(p).length).toBe(wallPolys(sampleProject).length);
  });
});
