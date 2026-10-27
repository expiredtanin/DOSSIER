/**
 * `geometry/bulge.ts` — Kreisbogen-Segmente in Polylinien (DXF-Bulge-
 * Konvention). Reine Geometrie-Tests, kein Modellbezug.
 */

import { describe, it, expect } from "vitest";
import {
  arcFromStartEndDirection,
  arcFromStartEndRadius,
  arcThroughPoints,
  bulgeArc,
  bulgeArcPoints,
  bulgePolylinePoints,
  bulgeFromSagittaPoint,
  bulgeThroughPoint,
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

describe("bulgeThroughPoint — Drei-Punkt-Bogen (unabhängig vom Vorgänger-Segment)", () => {
  it("Halbkreis über der Sehne: Durchgangspunkt im Scheitel", () => {
    const b = bulgeThroughPoint({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 4, y: 0 });
    // Halbkreis → |bulge| = 1 (Δ = 180°, tan(45°) = 1); Wölbung nach +Y
    // liegt LINKS von a→b, also positiv.
    expect(b).toBeCloseTo(1, 9);
  });

  it("Durchgangspunkt auf der anderen Seite kehrt das Vorzeichen um", () => {
    const b = bulgeThroughPoint({ x: 0, y: 0 }, { x: 2, y: -2 }, { x: 4, y: 0 });
    expect(b).toBeCloseTo(-1, 9);
  });

  it("der erzeugte Bogen läuft tatsächlich durch den Durchgangspunkt", () => {
    const a = { x: 0, y: 0 };
    const through = { x: 3, y: 1 };
    const bb = { x: 5, y: -2 };
    const bulge = bulgeThroughPoint(a, through, bb);
    const arc = bulgeArc(a, bb, bulge)!;
    // Der Durchgangspunkt liegt auf dem Kreis …
    expect(Math.hypot(through.x - arc.center.x, through.y - arc.center.y)).toBeCloseTo(arc.r, 9);
    // … und innerhalb der tatsächlich durchlaufenen Spanne.
    const TAU = Math.PI * 2;
    const norm = (x: number) => ((x % TAU) + TAU) % TAU;
    const rel = arc.sweep >= 0
      ? norm(Math.atan2(through.y - arc.center.y, through.x - arc.center.x) - arc.a0)
      : norm(arc.a0 - Math.atan2(through.y - arc.center.y, through.x - arc.center.x));
    expect(rel).toBeLessThanOrEqual(Math.abs(arc.sweep) + 1e-9);
  });

  it("kollineare Punkte → gerade (kein Kreis)", () => {
    expect(bulgeThroughPoint({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 5, y: 0 })).toBe(0);
  });

  it("die Grösse hängt NUR von den drei Punkten ab (unabhängig vom Startpunkt der Kette)", () => {
    // Dieselbe relative Geometrie an anderer Stelle ⇒ identischer Bulge.
    const b1 = bulgeThroughPoint({ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 0 });
    const b2 = bulgeThroughPoint({ x: 100, y: 50 }, { x: 102, y: 51 }, { x: 104, y: 50 });
    expect(b2).toBeCloseTo(b1, 12);
  });
});

describe("arcThroughPoints — Drei-Punkt-Bogen als {center,r,a0,a1} (commands/cmds/arc.ts)", () => {
  it("Viertelkreis (0°→90° via 45°) liefert Mittelpunkt/Radius/Winkel exakt", () => {
    const a = { x: 1, y: 0 };
    const through = { x: Math.SQRT1_2, y: Math.SQRT1_2 }; // 45°
    const b = { x: 0, y: 1 };
    const arc = arcThroughPoints(a, through, b)!;
    expect(arc).not.toBeNull();
    expect(arc.center.x).toBeCloseTo(0, 9);
    expect(arc.center.y).toBeCloseTo(0, 9);
    expect(arc.r).toBeCloseTo(1, 9);
    expect(arc.a0).toBeCloseTo(0, 9);
    expect(arc.a1).toBeCloseTo(Math.PI / 2, 9);
  });

  it("a0/a1 laufen IMMER CCW und decken den Durchgangspunkt ab, unabhängig von der Klickreihenfolge (a,through,b) vs (b,through,a)", () => {
    const a = { x: 1, y: 0 };
    const through = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
    const b = { x: 0, y: 1 };
    const forward = arcThroughPoints(a, through, b)!;
    const backward = arcThroughPoints(b, through, a)!;
    expect(backward.center.x).toBeCloseTo(forward.center.x, 9);
    expect(backward.center.y).toBeCloseTo(forward.center.y, 9);
    expect(backward.r).toBeCloseTo(forward.r, 9);
    expect(backward.a0).toBeCloseTo(forward.a0, 9);
    expect(backward.a1).toBeCloseTo(forward.a1, 9);
  });

  it("Start/End/Durchgangspunkt liegen alle auf dem Kreis, Durchgangspunkt innerhalb [a0,a1]", () => {
    const a = { x: 0, y: 0 };
    const through = { x: 3, y: 1 };
    const b = { x: 5, y: -2 };
    const arc = arcThroughPoints(a, through, b)!;
    const onCircle = (p: { x: number; y: number }) =>
      Math.hypot(p.x - arc.center.x, p.y - arc.center.y);
    expect(onCircle(a)).toBeCloseTo(arc.r, 9);
    expect(onCircle(b)).toBeCloseTo(arc.r, 9);
    expect(onCircle(through)).toBeCloseTo(arc.r, 9);
    const TAU = Math.PI * 2;
    const norm = (x: number) => ((x % TAU) + TAU) % TAU;
    const sweep = norm(arc.a1 - arc.a0);
    const toThrough = norm(Math.atan2(through.y - arc.center.y, through.x - arc.center.x) - arc.a0);
    expect(toThrough).toBeLessThanOrEqual(sweep + 1e-9);
  });

  it("kollineare Punkte → null (kein Kreis)", () => {
    expect(arcThroughPoints({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 5, y: 0 })).toBeNull();
  });
});

describe("arcFromStartEndRadius — Start/Ende/Radius (commands/cmds/arc.ts, dritte Methode)", () => {
  const onCircle = (arc: { center: Vec2; r: number }, p: Vec2) =>
    Math.hypot(p.x - arc.center.x, p.y - arc.center.y);
  const TAU = Math.PI * 2;
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;

  it("Halbkreis exakt bei r = halbe Sehnenlänge (Grenzfall)", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 4, y: 0 };
    const arc = arcFromStartEndRadius(a, b, 2, { x: 2, y: 5 })!;
    expect(arc).not.toBeNull();
    expect(arc.r).toBeCloseTo(2, 9);
    expect(onCircle(arc, a)).toBeCloseTo(2, 9);
    expect(onCircle(arc, b)).toBeCloseTo(2, 9);
    expect(norm(arc.a1 - arc.a0)).toBeCloseTo(Math.PI, 6); // exakt 180°
  });

  it("wölbt sich zur cursor-nahen Seite (near oberhalb → Bogenscheitel oberhalb der Sehne)", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 4, y: 0 };
    const arc = arcFromStartEndRadius(a, b, 3, { x: 2, y: 5 })!;
    const mid = arc.a0 + norm(arc.a1 - arc.a0) / 2;
    const apex = { x: arc.center.x + arc.r * Math.cos(mid), y: arc.center.y + arc.r * Math.sin(mid) };
    expect(apex.y).toBeGreaterThan(0);
  });

  it("wölbt sich zur ANDEREN Seite, wenn `near` unterhalb der Sehne liegt", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 4, y: 0 };
    const arc = arcFromStartEndRadius(a, b, 3, { x: 2, y: -5 })!;
    const mid = arc.a0 + norm(arc.a1 - arc.a0) / 2;
    const apex = { x: arc.center.x + arc.r * Math.cos(mid), y: arc.center.y + arc.r * Math.sin(mid) };
    expect(apex.y).toBeLessThan(0);
  });

  it("liefert immer den KLEINEREN Bogen (Sehnenwinkel ≤ 180°)", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 4, y: 0 };
    const arc = arcFromStartEndRadius(a, b, 10, { x: 2, y: 1 })!;
    expect(norm(arc.a1 - arc.a0)).toBeLessThanOrEqual(Math.PI + 1e-9);
  });

  it("liefert null, wenn der Radius kleiner als die halbe Sehnenlänge ist", () => {
    expect(arcFromStartEndRadius({ x: 0, y: 0 }, { x: 4, y: 0 }, 1, { x: 2, y: 1 })).toBeNull();
  });

  it("liefert null bei entarteter Sehne (a≈b)", () => {
    expect(arcFromStartEndRadius({ x: 1, y: 1 }, { x: 1, y: 1 }, 2, { x: 2, y: 2 })).toBeNull();
  });
});

describe("arcFromStartEndDirection — Start/Ende/Tangentenrichtung (commands/cmds/arc.ts, vierte Methode)", () => {
  const onCircle = (arc: { center: Vec2; r: number }, p: Vec2) =>
    Math.hypot(p.x - arc.center.x, p.y - arc.center.y);

  it("Viertelkreis: Tangente bei (1,0) nach +y führt zum Bogen bis (0,1)", () => {
    const a = { x: 1, y: 0 };
    const b = { x: 0, y: 1 };
    const dir = { x: 1, y: 1 }; // von a aus Richtung +y (tangential zum Einheitskreis bei a)
    const arc = arcFromStartEndDirection(a, b, dir)!;
    expect(arc).not.toBeNull();
    expect(arc.center.x).toBeCloseTo(0, 6);
    expect(arc.center.y).toBeCloseTo(0, 6);
    expect(arc.r).toBeCloseTo(1, 6);
    expect(onCircle(arc, a)).toBeCloseTo(1, 9);
    expect(onCircle(arc, b)).toBeCloseTo(1, 9);
  });

  it("Bogen-Tangente bei a zeigt tatsächlich in Richtung `dir`, nicht rückwärts", () => {
    const a = { x: 1, y: 0 };
    const b = { x: 0, y: 1 };
    const dir = { x: 1, y: 1 };
    const arc = arcFromStartEndDirection(a, b, dir)!;
    // CCW-Tangente bei a0 (Ableitung von (cos,sin) nach wachsendem Winkel).
    const tangentCCW = { x: -Math.sin(arc.a0), y: Math.cos(arc.a0) };
    const wantedDir = { x: dir.x - a.x, y: dir.y - a.y };
    const dot = tangentCCW.x * wantedDir.x + tangentCCW.y * wantedDir.y;
    expect(dot).toBeGreaterThan(0);
  });

  it("entgegengesetzte Tangentenrichtung liefert den KOMPLEMENTÄREN Bogen (gleicher Kreis, andere Seite)", () => {
    const a = { x: 1, y: 0 };
    const b = { x: 0, y: 1 };
    const forward = arcFromStartEndDirection(a, b, { x: 1, y: 1 })!;
    const backward = arcFromStartEndDirection(a, b, { x: 1, y: -1 })!;
    expect(backward.center.x).toBeCloseTo(forward.center.x, 6);
    expect(backward.center.y).toBeCloseTo(forward.center.y, 6);
    expect(backward.r).toBeCloseTo(forward.r, 6);
    // Unterschiedlicher Schwenk (a0/a1 vertauscht bzw. andere Bogenseite).
    expect(backward.a0).not.toBeCloseTo(forward.a0, 3);
  });

  it("liefert null bei entarteter Tangentenrichtung (dir≈a)", () => {
    expect(arcFromStartEndDirection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 0 })).toBeNull();
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
    expect(bulgeThroughPoint({ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 2, y: 0 })).toBe(0);
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
