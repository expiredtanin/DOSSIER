/**
 * `geometry/bulge.ts` — Kreisbogen-Segmente in Polylinien (DXF-Bulge-
 * Konvention). Reine Geometrie-Tests, kein Modellbezug.
 */

import { describe, it, expect } from "vitest";
import { bulgeArc, bulgeArcPoints, bulgeFromSagittaPoint } from "./bulge";

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
