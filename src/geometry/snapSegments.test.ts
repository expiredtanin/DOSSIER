// Objektfang auf Strecken im Kern ([K3d], `core/src/snap.rs`): gleiche Wahl wie die einfache
// Suche über alle Strecken/Paare (Raster-Vorauswahl und Geraden-Filter für Schnittpunkte dürfen
// nichts ändern). (Gleichheit zur früheren TS-Fassung von computeSnap: 2600 Abfragen, s. TODO [K3d].)

import { describe, expect, it } from "vitest";
import { holdSnapSegments, releaseSnapSegments, snapOnSegments, type SnapSeg } from "./snapSegments";
import type { Vec2 } from "../model/types";

const PRIORITY: Record<string, number> = { perpendicular: 1, endpoint: 7, midpoint: 3, intersection: 5, onEdge: 0 };

/** Einfache Fassung (alle Strecken, alle Paare) — Block A (Lot, Endpunkte) und Block B (Mitte, Schnitt, Kante). */
function brute(segs: SnapSeg[], raw: Vec2, tolM: number, pxPerM: number, last: Vec2 | null) {
  const perp = (p: Vec2, a: Vec2, b: Vec2): Vec2 => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return a;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return { x: a.x + dx * t, y: a.y + dy * t };
  };
  const block = () => {
    let best: { point: Vec2; kind: string; distPx: number; score: number } | null = null;
    let bestScore = Infinity;
    const consider = (point: Vec2, kind: string) => {
      const d = Math.hypot(point.x - raw.x, point.y - raw.y);
      if (d > tolM) return;
      const score = d * pxPerM - PRIORITY[kind];
      if (score < bestScore) {
        bestScore = score;
        best = { point, kind, distPx: d * pxPerM, score };
      }
    };
    return { consider, get: () => best };
  };
  const a = block();
  if (last) for (const [p, q] of segs) a.consider(perp(last, p, q), "perpendicular");
  for (const [p, q] of segs) {
    a.consider(p, "endpoint");
    a.consider(q, "endpoint");
  }
  const b = block();
  for (const [p, q] of segs) b.consider({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, "midpoint");
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [p, q] = segs[i];
      const [r, s] = segs[j];
      const da = { x: q.x - p.x, y: q.y - p.y };
      const db = { x: s.x - r.x, y: s.y - r.y };
      const den = da.x * db.y - da.y * db.x;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((r.x - p.x) * db.y - (r.y - p.y) * db.x) / den;
      b.consider({ x: p.x + da.x * t, y: p.y + da.y * t }, "intersection");
    }
  }
  for (const [p, q] of segs) b.consider(perp(raw, p, q), "onEdge");
  return { a: a.get(), b: b.get() };
}

describe("snapOnSegments (Kern)", () => {
  it("gleich wie die Suche über alle Strecken und Paare (Zufallsdaten)", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let run = 0; run < 8; run++) {
      const segs: SnapSeg[] = [];
      for (let i = 0; i < 300; i++) {
        const x = rnd() * 20, y = rnd() * 20;
        // Viele achsparallele Strecken (Wände), einige lange schräge (Verlängerungen schneiden weit weg).
        const k = rnd();
        segs.push(k < 0.4 ? [{ x, y }, { x: x + rnd() * 5, y }] : k < 0.8 ? [{ x, y }, { x, y: y + rnd() * 5 }] : [{ x, y }, { x: x + rnd() * 30 - 15, y: y + rnd() * 30 - 15 }]);
      }
      const base = segs.slice(0, 250);
      const extra = segs.slice(250);
      const h = holdSnapSegments(base);
      for (let q = 0; q < 25; q++) {
        const raw = { x: rnd() * 20, y: rnd() * 20 };
        const tolM = 0.05 + rnd() * 0.5;
        const last = rnd() < 0.5 ? { x: rnd() * 20, y: rnd() * 20 } : null;
        const r = snapOnSegments(h, extra, null, { raw, tolM, pxPerMeter: 100, perpendicular: true, endpoint: true, midpoint: true, intersection: true, onEdge: true, lastPoint: last })!;
        const e = brute(segs, raw, tolM, 100, last);
        expect(r.a).toEqual(e.a);
        expect(r.b).toEqual(e.b);
      }
      releaseSnapSegments(h);
      expect(snapOnSegments(h, [], null, { raw: { x: 0, y: 0 }, tolM: 1, pxPerMeter: 1, perpendicular: false, endpoint: true, midpoint: false, intersection: false, onEdge: false, lastPoint: null })).toBeNull();
    }
    }, 60_000);

  it("nächste Strecke für das Verweilen", () => {
    const r = snapOnSegments(0, [[{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 5, y: -5 }, { x: 5, y: 5 }]], null, {
      raw: { x: 5.05, y: 0.02 },
      tolM: 0.2,
      pxPerMeter: 100,
      perpendicular: false,
      endpoint: true,
      midpoint: true,
      intersection: true,
      onEdge: true,
      lastPoint: null,
    })!;
    expect(r.nearest).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(r.b?.kind).toBe("intersection");
  });
});
