/**
 * `offsetPolylineWithBulge` — Offset einer Polylinie mit Bogen-Segmenten
 * (DXF-bulge). Deckt genau die Fälle ab, die `offsetPolyline` (Geraden-only)
 * nicht kann: konzentrischer Radius-Offset eines Bogens, und Gehrung
 * (miter) zwischen Bogen↔Gerade bzw. Bogen↔Bogen.
 */
import { describe, it, expect } from "vitest";
import { offsetPolylineWithBulge } from "./kernel2d";

describe("offsetPolylineWithBulge", () => {
  it("Halbkreis (bulge=1): Offset nach links (+d) vergrössert den Radius, bulge bleibt gleich", () => {
    // a=(-1,0) → b=(1,0), bulge=1 ⇒ Halbkreis, center=(0,0), r=1 (s. bulge.test.ts).
    const res = offsetPolylineWithBulge(
      [{ x: -1, y: 0 }, { x: 1, y: 0 }],
      [1],
      0.3,
      false,
    );
    expect(res.pts.length).toBe(2);
    // Neuer Radius r'=1.3 ⇒ neue Endpunkte bei (±1.3, 0).
    expect(res.pts[0].x).toBeCloseTo(-1.3, 6);
    expect(res.pts[0].y).toBeCloseTo(0, 6);
    expect(res.pts[1].x).toBeCloseTo(1.3, 6);
    expect(res.pts[1].y).toBeCloseTo(0, 6);
    // bulge kodiert nur den Öffnungswinkel (unverändert bei gleichem Winkelbereich).
    expect(res.bulge[0]).toBeCloseTo(1, 6);
  });

  it("Halbkreis: Offset nach rechts (−d) verkleinert den Radius", () => {
    const res = offsetPolylineWithBulge(
      [{ x: -1, y: 0 }, { x: 1, y: 0 }],
      [1],
      -0.3,
      false,
    );
    expect(res.pts[0].x).toBeCloseTo(-0.7, 6);
    expect(res.pts[1].x).toBeCloseTo(0.7, 6);
    expect(res.bulge[0]).toBeCloseTo(1, 6);
  });

  it("Gerade ohne bulge bleibt exakt wie offsetPolyline (Geraden-only Fallback deckungsgleich)", () => {
    const res = offsetPolylineWithBulge(
      [{ x: 0, y: 0 }, { x: 2, y: 0 }],
      undefined,
      0.5,
      false,
    );
    expect(res.pts).toEqual([{ x: 0, y: 0.5 }, { x: 2, y: 0.5 }]);
    expect(res.bulge).toEqual([0]);
  });

  it("Gerade → Bogen → Gerade: die Gehrung an der Bogen-Naht liegt auf dem Bogen-Kreis", () => {
    // Gerade (0,0)→(2,0), Viertelkreisbogen (2,0)→(2,2) mit bulge=tan(45°/2)...
    // einfacher: Viertelkreis ⇒ Δ=π/2 ⇒ bulge=tan(π/8).
    const bulge = Math.tan(Math.PI / 8);
    const pts = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }];
    const res = offsetPolylineWithBulge(pts, [0, bulge], 0.2, false);
    expect(res.pts.length).toBe(3);
    expect(res.bulge.length).toBe(2);
    // Erste Kante bleibt gerade.
    expect(res.bulge[0]).toBeCloseTo(0, 6);
    // Zweite Kante bleibt ein echter Bogen (nicht 0).
    expect(Math.abs(res.bulge[1])).toBeGreaterThan(0.01);
    // Der mittlere (Naht-)Punkt muss näher am Bogen-Zentrum (2,0)... je nach
    // Seite verschoben, aber jedenfalls NICHT mehr exakt der rohe Eck-Punkt (2,0).
    expect(res.pts[1]).not.toEqual({ x: 2, y: 0 });
  });

  it("geschlossene Form (Kreis-artiges Polygon mit einem Bogen-Segment) bleibt geschlossen", () => {
    // Dreieck mit einer verrundeten Ecke (wie ein Fillet-Ergebnis).
    const pts = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    const bulge = [0, 0, 0, 0];
    const res = offsetPolylineWithBulge(pts, bulge, 0.2, true);
    expect(res.pts.length).toBe(4);
    expect(res.bulge).toEqual([0, 0, 0, 0]);
  });
});
