import { describe, it, expect } from "vitest";
import type { Primitive } from "../generatePlan";
import { buildSegmentIndex, nearestSegment } from "./segmentIndex";

const line = (ax: number, ay: number, bx: number, by: number, drawingId = "d"): Primitive => ({
  kind: "line",
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  cls: "draw2d",
  weightMm: 0.18,
  drawingId,
});

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

describe("segmentIndex", () => {
  it("liefert dasselbe Ergebnis wie die lineare Suche (Zufallsdaten)", () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const prims: Primitive[] = [];
    for (let i = 0; i < 20000; i++) {
      const x = rnd() * 1000, y = rnd() * 1000;
      prims.push(line(x, y, x + (rnd() - 0.5) * 20, y + (rnd() - 0.5) * 20));
    }
    // Ein sehr langes Segment (landet in der Überlauf-Liste) + ein Nicht-2D-Strich.
    prims.push(line(-5000, -5000, 5000, 5000));
    prims.push({ ...line(500, 500, 501, 501), drawingId: undefined } as Primitive);
    const idx = buildSegmentIndex(prims)!;
    expect(idx.long.length).toBe(1);
    for (let k = 0; k < 500; k++) {
      const m = { x: rnd() * 1100 - 50, y: rnd() * 1100 - 50 };
      expect(nearestSegment(idx, prims, m, 3)).toBe(bruteForce(prims, m, 3));
    }
  });

  it("null ohne indizierbare Linien", () => {
    expect(buildSegmentIndex([])).toBeNull();
  });

  it("findet nichts ausserhalb der Toleranz", () => {
    const prims = [line(0, 0, 10, 0)];
    const idx = buildSegmentIndex(prims)!;
    expect(nearestSegment(idx, prims, { x: 5, y: 0.5 }, 1)).toBe(0);
    expect(nearestSegment(idx, prims, { x: 5, y: 2 }, 1)).toBeNull();
    expect(nearestSegment(idx, prims, { x: 500, y: 500 }, 1)).toBeNull();
  });
});
