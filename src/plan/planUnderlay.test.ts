import { describe, expect, it } from "vitest";
import type { DrawingLevel } from "../model/types";
import type { Primitive } from "./generatePlan";
import {
  PLAN_UNDERLAY_GAP_M,
  crossKindOverlayAllowed,
  mapPlanPoint,
  planToSectionMap,
  planUnderlayPrimitives,
} from "./planUnderlay";
import { sectionPlaneFromLevel, sectionUAxisModel } from "./toSection";

const level = (p0: { x: number; y: number }, p1: { x: number; y: number }, sign: 1 | -1 = 1): DrawingLevel => ({
  id: "s",
  name: "S",
  kind: "section",
  visible: true,
  locked: false,
  linePoints: [p0, p1],
  directionSign: sign,
});

const line = (a: { x: number; y: number }, b: { x: number; y: number }): Primitive => ({
  kind: "line",
  a,
  b,
  cls: "t",
  weightMm: 0.25,
});

describe("planToSectionMap", () => {
  it("u stimmt mit der Schnitt-u-Achse überein (Punkt liegt senkrecht unter seiner Projektion)", () => {
    for (const [lv, p] of [
      [level({ x: -1, y: 2 }, { x: 12, y: 2 }), { x: 4, y: 7 }],
      [level({ x: 3, y: 0 }, { x: 3, y: 9 }, -1), { x: 6, y: 2 }],
      [level({ x: 0, y: 0 }, { x: 5, y: 5 }), { x: 1, y: 3 }],
    ] as const) {
      const m = planToSectionMap(lv)!;
      const plane = sectionPlaneFromLevel(lv)!;
      const uAx = sectionUAxisModel(plane);
      const len = Math.hypot(uAx.x, uAx.y);
      const uExpected = ((p.x - plane.point[0]) * uAx.x + (p.y - plane.point[2]) * uAx.y) / len;
      expect(mapPlanPoint(m, p).x).toBeCloseTo(uExpected, 9);
    }
  });

  it("Blickrichtung zeigt im Blatt nach oben, keine Spiegelung", () => {
    // Linie entlang +x, Blick nach +y (Norden): reine Verschiebung.
    const m = planToSectionMap(level({ x: -1, y: 2 }, { x: 12, y: 2 }))!;
    expect(m.theta).toBeCloseTo(0, 12);
    const q = mapPlanPoint(m, { x: 0, y: 5 });
    expect(q.x).toBeCloseTo(1, 12);
    expect(q.y).toBeCloseTo(3, 12); // 3 m hinter der Linie → 3 m nach oben
    // Umgekehrte Blickrichtung: 180°-Drehung (Determinante +1).
    const r = planToSectionMap(level({ x: -1, y: 2 }, { x: 12, y: 2 }, -1))!;
    expect(Math.abs(r.theta)).toBeCloseTo(Math.PI, 12);
    expect(mapPlanPoint(r, { x: 0, y: 0 }).y).toBeCloseTo(2, 12);
  });

  it("ohne Linie keine Abbildung", () => {
    expect(planToSectionMap({ ...level({ x: 0, y: 0 }, { x: 1, y: 0 }), linePoints: undefined })).toBeNull();
  });
});

describe("planUnderlayPrimitives", () => {
  it("legt den Grundriss mit Abstand unter den Schnitt, gedimmt, plus Schnittlinie", () => {
    const lv = level({ x: -1, y: 2 }, { x: 12, y: 2 });
    const out = planUnderlayPrimitives(lv, [line({ x: 0, y: 0 }, { x: 11, y: 6 })], -0.3);
    const mapped = out[0] as Extract<Primitive, { kind: "line" }>;
    expect(mapped.greyed).toBe(true);
    // Oberste Grundriss-Kante (y = 6 → w = 4) liegt GAP unter der Schnitt-Unterkante.
    const top = Math.max(mapped.a.y, mapped.b.y);
    expect(top).toBeCloseTo(-0.3 - PLAN_UNDERLAY_GAP_M, 9);
    // u bleibt erhalten (x − (−1)).
    expect(Math.min(mapped.a.x, mapped.b.x)).toBeCloseTo(1, 9);
    const cut = out[out.length - 1] as Extract<Primitive, { kind: "line" }>;
    expect(cut.cls).toBe("section-underlay-line");
    expect(cut.b.x - cut.a.x).toBeCloseTo(13, 9);
    // Schnittlinie liegt 4 m unter der obersten Grundriss-Kante (w = 0).
    expect(cut.a.y).toBeCloseTo(top - 4, 9);
  });
});

describe("crossKindOverlayAllowed", () => {
  it("nur Ebenen im selben Koordinatenraum überlagern sich", () => {
    expect(crossKindOverlayAllowed("floor", "drawing")).toBe(true);
    expect(crossKindOverlayAllowed("floor", "section")).toBe(false);
    expect(crossKindOverlayAllowed("floor", "elevation")).toBe(false);
    expect(crossKindOverlayAllowed("section", "floor")).toBe(false);
    expect(crossKindOverlayAllowed("elevation", "section")).toBe(false);
    expect(crossKindOverlayAllowed("section", "drawing")).toBe(false);
    // Freie Zeichnung bleibt Kalkierpapier für alles.
    expect(crossKindOverlayAllowed("drawing", "section")).toBe(true);
    expect(crossKindOverlayAllowed("drawing", "floor")).toBe(true);
  });
});
