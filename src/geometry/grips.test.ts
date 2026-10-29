import { describe, expect, it } from "vitest";
import { drawingVertices, openEdges, polylineEdgeGrips, ringEdges } from "./grips";
import { documentFor } from "../core/document";
import type { Drawing2D, Project } from "../model/types";

// ── Bemassung: Masszahl-Griffe (Lage und Einrasten rechnet der Kern, `grips.rs`) ──

const dim = (pts: { x: number; y: number }[], offset: number, textOffsetsMm?: { along: number; perp: number }[]): Drawing2D =>
  ({ id: "m", type: "drawing2d", levelId: "f", categoryCode: "1", geom: { shape: "dimension", pts, offset, textHeightMm: 4, ...(textOffsetsMm ? { textOffsetsMm } : {}) } }) as Drawing2D;
const A = { x: 0, y: 0 };
const B = { x: 4, y: 0 };
/** Schrifthöhe 4 mm bei 1:50 in Modell-Metern. */
const H = 0.2;

describe("Bemassung: Griffe der Masszahl", () => {
  it("Standardlage: mittig über der Masslinie (Offset eingerechnet), Reihenfolge Punkte · Masslinie · Zahl", () => {
    const v = drawingVertices(dim([A, B], 1), 50);
    expect(v).toHaveLength(4);
    expect(v[2]).toEqual({ x: 2, y: 1 });
    expect(v[3].x).toBeCloseTo(2, 9);
    expect(v[3].y).toBeCloseTo(1 + H * 0.6, 9);
  });

  it("Leserichtung nie kopfüber — auch bei rückwärts laufender Kette", () => {
    const fwd = drawingVertices(dim([A, B], 0), 50)[3];
    const back = drawingVertices(dim([B, A], 0), 50)[3];
    expect(back.x).toBeCloseTo(fwd.x, 9);
    expect(back.y).toBeCloseTo(fwd.y, 9);
  });

  it("Versatz (Papier-mm) wirkt entlang der Leserichtung und quer dazu", () => {
    const base = drawingVertices(dim([A, B], 0), 50)[3];
    // 20 mm / 40 mm bei 1:50 = 1 m / 2 m.
    const p = drawingVertices(dim([A, B], 0, [{ along: 20, perp: 40 }]), 50)[3];
    expect(p.x).toBeCloseTo(base.x + 1, 9);
    expect(p.y).toBeCloseTo(base.y + 2, 9);
  });

  const drag = (d: Drawing2D, pt: { x: number; y: number }) => {
    const p = { drawings2d: [d], walls: [] } as unknown as Project;
    const res = documentFor(p).gripOps({ op: "moveGrip", drawingId: "m", wallId: null, index: d.geom.shape === "dimension" ? d.geom.pts.length + 1 : 0, pt: [pt.x, pt.y], scale: 50 });
    const e = res.ops[0] as unknown as { entity: Drawing2D };
    return (e.entity.geom as { textOffsetsMm: { along: number; perp: number }[] }).textOffsetsMm[0];
  };

  it("nahe der Standardlage rastet BEIDES auf 0 ein", () => {
    const base = drawingVertices(dim([A, B], 0), 50)[3];
    expect(drag(dim([A, B], 0), { x: base.x + H * 0.2, y: base.y - H * 0.2 })).toEqual({ along: 0, perp: 0 });
  });

  it("die Achsen rasten UNABHÄNGIG ein (seitlich verschoben, Höhe exakt Standard)", () => {
    const base = drawingVertices(dim([A, B], 0), 50)[3];
    const o = drag(dim([A, B], 0), { x: base.x + 1.5, y: base.y + H * 0.1 });
    expect(o.along).toBeCloseTo(30, 9);
    expect(o.perp).toBe(0);
  });

  it("ausserhalb des Fangbereichs bleibt der gezogene Wert erhalten", () => {
    const base = drawingVertices(dim([A, B], 0), 50)[3];
    const o = drag(dim([A, B], 0), { x: base.x + 0.8, y: base.y + 0.6 });
    expect(o.along).toBeCloseTo(16, 9);
    expect(o.perp).toBeCloseTo(12, 9);
  });

  it("Rundreise: gezogene Position → Versatz → Griff liegt wieder am Punkt", () => {
    const pt = { x: 3.1, y: 1.4 };
    const o = drag(dim([A, B], 0.5), pt);
    const back = drawingVertices(dim([A, B], 0.5, [o]), 50)[3];
    expect(back.x).toBeCloseTo(pt.x, 9);
    expect(back.y).toBeCloseTo(pt.y, 9);
  });
});

describe("Kanten-Griffe von Ringen und Ketten", () => {
  it("Ring: Normalen nach aussen, auch die Schlusskante; Kette: frei, ohne Schlusskante", () => {
    const tri = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }];
    const r = ringEdges(tri, {});
    expect(r.map((e) => [e.aIndex, e.bIndex])).toEqual([[0, 1], [1, 2], [2, 0]]);
    expect(r[0].normal.x).toBeCloseTo(0, 12);
    expect(r[0].normal.y).toBe(-1);
    expect(r[2].normal.x).toBeCloseTo(-1, 12);
    const o = openEdges(tri, { wallId: "w" });
    expect(o.map((e) => [e.aIndex, e.bIndex, e.free, e.owner?.wallId])).toEqual([[0, 1, true, "w"], [1, 2, true, "w"]]);
    expect(ringEdges(tri.slice(0, 2), {})).toEqual([]);
  });
});

const sq = [
  { x: 0, y: 0 },
  { x: 30, y: 0 },
  { x: 30, y: 30 },
  { x: 0, y: 30 },
];

describe("polylineEdgeGrips", () => {
  it("geschlossen, gerade: 4 Kanten auf den Seitenmitten, Normalen nach aussen", () => {
    const e = polylineEdgeGrips({ shape: "polyline", pts: sq, closed: true }, { drawingId: "d" });
    expect(e.map((g) => g.mid)).toEqual([
      { x: 15, y: 0 },
      { x: 30, y: 15 },
      { x: 15, y: 30 },
      { x: 0, y: 15 },
    ]);
    expect(e.map((g) => [g.aIndex, g.bIndex])).toEqual([[0, 1], [1, 2], [2, 3], [3, 0]]);
    expect(e[0].normal.y).toBeCloseTo(-1);
    expect(e[1].normal.x).toBeCloseTo(1);
  });

  it("geschlossen mit Bögen: nur gerade Seiten, keine Kanten über die Bogen-Mitten (nichts im Innern)", () => {
    const e = polylineEdgeGrips(
      { shape: "polyline", pts: sq, closed: true, bulge: [0.12, 0, -0.15, 0] },
      { drawingId: "d" },
    );
    expect(e.map((g) => g.mid)).toEqual([
      { x: 30, y: 15 },
      { x: 0, y: 15 },
    ]);
    // Lauter Bögen (Strassenparzelle): keine Kanten-Griffe.
    expect(polylineEdgeGrips({ shape: "polyline", pts: sq, closed: true, bulge: [0.1, 0.1, 0.1, 0.1] }, {})).toEqual([]);
  });

  it("offen: je gerades Segment ein freier Griff, ohne Schlusskante", () => {
    const e = polylineEdgeGrips({ shape: "polyline", pts: sq, closed: false, bulge: [0, 0.3, 0] }, {});
    expect(e.map((g) => [g.aIndex, g.bIndex, g.free])).toEqual([[0, 1, true], [2, 3, true]]);
  });
});
