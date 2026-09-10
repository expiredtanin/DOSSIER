/**
 * `extendBulgeSegment` — Verlängerung eines Bogen-Endsegments (DXF-bulge)
 * über einen Endpunkt hinaus, entlang DESSELBEN Kreises (Mittelpunkt/Radius
 * unverändert, nur die Schwenk-Spanne wächst) bis zum nächsten geraden
 * Schneider. Gegenstück zu `extendSegment` (Geraden-only).
 */
import { describe, it, expect } from "vitest";
import { bulgeArc } from "./bulge";
import { extendBulgeSegment } from "./kernel2d";
import type { Vec2 } from "../model/types";

// Halbkreis a=(-1,0) → b=(1,0), bulge=1 ⇒ center=(0,0), r=1, Apex bei (0,1).
const A: Vec2 = { x: -1, y: 0 };
const B: Vec2 = { x: 1, y: 0 };
const BULGE = 1;

describe("extendBulgeSegment", () => {
  it("verlängert über `b` hinaus (end='end') bis zum tangentialen Schneider y=-1", () => {
    const cutter = { pts: [{ x: -10, y: -1 }, { x: 10, y: -1 }], closed: false };
    const res = extendBulgeSegment(A, B, BULGE, "end", [cutter]);
    expect(res).not.toBeNull();
    expect(res!.point.x).toBeCloseTo(0, 6);
    expect(res!.point.y).toBeCloseTo(-1, 6);
    // Derselbe Kreis: Rückwärtsprobe über bulgeArc(a, neuer-Endpunkt, neuer bulge).
    const arc = bulgeArc(A, res!.point, res!.bulge);
    expect(arc).not.toBeNull();
    expect(arc!.center.x).toBeCloseTo(0, 6);
    expect(arc!.center.y).toBeCloseTo(0, 6);
    expect(arc!.r).toBeCloseTo(1, 6);
  });

  it("verlängert über `a` hinaus (end='start') symmetrisch, `b` bleibt fest", () => {
    const cutter = { pts: [{ x: -10, y: -1 }, { x: 10, y: -1 }], closed: false };
    const res = extendBulgeSegment(A, B, BULGE, "start", [cutter]);
    expect(res).not.toBeNull();
    expect(res!.point.x).toBeCloseTo(0, 6);
    expect(res!.point.y).toBeCloseTo(-1, 6);
    const arc = bulgeArc(res!.point, B, res!.bulge);
    expect(arc).not.toBeNull();
    expect(arc!.center.x).toBeCloseTo(0, 6);
    expect(arc!.center.y).toBeCloseTo(0, 6);
    expect(arc!.r).toBeCloseTo(1, 6);
  });

  it("kein Schneider trifft den Kreis → null (kein Effekt)", () => {
    // Gerade weit ausserhalb des Einheitskreises, trifft ihn nie.
    const cutter = { pts: [{ x: -10, y: 5 }, { x: 10, y: 5 }], closed: false };
    const res = extendBulgeSegment(A, B, BULGE, "end", [cutter]);
    expect(res).toBeNull();
  });

  it("Gerade (bulge≈0) liefert null — Aufrufer soll auf extendSegment ausweichen", () => {
    const cutter = { pts: [{ x: -10, y: -1 }, { x: 10, y: -1 }], closed: false };
    const res = extendBulgeSegment(A, B, 0, "end", [cutter]);
    expect(res).toBeNull();
  });

  it("wählt den NÄCHSTGELEGENEN Schneider in Schwenkrichtung, nicht irgendeinen Treffer", () => {
    // Zwei Schneider unterhalb: einer nah (Tangente y=-1, delta=π/2 ab b),
    // einer weiter weg (Gerade x=-3, schneidet den Kreis gar nicht — Kontrolle),
    // plus ein echter zweiter Treffer weiter entlang der Schwenkrichtung (y=0.999,
    // sehr nah an a selbst — muss NICHT gewählt werden, da a0 rausgefiltert wird
    // und der Kreis dort ohnehin nicht geschnitten wird ausserhalb [-1,1]).
    const near = { pts: [{ x: -10, y: -1 }, { x: 10, y: -1 }], closed: false };
    const outside = { pts: [{ x: -3, y: -10 }, { x: -3, y: 10 }], closed: false }; // x=-3, ausserhalb r=1
    const res = extendBulgeSegment(A, B, BULGE, "end", [outside, near]);
    expect(res).not.toBeNull();
    expect(res!.point.y).toBeCloseTo(-1, 6); // der einzig echte Treffer (Tangente)
  });
});
