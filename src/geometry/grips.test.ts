import { describe, expect, it } from "vitest";
import { drawingVertices, edgeArcToggle, openEdges, polylineEdgeGrips, ringEdges } from "./grips";
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

  const drag = (d: Drawing2D, pt: { x: number; y: number }, free = false) => {
    const p = { drawings2d: [d], walls: [] } as unknown as Project;
    const res = documentFor(p).gripOps({ op: "moveGrip", drawingId: "m", wallId: null, index: d.geom.shape === "dimension" ? d.geom.pts.length + 1 : 0, pt: [pt.x, pt.y], scale: 50, ...(free ? { free: true } : {}) });
    const e = res.ops[0] as unknown as { entity: Drawing2D };
    return (e.entity.geom as { textOffsetsMm: { along: number; perp: number }[] }).textOffsetsMm[0];
  };

  it("nahe der Mitte rastet BEIDES auf 0 ein (Vorgabe)", () => {
    const base = drawingVertices(dim([A, B], 0), 50)[3];
    expect(drag(dim([A, B], 0), { x: base.x + H * 0.2, y: base.y - H * 0.2 })).toEqual({ along: 0, perp: 0 });
  });

  it("rastet an festen Stellen ein: innen, aussen, eine Zeile über/unter der Linie", () => {
    const base = drawingVertices(dim([A, B], 0), 50)[3];
    const at = (dx: number, dy = 0) => drag(dim([A, B], 0), { x: base.x + dx, y: base.y + dy });
    // Segment 4 m, Zahl „4.00" ~ 0.4 m breit: innen bündig vor der Hilfslinie, aussen dahinter.
    const inner = at(1.5);
    const outer = at(2.6);
    expect(inner.perp).toBe(0);
    expect(outer.perp).toBe(0);
    expect(inner.along).toBeGreaterThan(0);
    expect(outer.along).toBeGreaterThan(inner.along);
    expect(outer.along * (50 / 1000)).toBeGreaterThan(2); // Mitte der Zahl hinter der Hilfslinie
    expect(at(-1.5).along).toBeCloseTo(-inner.along, 9);
    expect(at(-2.6).along).toBeCloseTo(-outer.along, 9);
    // Leicht schief gezogen: trotzdem genau eine Stelle (kein Zwischenwert).
    expect(at(2.5, 0.05)).toEqual(outer);
    const up = at(0.1, 0.3);
    const down = at(0.1, -0.3);
    expect(up).toEqual({ along: 0, perp: 5.4 });
    expect(down).toEqual({ along: 0, perp: -7.8 });
  });

  it("mit gehaltener Taste (free) bleibt die gezogene Position erhalten", () => {
    const base = drawingVertices(dim([A, B], 0), 50)[3];
    const o = drag(dim([A, B], 0), { x: base.x + 0.8, y: base.y + 0.6 }, true);
    expect(o.along).toBeCloseTo(16, 9);
    expect(o.perp).toBeCloseTo(12, 9);
  });

  it("Rundreise (frei): gezogene Position → Versatz → Griff liegt wieder am Punkt", () => {
    const pt = { x: 3.1, y: 1.4 };
    const o = drag(dim([A, B], 0.5), pt, true);
    const back = drawingVertices(dim([A, B], 0.5, [o]), 50)[3];
    expect(back.x).toBeCloseTo(pt.x, 9);
    expect(back.y).toBeCloseTo(pt.y, 9);
  });

  it("Rundreise (eingerastet): Griff liegt auf der Einrast-Stelle", () => {
    const base = drawingVertices(dim([A, B], 0), 50)[3];
    const o = drag(dim([A, B], 0), { x: base.x + 2.6, y: base.y });
    const back = drawingVertices(dim([A, B], 0, [o]), 50)[3];
    expect(back.x).toBeGreaterThan(base.x + 2);
    expect(back.y).toBeCloseTo(base.y, 9);
  });

  it("Zu schmales Segment: Griff steht dort, wo die Zahl nach aussen gewichen ist", () => {
    const short = drawingVertices(dim([A, { x: 0.3, y: 0 }], 0), 50);
    expect(short[3].x).toBeLessThan(0);
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

describe("[191] Kante gerade ↔ Bogen", () => {
  const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
  it("gerade → Segmentbogen nach aussen (Pfeilhöhe Sehne/4), unabhängig vom Umlaufsinn", () => {
    expect(edgeArcToggle(sq, undefined, 1)).toEqual({ pt: { x: 5, y: 2 }, toArc: true });
    // Im Uhrzeigersinn ist Kante 0 die Nordkante (0,4) → (4,4): aussen liegt darüber.
    expect(edgeArcToggle([...sq].reverse(), [0, 0, 0, 0], 0)).toEqual({ pt: { x: 2, y: 5 }, toArc: true });
  });
  it("Bogen → Sehnenmitte (gerade), Unsinn → null", () => {
    expect(edgeArcToggle(sq, [0, -1, 0, 0], 1)).toEqual({ pt: { x: 4, y: 2 }, toArc: false });
    expect(edgeArcToggle(sq, undefined, 4)).toBeNull();
    expect(edgeArcToggle(sq.slice(0, 2), undefined, 0)).toBeNull();
  });
});
