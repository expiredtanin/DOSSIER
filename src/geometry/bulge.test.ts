/**
 * `geometry/bulge.ts` — Kreisbogen-Segmente in Polylinien (DXF-Bulge-
 * Konvention). Reine Geometrie-Tests, kein Modellbezug.
 */

import { describe, it, expect } from "vitest";
import {
  bulgeArc,
  bulgeArcPoints,
  bulgePolylinePoints,
  bulgeFromSagittaPoint,
} from "./bulge";
import type { Vec2 } from "../model/types";

describe("bulgeArc / bulgeArcPoints", () => {
  it("bulge 0 (oder fehlend) → Gerade, keine Bogen-Tessellation", () => {
    const a = { x: 0, y: 0 }, b = { x: 4, y: 2 };
    expect(bulgeArc(a, b, 0)).toBeNull();
    expect(bulgeArcPoints(a, b, undefined)).toEqual([a, b]);
    expect(bulgeArcPoints(a, b, 0)).toEqual([a, b]);
  });

  it("bulge 1 (Halbkreis) über a=(0,0) b=(2,0): Apex bei (1,1), Radius 1, Zentrum (1,0)", () => {
    const a = { x: 0, y: 0 }, b = { x: 2, y: 0 };
    const arc = bulgeArc(a, b, 1);
    expect(arc).not.toBeNull();
    if (arc) {
      expect(arc.center.x).toBeCloseTo(1, 6);
      expect(arc.center.y).toBeCloseTo(0, 6);
      expect(arc.r).toBeCloseTo(1, 6);
    }
    const pts = bulgeArcPoints(a, b, 1);
    expect(pts[0].x).toBeCloseTo(0, 6);
    expect(pts[0].y).toBeCloseTo(0, 6);
    expect(pts[pts.length - 1].x).toBeCloseTo(2, 6);
    expect(pts[pts.length - 1].y).toBeCloseTo(0, 6);
    // Der mittlere Tessellations-Punkt (Apex) liegt bei (1,1) — links von a→b,
    // wie es die positive Bulge-Konvention definiert.
    const mid = pts[Math.round((pts.length - 1) / 2)];
    expect(mid.x).toBeCloseTo(1, 3);
    expect(mid.y).toBeCloseTo(1, 3);
    // Alle Punkte liegen exakt auf dem Kreis um (1,0) mit r=1.
    for (const p of pts) {
      expect(Math.hypot(p.x - 1, p.y - 0)).toBeCloseTo(1, 6);
    }
  });

  it("negativer bulge bulgt auf die andere Seite (rechts von a→b)", () => {
    const a = { x: 0, y: 0 }, b = { x: 2, y: 0 };
    const pts = bulgeArcPoints(a, b, -1);
    const mid = pts[Math.round((pts.length - 1) / 2)];
    expect(mid.x).toBeCloseTo(1, 3);
    expect(mid.y).toBeCloseTo(-1, 3);
  });

  it("kleiner bulge (flacher Bogen) bleibt nahe der Sehne", () => {
    const a = { x: 0, y: 0 }, b = { x: 10, y: 0 };
    const pts = bulgeArcPoints(a, b, 0.1);
    const mid = pts[Math.round((pts.length - 1) / 2)];
    // Sagitta = h*bulge = 5*0.1 = 0.5
    expect(mid.y).toBeCloseTo(0.5, 1);
  });
});

describe("bulgeFromSagittaPoint — Umkehrung für die Griff-Interaktion", () => {
  it("Apex-Punkt eines bekannten Bogens liefert exakt den ursprünglichen bulge zurück (Rundtrip)", () => {
    const a = { x: 0, y: 0 }, b = { x: 6, y: 0 };
    for (const b0 of [0.3, -0.5, 1, -1, 2]) {
      const pts = bulgeArcPoints(a, b, b0);
      const apex = pts[Math.round((pts.length - 1) / 2)];
      const back = bulgeFromSagittaPoint(a, b, apex);
      expect(back).toBeCloseTo(b0, 1);
    }
  });

  it("Punkt exakt auf der Sehne → bulge 0", () => {
    const a = { x: 0, y: 0 }, b = { x: 4, y: 0 };
    expect(bulgeFromSagittaPoint(a, b, { x: 2, y: 0 })).toBeCloseTo(0, 9);
  });
});

describe("bulgePolylinePoints (ganze Polylinie auf einmal)", () => {
  const sq: Vec2[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];

  it("entspricht der Verkettung von bulgeArcPoints je Kante", () => {
    const bulge = [1, 0, -0.5, 0];
    const expected: Vec2[] = [sq[0]];
    for (let i = 0; i < 3; i++) expected.push(...bulgeArcPoints(sq[i], sq[i + 1], bulge[i]).slice(1));
    const got = bulgePolylinePoints(sq, bulge, false);
    expect(got.length).toBe(expected.length);
    got.forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i].x, 12);
      expect(p.y).toBeCloseTo(expected[i].y, 12);
    });
  });

  it("geschlossen: Schlusskante enthalten, Startpunkt nicht wiederholt", () => {
    const got = bulgePolylinePoints(sq, [0, 0, 0, 1], true);
    expect(got[0]).toEqual(sq[0]);
    expect(got[got.length - 1]).not.toEqual(sq[0]);
    // Schlusskante (0,2)→(0,0) läuft nach −y, links davon ist +x: Halbkreis nach x > 0
    expect(got.some((p) => p.x > 0.5 && p.y > 0.5 && p.y < 1.5)).toBe(true);
  });

  it("Unsinn (leer, NaN) ohne Fehler", () => {
    expect(bulgePolylinePoints([], undefined, true)).toEqual([]);
    expect(bulgePolylinePoints([{ x: NaN, y: 0 }, { x: 1, y: 0 }], [1], false)).toEqual([]);
    expect(bulgeArc({ x: NaN, y: 0 }, { x: 1, y: 0 }, 1)).toBeNull();
    expect(bulgeArcPoints({ x: 0, y: 0 }, { x: 1, y: 0 }, NaN)).toHaveLength(2);
  });
});

describe("Abkürzung ohne Bögen (kein WASM-Aufruf)", () => {
  it("bulgePolylinePoints: gleiches Ergebnis wie der Rust-Pfad, offen und geschlossen", async () => {
    const { core } = await import("../engine/coreWasm");
    const pts = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }, { x: 0, y: 2 }];
    const flat = Float64Array.from(pts.flatMap((p) => [p.x, p.y]));
    for (const closed of [false, true]) {
      const viaRust = Array.from(core().bulge_polyline_points(flat, Float64Array.from([0, 0, 0, 0]), closed));
      const fast = bulgePolylinePoints(pts, [0, 0, 0, 0], closed).flatMap((p) => [p.x, p.y]);
      expect(fast).toEqual(viaRust);
      expect(bulgePolylinePoints(pts, undefined, closed)).toEqual(pts);
    }
  });
  it("bulgeArc: gerade und NaN → null", () => {
    expect(bulgeArc({ x: 0, y: 0 }, { x: 1, y: 0 }, 0)).toBeNull();
    expect(bulgeArc({ x: 0, y: 0 }, { x: 1, y: 0 }, Number.NaN)).toBeNull();
    expect(bulgeArc({ x: 0, y: 0 }, { x: 1, y: 0 }, 1)).not.toBeNull();
  });
});
