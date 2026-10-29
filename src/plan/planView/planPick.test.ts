// Auswahl über den Kern ([K3d], `core/src/plan_pick.rs`): nächstes Segment, Segmente im Umkreis,
// Polygone unter dem Punkt (mit Pick-Feld), Symbol-Linien in Pixeln, Kreis-/Bogen-Ringe und
// Besitzer — gegen einfache lineare Suchen. (Gleichheit zur früheren TS-Fassung — segmentIndex,
// ownerIndex, PlanView-Schleifen — mit Beispielprojekt, 150 Zufallsplänen und grossem Projekt
// geprüft, s. TODO [K3d].)

import { describe, it, expect } from "vitest";
import type { Plan, Primitive } from "../generatePlan";
import { generatePlan } from "../generatePlan";
import { PlanPickIndex } from "./planPick";
import { pointInPolygon } from "./geometry";
import { sampleProject } from "../../model/sampleProject";
import { flattenCategories } from "../../model/types";

const plan = (primitives: Primitive[]): Plan => ({ primitives, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } });

const line = (ax: number, ay: number, bx: number, by: number, drawingId: string | undefined = "d"): Primitive =>
  ({ kind: "line", a: { x: ax, y: ay }, b: { x: bx, y: by }, cls: "draw2d", weightMm: 0.18, drawingId }) as Primitive;
const poly = (pts: Array<[number, number]>, extra: Record<string, string> = {}): Primitive =>
  ({ kind: "polygon", pts: pts.map(([x, y]) => ({ x, y })), fill: "#fff", stroke: "#000", strokeWidthMm: 0.1, ...extra }) as unknown as Primitive;

function bruteForce(prims: Primitive[], m: { x: number; y: number }, maxDist: number): number | null {
  let best: number | null = null;
  let bestDist = maxDist;
  prims.forEach((p, i) => {
    if (p.kind !== "line" || !p.drawingId) return;
    const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((m.x - p.a.x) * dx + (m.y - p.a.y) * dy) / len2)) : 0;
    const d = Math.hypot(m.x - (p.a.x + t * dx), m.y - (p.a.y + t * dy));
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

describe("PlanPickIndex: Segmente", () => {
  it("nächstes Segment wie die lineare Suche (Zufallsdaten, Überlauf-Segment, Nicht-2D-Strich)", { timeout: 60_000 }, () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const prims: Primitive[] = [];
    for (let i = 0; i < 20000; i++) {
      const x = rnd() * 1000, y = rnd() * 1000;
      prims.push(line(x, y, x + (rnd() - 0.5) * 20, y + (rnd() - 0.5) * 20));
    }
    prims.push(line(-5000, -5000, 5000, 5000));
    prims.push(line(500, 500, 501, 501, undefined));
    const ix = new PlanPickIndex(plan(prims));
    for (let k = 0; k < 500; k++) {
      const m = { x: rnd() * 1100 - 50, y: rnd() * 1100 - 50 };
      expect(ix.nearestSegment(m, 3)?.i ?? null).toBe(bruteForce(prims, m, 3));
    }
    ix.release();
  });

  it("nichts ausserhalb der Toleranz, nichts ohne 2D-Linien", () => {
    const ix = new PlanPickIndex(plan([line(0, 0, 10, 0)]));
    expect(ix.nearestSegment({ x: 5, y: 0.5 }, 1)).toEqual({ i: 0, dist: 0.5 });
    expect(ix.nearestSegment({ x: 5, y: 2 }, 1)).toBeNull();
    expect(ix.nearestSegment({ x: 500, y: 500 }, 1)).toBeNull();
    expect(new PlanPickIndex(plan([])).nearestSegment({ x: 0, y: 0 }, 1)).toBeNull();
  });

  it("alle Segmente in Reichweite, nächste zuerst", () => {
    const prims: Primitive[] = [line(0, 0, 10, 0, "a"), line(0, 0.5, 10, 0.5, "b"), line(0, 5, 10, 5, "c"), line(-2000, -2000, 2000, 2000, "long")];
    for (let i = 0; i < 300; i++) prims.push(line(50 + i, 50, 51 + i, 51, `f${i}`));
    const hits = new PlanPickIndex(plan(prims)).segmentsNear({ x: 5, y: 0.2 }, 1);
    expect(hits.map((h) => (prims[h.i] as { drawingId?: string }).drawingId)).toEqual(["a", "b"]);
    expect(hits[0].dist).toBeLessThanOrEqual(hits[1].dist);
  });
});

describe("PlanPickIndex: Polygone, Symbole, Ringe, Besitzer", () => {
  const prims: Primitive[] = [
    poly([[0, 0], [4, 0], [4, 4], [0, 4]], { roomId: "r1" }),
    poly([[1, 1], [3, 1], [3, 3], [1, 3]], { wallId: "w1", openingId: "o1" }),
    line(0, 0, 1, 0, "d1"),
    poly([[2, 2], [5, 2], [5, 5], [2, 5]], { stairId: "s1" }),
    { kind: "line", a: { x: 10, y: 0 }, b: { x: 10, y: 5 }, cls: "door-leaf", weightMm: 0.25, openingId: "o2" } as Primitive,
    { kind: "drawingCircle", center: { x: 20, y: 0 }, r: 1, fill: "none", stroke: "#000", weightMm: 0.25, drawingId: "c1" } as Primitive,
    { kind: "drawingCircle", center: { x: 30, y: 0 }, r: 1, fill: "#f00", stroke: "#000", weightMm: 0.25, drawingId: "c2" } as Primitive,
    line(0, 0, 1, 0, "d1"),
    poly([[0, 0], [1, 0], [1, 1]], { roomId: "" }),
  ];
  const ix = new PlanPickIndex(plan(prims));

  it("Polygone unter dem Punkt: oberstes zuerst, mit Feld-Filter (leere Id zählt nicht)", () => {
    const m = { x: 2.5, y: 2.5 };
    const all = prims.flatMap((p, i) => (p.kind === "polygon" && pointInPolygon(m, p.pts) ? [i] : [])).reverse();
    expect(ix.polygonsAt(m)).toEqual(all);
    expect(ix.topPolygon(m)).toBe(3);
    expect(ix.topPolygon(m, "roomId")).toBe(0);
    expect(ix.bottomPolygon(m, "openingId")).toBe(1);
    expect(ix.topPolygon({ x: 0.8, y: 0.2 }, "roomId")).toBe(0);
    expect(ix.topPolygon({ x: 50, y: 50 })).toBeNull();
  });

  it("Symbol-Linie in Client-Pixeln", () => {
    const map = { left: 0, top: 0, viewX: 0, viewY: 0, scale: 1 };
    // Linie bei x = 10 m → 900 px; Punkt 3 px daneben.
    expect(ix.nearestSymbolPx(["openingId"], [], map, { x: 903, y: -200 }, 6)).toBe(4);
    expect(ix.nearestSymbolPx(["openingId"], [], map, { x: 910, y: -200 }, 6)).toBeNull();
    expect(ix.nearestSymbolPx(["stairId"], [], map, { x: 903, y: -200 }, 6)).toBeNull();
  });

  it("Ringe: leerer Kreis nur am Rand, gefüllter auch innen", () => {
    expect(ix.ringsNear({ x: 21.01, y: 0 }, 100, 6).map((r) => r.i)).toEqual([5]);
    expect(ix.ringsNear({ x: 20, y: 0 }, 100, 6)).toEqual([]);
    expect(ix.ringsNear({ x: 30, y: 0 }, 100, 6)).toEqual([{ i: 6, dpx: 0 }]);
  });

  it("Besitzer in Plan-Reihenfolge (Zeichnungs-Primitive nur über drawingId)", () => {
    expect(ix.ownedBy("drawingId", ["d1"])).toEqual([prims[2], prims[7]]);
    expect(ix.ownedBy("wallId", ["w1"])).toEqual([prims[1]]);
    expect(ix.ownedBy("openingId", ["o1", "o2"])).toEqual([prims[1], prims[4]]);
    expect(ix.ownedBy("roomId", [""])).toEqual([prims[8]]);
    expect(ix.ownedBy("roomId", ["x"])).toEqual([]);
    expect(ix.ownedBy("wallId", [])).toEqual([]);
  });

  it("Beispielprojekt: Kern-Abschnitte und eigener Puffer gemischt", () => {
    const codes = new Set(flattenCategories(sampleProject.layers).map((c) => c.code));
    const p = generatePlan(sampleProject, "eg", codes);
    const pi = new PlanPickIndex(p);
    const wall = p.primitives.findIndex((q) => q.kind === "polygon" && !!q.wallId);
    const w = p.primitives[wall] as Extract<Primitive, { kind: "polygon" }>;
    expect(pi.ownedBy("wallId", [w.wallId!])).toEqual(p.primitives.filter((q) => (q as { wallId?: string }).wallId === w.wallId));
    pi.release();
  });
});
