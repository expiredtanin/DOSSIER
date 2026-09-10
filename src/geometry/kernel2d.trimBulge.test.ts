/**
 * `trimPolylineWithBulge` — Quick-Trim einer Ziel-Kurve mit Bogen-Segmenten
 * (bulge). Deckt sowohl GERADE als auch BOGEN-Schneider ab (Kreis↔Gerade UND
 * Kreis↔Kreis, s. `edgeIntersectTs` im Kernel): ein Bogen-Segment wird korrekt
 * zerschnitten, der verbleibende Teilbogen behält seine Krümmung (neu
 * hergeleiteter bulge-Wert).
 */
import { describe, it, expect } from "vitest";
import { bulgeArc } from "./bulge";
import { trimPolylineWithBulge } from "./kernel2d";

describe("trimPolylineWithBulge", () => {
  it("Halbkreis, gegen eine senkrechte Gerade am Apex getrimmt: die geklickte Hälfte fällt weg", () => {
    // a=(-1,0) → b=(1,0), bulge=1 ⇒ Halbkreis, center=(0,0), r=1.
    const pts = [{ x: -1, y: 0 }, { x: 1, y: 0 }];
    const bulge = [1];
    const cutter = { pts: [{ x: 0, y: -5 }, { x: 0, y: 5 }], closed: false };
    // Klick im rechten Viertelbogen (zwischen Apex (0,1) und b=(1,0)).
    const pick = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
    const rest = trimPolylineWithBulge(pts, bulge, false, [cutter], pick);
    expect(rest.length).toBe(1);
    const [chain] = rest;
    expect(chain.pts.length).toBe(2);
    expect(chain.pts[0].x).toBeCloseTo(-1, 6);
    expect(chain.pts[0].y).toBeCloseTo(0, 6);
    expect(chain.pts[1].x).toBeCloseTo(0, 6);
    expect(chain.pts[1].y).toBeCloseTo(1, 6);
    // Der verbleibende Viertelbogen muss geometrisch exakt auf demselben Kreis
    // liegen (center=(0,0), r=1) — bulge kodiert weiterhin einen echten Bogen.
    const arc = bulgeArc(chain.pts[0], chain.pts[1], chain.bulge[0]);
    expect(arc).not.toBeNull();
    expect(arc!.center.x).toBeCloseTo(0, 5);
    expect(arc!.center.y).toBeCloseTo(0, 5);
    expect(arc!.r).toBeCloseTo(1, 5);
  });

  it("kein Schnitt mit dem Cutter → Kurve bleibt unverändert (inkl. bulge)", () => {
    const pts = [{ x: -1, y: 0 }, { x: 1, y: 0 }];
    const bulge = [1];
    const cutter = { pts: [{ x: 10, y: -5 }, { x: 10, y: 5 }], closed: false };
    const rest = trimPolylineWithBulge(pts, bulge, false, [cutter], { x: 0, y: 1 });
    expect(rest.length).toBe(1);
    expect(rest[0].pts).toEqual(pts);
    expect(rest[0].bulge).toEqual([1]);
  });

  it("gerade Kanten in einer gemischten Kurve bleiben unangetastet (bulge=0)", () => {
    // Gerade (0,0)→(2,0), dann Halbkreis (2,0)→(4,0) mit bulge=1 (center=(3,0),r=1).
    const pts = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }];
    const bulge = [0, 1];
    const cutter = { pts: [{ x: 1, y: -5 }, { x: 1, y: 5 }], closed: false };
    const rest = trimPolylineWithBulge(pts, bulge, false, [cutter], { x: 0.5, y: 0 });
    // Der Schnitt liegt auf der GERADEN ersten Kante bei x=1 → das linke Stück
    // (0,0)→(1,0), angeklickt, fällt weg; das rechte Stück bleibt (gerade
    // Restkante + unverändertem Bogen).
    expect(rest.length).toBe(1);
    expect(rest[0].pts[0].x).toBeCloseTo(1, 6);
    expect(rest[0].bulge[0]).toBeCloseTo(0, 6); // Rest der geraden Kante
    expect(rest[0].bulge[1]).toBeCloseTo(1, 6); // Bogen unverändert
  });

  it("GERADES Ziel gegen einen BOGEN-Schneider: der Kreis-Schnitt zählt als Cut-Knoten", () => {
    // Ziel: waagrechte Gerade y=0 von x=-5 bis x=5.
    const pts = [{ x: -5, y: 0 }, { x: 5, y: 0 }];
    // Schneider: Bogen von (0,-2) nach (0,2) mit bulge=1 ⇒ center=(0,0), r=2,
    // bulgt nach LINKS (Apex bei (-2,0)) — kreuzt die Ziel-Gerade exakt einmal
    // bei (-2,0) (Apex liegt genau auf der Geraden).
    const cutter = { pts: [{ x: 0, y: -2 }, { x: 0, y: 2 }], closed: false, bulge: [1] };
    // Klick LINKS vom Schnittpunkt → das linke Stück [-5,-2] fällt weg.
    const rest = trimPolylineWithBulge(pts, undefined, false, [cutter], { x: -3, y: 0 });
    expect(rest.length).toBe(1);
    expect(rest[0].pts[0].x).toBeCloseTo(-2, 6);
    expect(rest[0].pts[0].y).toBeCloseTo(0, 6);
    expect(rest[0].pts[1]).toEqual({ x: 5, y: 0 });
  });

  it("BOGEN-Ziel gegen BOGEN-Schneider: Kreis↔Kreis-Schnitt, Treffer nur innerhalb BEIDER Spannen", () => {
    // Ziel: oberer Halbkreis, center=(0,0), r=1 (a=(-1,0)→b=(1,0), bulge=1).
    const targetPts = [{ x: -1, y: 0 }, { x: 1, y: 0 }];
    const targetBulge = [1];
    // Schneider: oberer Halbkreis von center=(1,0), r=1 (a=(0,0)→b=(2,0), bulge=1,
    // per Translationssymmetrie zum Ziel — ebenfalls die obere Hälfte).
    // Klassischer "Vesica Piscis"-Schnitt zweier Einheitskreise im Abstand 1:
    // (0.5, ±√3/2) — nur der OBERE Punkt liegt in BEIDEN oberen Halbkreis-Spannen.
    const cutter = { pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }], closed: false, bulge: [1] };
    // Klick nahe a=(-1,0) (vor dem Schnittpunkt in Schwenkrichtung) → das
    // Stück von a bis zum Schnittpunkt fällt weg, der Rest (Schnittpunkt→b) bleibt.
    const pick = { x: Math.cos((2 * Math.PI) / 3), y: Math.sin((2 * Math.PI) / 3) }; // 120°, vor dem Schnitt bei 60°
    const rest = trimPolylineWithBulge(targetPts, targetBulge, false, [cutter], pick);
    expect(rest.length).toBe(1);
    const [chain] = rest;
    expect(chain.pts[0].x).toBeCloseTo(0.5, 6);
    expect(chain.pts[0].y).toBeCloseTo(Math.sqrt(3) / 2, 6);
    expect(chain.pts[chain.pts.length - 1]).toEqual({ x: 1, y: 0 });
    // Der verbleibende Bogen liegt weiterhin exakt auf dem ZIEL-Kreis (0,0)/r=1,
    // NICHT auf dem Schneider-Kreis.
    const arc = bulgeArc(chain.pts[0], chain.pts[chain.pts.length - 1], chain.bulge[0]);
    expect(arc).not.toBeNull();
    expect(arc!.center.x).toBeCloseTo(0, 5);
    expect(arc!.center.y).toBeCloseTo(0, 5);
    expect(arc!.r).toBeCloseTo(1, 5);
  });

  it("Bogen-Schneider ausserhalb seiner eigenen Spanne zählt NICHT als Treffer", () => {
    // Gleiche Kreis-Geometrie wie oben (Vesica Piscis, Schnitt bei (0.5, ±√3/2)),
    // aber der Schneider deckt nur den UNTEREN Halbkreis seines Kreises ab
    // (a=(0,0)→b=(2,0), bulge=-1) — der relevante obere Schnittpunkt (0.5,√3/2)
    // liegt dann ausserhalb der Schneider-Spanne → kein Cut, Ziel bleibt ganz.
    const targetPts = [{ x: -1, y: 0 }, { x: 1, y: 0 }];
    const targetBulge = [1];
    const cutter = { pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }], closed: false, bulge: [-1] };
    const pick = { x: 0, y: 1 }; // Apex des Ziel-Bogens
    const rest = trimPolylineWithBulge(targetPts, targetBulge, false, [cutter], pick);
    expect(rest.length).toBe(1);
    expect(rest[0].pts).toEqual(targetPts);
    expect(rest[0].bulge).toEqual([1]);
  });
});
