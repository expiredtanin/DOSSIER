// Fassade der Griff-Zug-Rechnung ([128], Kern `grip_drag.rs`): Übergabe an den Kern und zurück.

import { describe, expect, it } from "vitest";
import {
  gripArcWallTarget,
  coincidentGripPoints,
  gripAxisLock,
  gripEdgeTarget,
  gripPolar,
  gripPolarPoint,
  openingGripPoint,
  openingSheetSlide,
  openingTypedPosition,
  sheetHeightDrag,
  wallGripPoints,
} from "./gripDrag";

const wall = { start: { x: 0, y: 0 }, end: { x: 5, y: 0 } };

describe("Griff-Zug (Kern)", () => {
  it("Länge/Winkel und Punkt aus Locks", () => {
    expect(gripPolar({ x: 1, y: 1 }, { x: 1, y: 3 }, { x: 0, y: 1 })).toEqual({ length: 2, angleDeg: 90, offset: 2 });
    const p = gripPolarPoint({ x: 0, y: 0 }, { length: 5 }, { x: 3, y: 0 });
    expect(p.x).toBeCloseTo(5, 12);
    expect(p.y).toBeCloseTo(0, 12);
  });

  it("Shift-Achsen-Lock: Flucht der Nachbarkante, ohne Ring nur H/V", () => {
    const ring = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 3 }];
    const p = gripAxisLock({ x: 2.1, y: 1.9 }, { x: 0, y: 0 }, { x: 1, y: 1 }, ring, 1, false);
    expect(p.x).toBeCloseTo(2, 12);
    expect(p.y).toBeCloseTo(2, 12);
    expect(gripAxisLock({ x: 3, y: 0.4 }, { x: 0, y: 0 }, null, null, -1, false)).toEqual({ x: 3, y: 0 });
  });

  it("Kanten-Ziel: geführt mit Raster/Snap, frei mit Ortho, gelockt", () => {
    const guided = { mid: { x: 0, y: 0 }, normal: { x: 0, y: 1 }, aIndex: 0, bIndex: 1 };
    expect(gripEdgeTarget(guided, { x: 7, y: 1.3 }, { grid: 0.5 })).toEqual({ x: 0, y: 1.5 });
    expect(gripEdgeTarget(guided, { x: 7, y: 1.3 }, { grid: 0.5, snapped: { x: 2, y: 1.27 } })).toEqual({ x: 0, y: 1.27 });
    expect(gripEdgeTarget(guided, { x: 7, y: 1.3 }, { locks: { length: 0.25 } })).toEqual({ x: 0, y: 0.25 });
    const free = { ...guided, mid: { x: 1, y: 1 }, free: true };
    expect(gripEdgeTarget(free, { x: 3.2, y: 1.4 }, { shift: true })).toEqual({ x: 3.2, y: 1 });
  });

  it("Höhen-Griffe: Patch je Art", () => {
    expect(sheetHeightDrag("wallTop", { base: 3, top: 5.6, bottom: 3 }, 5.7349, false)).toEqual({ top: 5.73, bottom: 3, patch: { height: 2.73 } });
    const r = sheetHeightDrag("openingBottom", { base: 0, top: 2.1, bottom: 0.9 }, 0.6, false);
    expect(r.patch).toEqual({ sillHeight: 0.6, height: 1.5 });
  });

  it("Öffnung entlang der Wand und im Schnitt", () => {
    expect(openingGripPoint(wall, { position: 1, width: 1.2 })).toEqual({ x: 1.6, y: 0 });
    // Bogenwand (Halbkreis, Radius 2.5): Mitte bei der Bogenlänge 2.5·π/2 liegt im Scheitel.
    const g = openingGripPoint({ ...wall, bulge: 1 }, { position: 2.5 * Math.PI / 2 - 0.6, width: 1.2 });
    expect(g.x).toBeCloseTo(2.5, 9);
    expect(Math.abs(g.y)).toBeCloseTo(2.5, 9);
    expect(openingSheetSlide(wall, { position: 1, width: 1.2 }, { x: -1, y: 0 }, 0.5)).toEqual({ position: 0.5, du: 0.5 });
    expect(openingSheetSlide(wall, { position: 1, width: 1.2 }, { x: 0.1, y: 0.995 }, 1)).toBeNull();
    // [144] Bogenwand im Schnitt: die Öffnungsmitte folgt dem Blatt-Delta auf dem Bogen (Bogenlänge > Blatt-Weg).
    const arc = { ...wall, bulge: 1 };
    const s = openingSheetSlide(arc, { position: 3, width: 1 }, { x: 1, y: 0 }, 0.4)!;
    expect(s.du).toBeCloseTo(0.4, 6);
    expect(openingGripPoint(arc, { position: s.position, width: 1 }).x - openingGripPoint(arc, { position: 3, width: 1 }).x).toBeCloseTo(0.4, 6);
    expect(s.position - 3).toBeGreaterThan(0.4);
  });

  it("[144] getippte Länge an der Bogenwand = Bogenlänge ab der Lage beim Greifen", () => {
    const dir = { x: 1, y: 0 };
    const a = { x: 0, y: 0 };
    expect(openingTypedPosition(2, 1.5, a, { x: 1.5, y: 0 }, dir)).toBe(3.5);
    expect(openingTypedPosition(2, 1.5, a, { x: -1.5, y: 0.1 }, dir)).toBe(0.5);
  });

  it("Wand-Griffe und koinzidente Ecken", () => {
    expect(wallGripPoints({ ...wall })).toHaveLength(2);
    const g = wallGripPoints({ start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, bulge: 0.5 });
    expect(g[2].x).toBeCloseTo(2, 12);
    expect(g[2].y).toBeCloseTo(1, 12);
    const corners = [{ x: 0, y: 0 }, { x: 4, y: 0 }];
    const groups = [[{ x: 4.03, y: 0 }, { x: 4, y: 3 }], [], [{ x: 0, y: 0.04 }]];
    expect(coincidentGripPoints(corners, groups)).toEqual([{ group: 2, index: 0 }, { group: 0, index: 0 }]);
  });
});

describe("[T2] Bogenwand-Endpunkt-Griff", () => {
  const wall = { start: { x: 0, y: 0 }, end: { x: 4, y: 0 }, bulge: 1 };
  it("projiziert den Cursor auf den Kreis und meldet die Bogenlänge", () => {
    const r = gripArcWallTarget(wall, 1, undefined, { x: 2, y: 7 });
    expect(r?.pt.x).toBeCloseTo(2, 9);
    expect(r?.pt.y).toBeCloseTo(2, 9);
    expect(r?.arcLength).toBeCloseTo(Math.PI, 9);
  });
  it("getippte Bogenlänge ab dem festen Ende", () => {
    const r = gripArcWallTarget(wall, 1, Math.PI, { x: 3, y: 3 });
    expect(r?.pt.x).toBeCloseTo(2, 9);
    expect(r?.pt.y).toBeCloseTo(2, 9);
    expect(gripArcWallTarget(wall, 1, -1, { x: 3, y: 3 })).toBeNull();
  });
});
