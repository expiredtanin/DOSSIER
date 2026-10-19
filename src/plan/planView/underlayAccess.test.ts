// Die Zugriffe auf die kompakte Unterlage müssen dasselbe liefern wie die
// bisherigen Primitiv-basierten Varianten (Zufallsdaten als Gegenprobe).

import { describe, it, expect } from "vitest";
import type { Drawing2D, Project } from "../../model/types";
import { generatePlan, materializeUnderlay } from "../generatePlan";
import { marqueeHitDrawings } from "./geometry";
import { buildSegmentIndex, nearestSegment } from "./segmentIndex";
import { buildDrawingIndex, marqueeHitUnderlay, nearestInDrawings } from "./underlayAccess";

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function makeDrawings(n: number): Drawing2D[] {
  const out: Drawing2D[] = [];
  for (let i = 0; i < n; i++) {
    const x = rnd() * 500, y = rnd() * 500;
    const k = 2 + Math.floor(rnd() * 6);
    const pts = Array.from({ length: k }, () => ({ x: x + rnd() * 20, y: y + rnd() * 20 }));
    const closed = k > 2 && rnd() < 0.5;
    out.push(
      i % 7 === 0
        ? ({ id: `d${i}`, type: "drawing2d", levelId: "L", categoryCode: "60", geom: { shape: "line", a: pts[0], b: pts[1] } } as Drawing2D)
        : ({ id: `d${i}`, type: "drawing2d", levelId: "L", categoryCode: "60", geom: { shape: "polyline", pts, closed } } as Drawing2D),
    );
  }
  // Eine riesige Zeichnung (landet in der Überlauf-Liste).
  out.push({ id: "huge", type: "drawing2d", levelId: "L", categoryCode: "60", geom: { shape: "line", a: { x: -9000, y: -9000 }, b: { x: 9000, y: 9000 } } } as Drawing2D);
  return out;
}

const project = (drawings: Drawing2D[]) =>
  ({
    id: "t", name: "T", lineStyles: [], hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [], wallTypes: [],
    drawingLevels: [{ id: "L", name: "L", kind: "drawing", visible: true, locked: false }],
    layers: [{ code: "60", name: "Z", color: "#000", lw: 0.25, visible: true, locked: false }],
    walls: [], doors: [], openings: [], ceilings: [], stairs: [], rooms: [], drawings2d: drawings, context: [],
  }) as unknown as Project;

describe("underlayAccess == Primitiv-Varianten", () => {
  const drawings = makeDrawings(1500);
  const p = project(drawings);
  const vis = new Set(["60"]);
  const normal = generatePlan(p, "L", vis);
  const compact = generatePlan(p, "L", vis, undefined, "mittel", false, false, true, 100, false, true);
  const under = compact.underlay!.flatMap((g) => g.drawings);
  const mat = materializeUnderlay(compact);

  it("alle berechtigten Zeichnungen stecken in der Unterlage", () => {
    expect(under.length).toBe(drawings.length);
  });

  it("nächstes Segment == Segment-Index der Primitive", () => {
    const idx = buildDrawingIndex(under)!;
    const segIdx = buildSegmentIndex(normal.primitives)!;
    for (let k = 0; k < 400; k++) {
      const m = { x: rnd() * 540 - 20, y: rnd() * 540 - 20 };
      const a = nearestInDrawings(idx, m, 2);
      const bi = nearestSegment(segIdx, normal.primitives, m, 2);
      const b = bi === null ? null : (normal.primitives[bi] as any);
      expect(a?.drawing.id ?? null).toBe(b?.drawingId ?? null);
    }
  });

  it("Marquee (crossing + window) == marqueeHitDrawings über die Primitive", () => {
    for (const crossing of [true, false]) {
      for (let k = 0; k < 40; k++) {
        const x = rnd() * 450, y = rnd() * 450, w = 5 + rnd() * 120, h = 5 + rnd() * 120;
        const rect = { minX: x, minY: y, maxX: x + w, maxY: y + h };
        const a = new Set(marqueeHitUnderlay(under, rect, crossing));
        const b = new Set(marqueeHitDrawings(mat.primitives, rect, crossing));
        expect([...a].sort()).toEqual([...b].sort());
      }
    }
  });
});

describe("drawingsWithinDistance", () => {
  it("liefert alle Zeichnungen in Reichweite, nächste zuerst", async () => {
    const { drawingsWithinDistance, buildDrawingIndex: build } = await import("../../geometry/drawingIndex");
    const mk = (id: string, y: number) =>
      ({ id, type: "drawing2d", levelId: "L", categoryCode: "60", geom: { shape: "line", a: { x: 0, y }, b: { x: 10, y } } }) as Drawing2D;
    const ds = [mk("near", 0.3), mk("nearer", 0.1), mk("far", 9)];
    const hits = drawingsWithinDistance(build(ds)!, { x: 5, y: 0 }, 1);
    expect(hits.map((h) => h.drawing.id)).toEqual(["nearer", "near"]);
  });
});
