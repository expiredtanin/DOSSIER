/**
 * Stützpunkte einer Polylinie einfügen/entfernen (Kontextmenü im Grundriss).
 * Schwerpunkt: die Bulge-Buchführung — ein eingefügter Punkt darf einen
 * Bogen nicht still zu zwei Geraden machen, und ein entfernter Punkt darf
 * die Bulge-Zuordnung der übrigen Segmente nicht verschieben.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import type { Drawing2D } from "../model/types";
import { bulgeArc } from "../geometry/bulge";

const POLY_ID = "poly-test";

/** Legt EINE Polylinie als einziges 2D-Element ins Projekt. */
function setPolyline(geom: Extract<Drawing2D["geom"], { shape: "polyline" }>) {
  const d: Drawing2D = {
    id: POLY_ID,
    type: "drawing2d",
    levelId: sampleProject.drawingLevels[0].id,
    categoryCode: sampleProject.layers[0].code,
    geom,
  };
  setState({
    project: { ...sampleProject, drawings2d: [d] },
    undoDepth: 0,
    redoDepth: 0,
    canUndo: false,
    canRedo: false,
  });
}

const poly = () => {
  const g = getState().project.drawings2d[0].geom;
  if (g.shape !== "polyline") throw new Error("keine Polylinie");
  return g;
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockImplementation(() => 1_000_000);
});
afterEach(() => vi.restoreAllMocks());

describe("insertDrawingPoint", () => {
  it("fügt den Punkt im gewählten Segment ein (gerade: exakt am übergebenen Punkt)", () => {
    setPolyline({ shape: "polyline", closed: false, pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }] });
    getState().insertDrawingPoint(POLY_ID, 0, { x: 2, y: 0 });
    expect(poly().pts).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }]);
  });

  it("geschlossene Polylinie: das Schluss-Segment (letzter → erster) ist einfügbar", () => {
    setPolyline({ shape: "polyline", closed: true, pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }] });
    getState().insertDrawingPoint(POLY_ID, 2, { x: 2, y: 1.5 });
    expect(poly().pts.length).toBe(4);
    expect(poly().pts[3]).toEqual({ x: 2, y: 1.5 });
  });

  it("offene Polylinie: hinter dem letzten Punkt gibt es kein Segment — no-op", () => {
    setPolyline({ shape: "polyline", closed: false, pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    getState().insertDrawingPoint(POLY_ID, 1, { x: 9, y: 9 });
    expect(poly().pts.length).toBe(2);
  });

  it("Bogen-Segment: teilt den Bogen exakt auf demselben Kreis, statt ihn zu begradigen", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 4, y: 0 };
    setPolyline({ shape: "polyline", closed: false, pts: [a, b], bulge: [0.5] });
    const orig = bulgeArc(a, b, 0.5)!;
    getState().insertDrawingPoint(POLY_ID, 0, { x: 2, y: 0 });

    const g = poly();
    expect(g.pts.length).toBe(3);
    // Der neue Punkt liegt auf dem ursprünglichen Bogen (Bogenmitte), NICHT
    // auf der Sehne — sonst wäre der Bogen zerstört.
    const mid = g.pts[1];
    expect(Math.abs(mid.y)).toBeGreaterThan(0.1);
    expect(Math.hypot(mid.x - orig.center.x, mid.y - orig.center.y)).toBeCloseTo(orig.r, 9);

    // Beide Teilbögen liegen auf demselben Kreis wie das Original (Mittelpunkt
    // + Radius identisch) und behalten die Schwenkrichtung.
    for (const [p0, p1, bl] of [
      [g.pts[0], g.pts[1], g.bulge![0]],
      [g.pts[1], g.pts[2], g.bulge![1]],
    ] as const) {
      const half = bulgeArc(p0, p1, bl)!;
      expect(half.center.x).toBeCloseTo(orig.center.x, 9);
      expect(half.center.y).toBeCloseTo(orig.center.y, 9);
      expect(half.r).toBeCloseTo(orig.r, 9);
      expect(Math.sign(half.sweep)).toBe(Math.sign(orig.sweep));
    }
    // Die zwei Teilschwenks ergeben zusammen den ursprünglichen Schwenk.
    const s1 = bulgeArc(g.pts[0], g.pts[1], g.bulge![0])!.sweep;
    const s2 = bulgeArc(g.pts[1], g.pts[2], g.bulge![1])!.sweep;
    expect(s1 + s2).toBeCloseTo(orig.sweep, 9);
  });
});

describe("deleteDrawingPoint", () => {
  it("entfernt genau den gewählten Punkt", () => {
    setPolyline({
      shape: "polyline",
      closed: false,
      pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }],
    });
    getState().deleteDrawingPoint(POLY_ID, 1);
    expect(poly().pts).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
  });

  it("entfernt den Bulge-Eintrag desselben Index (Zuordnung bleibt stimmig)", () => {
    setPolyline({
      shape: "polyline",
      closed: false,
      pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }, { x: 6, y: 0 }],
      bulge: [0.1, 0.2, 0.3],
    });
    getState().deleteDrawingPoint(POLY_ID, 1);
    expect(poly().bulge).toEqual([0.1, 0.3]);
  });

  it("blockiert, wenn zu wenige Punkte übrig blieben (offen <2, geschlossen <3)", () => {
    setPolyline({ shape: "polyline", closed: false, pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    getState().deleteDrawingPoint(POLY_ID, 0);
    expect(poly().pts.length).toBe(2);

    setPolyline({
      shape: "polyline",
      closed: true,
      pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }],
    });
    getState().deleteDrawingPoint(POLY_ID, 0);
    expect(poly().pts.length).toBe(3);
  });
});
