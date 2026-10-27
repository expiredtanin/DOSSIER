/**
 * `addDrawing2D` — Rendering der neuen Freiform-Geometrien (ellipse/bezier/
 * spline): tessellierte Linien-/Polygon-Primitive wie bei polyline/rect,
 * kein eigenes SVG-Primitiv (s. `model/types.ts` Drawing2DGeom-Doku).
 */

import { describe, it, expect } from "vitest";
import { addDrawing2D } from "./drawing2d";
import type { Drawing2D, Project } from "../../model/types";
import type { Primitive } from "./shared";

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

const lwByCode = new Map<string, number>();
const colorByCode = new Map<string, string>();
const catByCode = new Map<string, Project["layers"][number]>();

describe("addDrawing2D — ellipse", () => {
  it("gibt eine gefüllte Fläche + geschlossenen Linienzug (64 Segmente) aus", () => {
    const d: Drawing2D = {
      id: "e1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "ellipse", center: { x: 0, y: 0 }, rx: 4, ry: 2, rotation: 0 },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    const polys = out.filter((p) => p.kind === "polygon");
    const lines = out.filter((p) => p.kind === "line");
    expect(polys.length).toBe(1);
    expect(lines.length).toBe(64);
    for (const l of lines) expect(l.drawingId).toBe("e1");
    // Alle Punkte liegen auf der (unrotierten) Ellipse.
    for (const l of lines) {
      const dx = l.a.x / 4, dy = l.a.y / 2;
      expect(dx * dx + dy * dy).toBeCloseTo(1, 3);
    }
  });
});

describe("addDrawing2D — bezier", () => {
  it("ein Segment: tessellierte offene Linienkette, kein Füll-Polygon", () => {
    const d: Drawing2D = {
      id: "b1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "bezier",
        pts: [{ x: 0, y: 0 }, { x: 1, y: 3 }, { x: 3, y: 3 }, { x: 4, y: 0 }],
      },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.every((p) => p.kind === "line")).toBe(true);
    expect(out.length).toBe(24); // segsPerCurve Default
    const lines = out.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line");
    expect(lines[0].a).toEqual({ x: 0, y: 0 });
    const last = lines[lines.length - 1];
    expect(last.b.x).toBeCloseTo(4, 6);
    expect(last.b.y).toBeCloseTo(0, 6);
  });
});

describe("addDrawing2D — spline", () => {
  it("offen: tessellierte Linienkette durch die Wegpunkte, kein Füll-Polygon", () => {
    const d: Drawing2D = {
      id: "s1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "spline", pts: [{ x: 0, y: 0 }, { x: 2, y: 3 }, { x: 5, y: 1 }], closed: false },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.some((p) => p.kind === "polygon")).toBe(false);
    const lines = out.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line");
    expect(lines[0].a).toEqual({ x: 0, y: 0 });
    const last = lines[lines.length - 1];
    expect(last.b.x).toBeCloseTo(5, 6);
    expect(last.b.y).toBeCloseTo(1, 6);
  });

  it("geschlossen: Füll-Polygon + Linienring schliesst zum ersten Punkt", () => {
    const d: Drawing2D = {
      id: "s2",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "spline",
        pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
        closed: true,
      },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.filter((p) => p.kind === "polygon").length).toBe(1);
    const lines = out.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line");
    const last = lines[lines.length - 1];
    expect(last.b).toEqual(lines[0].a);
  });

  it("mode:'control' rendert einen B-Spline (Kontrollpunkt-Modus) statt Catmull-Rom — berührt den inneren Kontrollpunkt NICHT", () => {
    const d: Drawing2D = {
      id: "s3",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "spline",
        pts: [{ x: 0, y: 0 }, { x: 2, y: 10 }, { x: 6, y: 10 }, { x: 8, y: 0 }],
        closed: false,
        mode: "control",
      },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    const lines = out.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line");
    expect(lines[0].a).toEqual({ x: 0, y: 0 }); // geklemmt: Start exakt getroffen
    const last = lines[lines.length - 1];
    expect(last.b.x).toBeCloseTo(8, 6);
    expect(last.b.y).toBeCloseTo(0, 6);
    // Der innere Kontrollpunkt (2,10) darf NICHT auf der Kurve liegen (Gegensatz
    // zu Catmull-Rom, das interpoliert) — sonst wäre es fälschlich derselbe
    // Sampler wie im Default-Modus.
    const touchesInner = lines.some((ln) => Math.hypot(ln.a.x - 2, ln.a.y - 10) < 1e-6);
    expect(touchesInner).toBe(false);
  });
});

describe("addDrawing2D — dimension (SIA 400 B.5.3)", () => {
  it("gibt 2 Masshilfslinien + 1 Masslinie (dünn) + 2 Massstriche (doppelte Stärke) + 1 Masszahl-Text aus", () => {
    const d: Drawing2D = {
      id: "dim1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "dimension", pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }], offset: 1 },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    const lines = out.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line");
    const texts = out.filter((p) => p.kind === "drawingText");
    expect(lines.length).toBe(5); // 2 Masshilfslinien + 1 Masslinie + 2 Massstriche
    expect(texts.length).toBe(1);
    const weights = lines.map((l) => l.weightMm).sort((a, b) => a - b);
    const thin = weights[0];
    const thick = weights[weights.length - 1];
    // 3× dünn (Masshilfslinien + Masslinie), 2× doppelt so dick (Massstriche).
    expect(weights.filter((w) => w === thin).length).toBe(3);
    expect(weights.filter((w) => w === thick).length).toBe(2);
    expect(thick).toBeCloseTo(thin * 2, 6);
  });

  it("Masszahl entspricht dist(a,b), 2 Dezimalstellen (SIA 400 Figur 13/14: Punkt-Notation)", () => {
    const d: Drawing2D = {
      id: "dim2",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "dimension", pts: [{ x: 0, y: 0 }, { x: 3, y: 4 }], offset: 0.5 }, // 3-4-5-Dreieck → 5m
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    const text = out.find((p) => p.kind === "drawingText");
    expect(text).toBeDefined();
    if (text?.kind === "drawingText") expect(text.text).toBe("5.00");
  });

  it("entartete Strecke (a===b) erzeugt keine Primitive", () => {
    const d: Drawing2D = {
      id: "dim3",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "dimension", pts: [{ x: 2, y: 2 }, { x: 2, y: 2 }], offset: 1 },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.length).toBe(0);
  });
});

describe("addDrawing2D — kote (SIA 400 B.5.4)", () => {
  it("OK fertig: hohles Dreieck (Spitze nach unten) + formatierte Zahl mit +", () => {
    const d: Drawing2D = {
      id: "k1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "kote", at: { x: 0, y: 0 }, value: 3.25, kind: "okFertig", rotation: 0 },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    const poly = out.find((p) => p.kind === "polygon");
    const text = out.find((p) => p.kind === "drawingText");
    expect(poly).toBeDefined();
    expect(text).toBeDefined();
    if (poly?.kind === "polygon") {
      expect(poly.fill).toBe("none"); // fertig = hohl
      expect(poly.pts[0]).toEqual({ x: 0, y: 0 }); // Spitze = at
      expect(poly.pts[1].y).toBeGreaterThan(0); // OK: Basis oberhalb der Spitze
    }
    if (text?.kind === "drawingText") expect(text.text).toBe("+3.25");
  });

  it("UK roh: gefülltes Dreieck (Spitze nach oben), Basis unterhalb", () => {
    const d: Drawing2D = {
      id: "k2",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "kote", at: { x: 0, y: 0 }, value: -0.1, kind: "ukRoh", rotation: 0 },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    const poly = out.find((p) => p.kind === "polygon");
    const text = out.find((p) => p.kind === "drawingText");
    if (poly?.kind === "polygon") {
      expect(poly.fill).not.toBe("none"); // roh = gefüllt
      expect(poly.pts[1].y).toBeLessThan(0); // UK: Basis unterhalb der Spitze
    }
    if (text?.kind === "drawingText") expect(text.text).toBe("-0.10");
  });

  it("Wert 0 wird als ±0.00 formatiert", () => {
    const d: Drawing2D = {
      id: "k3",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "kote", at: { x: 0, y: 0 }, value: 0, kind: "okFertig", rotation: 0 },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    const text = out.find((p) => p.kind === "drawingText");
    if (text?.kind === "drawingText") expect(text.text).toBe("±0.00");
  });
});

describe("addDrawing2D — xline (Konstruktionslinie)", () => {
  it("verlängert weit über a/b hinaus, in beide Richtungen entlang a→b", () => {
    const d: Drawing2D = {
      id: "x1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "xline", a: { x: 0, y: 0 }, b: { x: 4, y: 0 } },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.length).toBe(1);
    const l = out[0];
    if (l.kind === "line") {
      expect(l.a.x).toBeLessThan(-500);
      expect(l.b.x).toBeGreaterThan(500);
      expect(l.a.y).toBeCloseTo(0, 6);
      expect(l.b.y).toBeCloseTo(0, 6);
      expect(l.dash).not.toBeNull();
      expect(l.drawingId).toBe("x1");
    } else {
      throw new Error("expected a line primitive");
    }
  });

  it("entartet (a===b) erzeugt kein Primitiv", () => {
    const d: Drawing2D = {
      id: "x2",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "xline", a: { x: 2, y: 2 }, b: { x: 2, y: 2 } },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.length).toBe(0);
  });
});

describe("addDrawing2D — ray (Strahl)", () => {
  it("verlängert NUR über b hinaus — a bleibt der feste Anker", () => {
    const d: Drawing2D = {
      id: "r1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "ray", a: { x: 0, y: 0 }, b: { x: 4, y: 0 } },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.length).toBe(1);
    const l = out[0];
    if (l.kind === "line") {
      // a bleibt EXAKT der Anker (keine Verlängerung rückwärts).
      expect(l.a).toEqual({ x: 0, y: 0 });
      // b wird weit über den Richtungspunkt hinaus verlängert.
      expect(l.b.x).toBeGreaterThan(500);
      expect(l.b.y).toBeCloseTo(0, 6);
      expect(l.dash).not.toBeNull();
      expect(l.drawingId).toBe("r1");
    } else {
      throw new Error("expected a line primitive");
    }
  });

  it("entartet (a===b) erzeugt kein Primitiv", () => {
    const d: Drawing2D = {
      id: "r2",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "ray", a: { x: 2, y: 2 }, b: { x: 2, y: 2 } },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.length).toBe(0);
  });
});

describe("addDrawing2D — polyline mit bulge (Bogen-Segmente)", () => {
  it("ohne bulge: unverändertes Verhalten (gerade Segmente, ein Primitiv je Segment)", () => {
    const d: Drawing2D = {
      id: "pl1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }], closed: false },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    const lines = out.filter((p) => p.kind === "line");
    expect(lines.length).toBe(2);
  });

  it("mit bulge an einem Segment: ECHTER Bogen (drawingArc) statt Geradenstücken", () => {
    const d: Drawing2D = {
      id: "pl2",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "polyline",
        pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }],
        closed: false,
        bulge: [1, 0],
      },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);

    // Segment 0 (Halbkreis, bulge=1) → EIN Bogen-Primitiv; Segment 1 (gerade)
    // → EINE Linie. Früher war der Bogen in ~15 Geradenstücke tesselliert,
    // wodurch er im DXF als Kette von LINEs landete statt als ARC.
    const arcs = out.filter((p) => p.kind === "drawingArc");
    const lines = out.filter((p) => p.kind === "line");
    expect(arcs.length).toBe(1);
    expect(lines.length).toBe(1);

    // Halbkreis über der Sehne (0,0)→(2,0): Mittelpunkt (1,0), Radius 1.
    const arc = arcs[0];
    if (arc.kind === "drawingArc") {
      expect(arc.center.x).toBeCloseTo(1, 9);
      expect(arc.center.y).toBeCloseTo(0, 9);
      expect(arc.r).toBeCloseTo(1, 9);
      expect(arc.drawingId).toBe("pl2");
      // Die Winkel beschreiben exakt die Endpunkte des Segments (in der
      // CCW-Konvention von `drawingArc` ggf. vertauscht).
      const p0 = { x: arc.center.x + arc.r * Math.cos(arc.a0), y: arc.center.y + arc.r * Math.sin(arc.a0) };
      const p1 = { x: arc.center.x + arc.r * Math.cos(arc.a1), y: arc.center.y + arc.r * Math.sin(arc.a1) };
      const ends = [p0, p1].sort((u, v) => u.x - v.x);
      expect(ends[0].x).toBeCloseTo(0, 9);
      expect(ends[0].y).toBeCloseTo(0, 9);
      expect(ends[1].x).toBeCloseTo(2, 9);
      expect(ends[1].y).toBeCloseTo(0, 9);
    }

    // Das gerade Segment bleibt unverändert eine Linie mit den echten Endpunkten.
    if (lines[0].kind === "line") {
      expect(lines[0].a).toEqual({ x: 2, y: 0 });
      expect(lines[0].b).toEqual({ x: 4, y: 0 });
    }
  });

  it("geschlossene Bogen-Polylinie füllt eine korrekte (tessellierte) Fläche", () => {
    const d: Drawing2D = {
      id: "pl3",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "polyline",
        pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
        closed: true,
        bulge: [0, 0, 0.5, 0],
      },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    const poly = out.find((p) => p.kind === "polygon");
    expect(poly).toBeDefined();
    if (poly?.kind === "polygon") {
      // Mehr Punkte als die 4 Ecken, weil eine Seite tessellierter Bogen ist.
      expect(poly.pts.length).toBeGreaterThan(4);
    }
  });
});

describe("addDrawing2D — text mit pathPts (Text-entlang-Pfad)", () => {
  it("gibt ein drawingTextPath-Primitiv statt drawingText aus, wenn pathPts ≥2 gesetzt ist", () => {
    const d: Drawing2D = {
      id: "tp1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "text",
        at: { x: 0, y: 0 },
        text: "Bachlauf",
        height: 0.3,
        angle: 0,
        pathPts: [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 0 }],
      },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.length).toBe(1);
    const p = out[0];
    expect(p.kind).toBe("drawingTextPath");
    if (p.kind === "drawingTextPath") {
      expect(p.text).toBe("Bachlauf");
      expect(p.pathPts.length).toBe(3);
      expect(p.drawingId).toBe("tp1");
    }
  });

  it("ohne pathPts (normaler Text) bleibt es beim bestehenden drawingText-Primitiv", () => {
    const d: Drawing2D = {
      id: "t1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "text", at: { x: 0, y: 0 }, text: "Normal", height: 0.3, angle: 0 },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("drawingText");
  });
});

describe("addDrawing2D — block (Symbol-Instanz)", () => {
  it("expandiert die BlockDef-Geometrie rotiert+verschoben um at/rotation", () => {
    const proj = project();
    proj.blockDefs = [
      { id: "blk1", name: "Stuhl", geom2d: [{ shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }] },
    ];
    const d: Drawing2D = {
      id: "i1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "block", blockDefId: "blk1", at: { x: 5, y: 5 }, rotation: Math.PI / 2 },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, proj, d, false, lwByCode, colorByCode, catByCode);
    expect(out.length).toBe(1);
    const l = out[0];
    if (l.kind === "line") {
      // Lokal (0,0)→(1,0), um 90° gedreht → (0,0)→(0,1), verschoben um (5,5).
      expect(l.a.x).toBeCloseTo(5, 6);
      expect(l.a.y).toBeCloseTo(5, 6);
      expect(l.b.x).toBeCloseTo(5, 6);
      expect(l.b.y).toBeCloseTo(6, 6);
      expect(l.drawingId).toBe("i1");
    } else {
      throw new Error("expected a line primitive");
    }
  });

  it("scale zieht sowohl Position ALS AUCH Grössenfelder mit (REGRESSION: circle.r skalierte nicht mit)", () => {
    const proj = project();
    proj.blockDefs = [
      { id: "blk1", name: "Kreis-Symbol", geom2d: [{ shape: "circle", center: { x: 1, y: 0 }, r: 1 }] },
    ];
    const d: Drawing2D = {
      id: "i1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "block", blockDefId: "blk1", at: { x: 10, y: 10 }, rotation: 0, scale: 2 },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, proj, d, false, lwByCode, colorByCode, catByCode);
    expect(out.length).toBe(1);
    const c = out[0];
    if (c.kind === "drawingCircle") {
      // Lokal (1,0) r=1, skaliert ×2 → (2,0), r=2, verschoben um (10,10).
      expect(c.center.x).toBeCloseTo(12, 6);
      expect(c.center.y).toBeCloseTo(10, 6);
      expect(c.r).toBeCloseTo(2, 6);
    } else {
      throw new Error("expected a drawingCircle primitive");
    }
  });

  it("fehlendes scale-Feld verhält sich wie scale=1 (unverändert)", () => {
    const proj = project();
    proj.blockDefs = [
      { id: "blk1", name: "Kreis-Symbol", geom2d: [{ shape: "circle", center: { x: 0, y: 0 }, r: 1 }] },
    ];
    const d: Drawing2D = {
      id: "i1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "block", blockDefId: "blk1", at: { x: 0, y: 0 }, rotation: 0 },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, proj, d, false, lwByCode, colorByCode, catByCode);
    const c = out[0];
    if (c.kind === "drawingCircle") expect(c.r).toBeCloseTo(1, 6);
    else throw new Error("expected a drawingCircle primitive");
  });

  it("unbekannte blockDefId rendert nichts (kein Crash)", () => {
    const d: Drawing2D = {
      id: "i2",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "block", blockDefId: "ghost", at: { x: 0, y: 0 }, rotation: 0 },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.length).toBe(0);
  });
});

describe("addDrawing2D — Bemassung: Strichstärken je Bestandteil", () => {
  const dim = (extra: Record<string, unknown> = {}): Drawing2D => ({
    id: "dim1",
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: { shape: "dimension", pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }], offset: 1, ...extra },
  });

  /** Alle Linien-Primitive der Bemassung nach Strichstärke gruppiert. */
  const weights = (d: Drawing2D) => {
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    return out.filter((p) => p.kind === "line").map((p) => (p.kind === "line" ? p.weightMm : 0));
  };

  it("Default unverändert: Mass-/Hilfslinien erben die Elementstärke, Massstriche doppelt", () => {
    const w = weights(dim());
    const base = Math.min(...w);
    // 2 Hilfslinien + 1 Masslinie mit Basisstärke, 2 Massstriche doppelt.
    expect(w.filter((x) => x === base).length).toBe(3);
    expect(w.filter((x) => Math.abs(x - base * 2) < 1e-9).length).toBe(2);
  });

  it("jede der drei Stärken ist einzeln übersteuerbar", () => {
    const w = weights(dim({ lineWeightMm: 0.5, extWeightMm: 0.13, tickWeightMm: 0.7 }));
    expect(w.filter((x) => x === 0.13).length).toBe(2); // Hilfslinien
    expect(w.filter((x) => x === 0.5).length).toBe(1); // Masslinie
    expect(w.filter((x) => x === 0.7).length).toBe(2); // Massstriche
  });

  it("Teil-Übersteuerung lässt die übrigen auf ihrem Default", () => {
    const w = weights(dim({ tickWeightMm: 0.9 }));
    const base = Math.min(...w);
    expect(w.filter((x) => x === base).length).toBe(3);
    expect(w.filter((x) => x === 0.9).length).toBe(2);
  });
});

describe("addDrawing2D — Bemassung: Papier-mm statt Modellmass", () => {
  const dim: Drawing2D = {
    id: "dimS",
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: {
      shape: "dimension",
      pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }],
      offset: 1,
      tickLenMm: 4,
    },
  };

  /** Länge des ersten Massstrichs (Diagonale) im erzeugten Plan. */
  const tickLength = (scale: number) => {
    const out: Primitive[] = [];
    addDrawing2D(out, project(), dim, false, lwByCode, colorByCode, catByCode, scale);
    // Massstriche sind die kürzesten Linien (Diagonalen an den Enden).
    const lens = out
      .filter((p) => p.kind === "line")
      .map((p) => (p.kind === "line" ? Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) : 0));
    return Math.min(...lens);
  };

  it("derselbe Papierwert ergibt bei grösserem Massstab ein grösseres Modellmass", () => {
    // 4 mm Papier: 1:50 → 0.2 m, 1:100 → 0.4 m im Modell.
    expect(tickLength(50)).toBeCloseTo(0.2, 9);
    expect(tickLength(100)).toBeCloseTo(0.4, 9);
  });

  it("das Verhältnis folgt exakt dem Massstabsverhältnis (gleiche Wirkung auf dem Papier)", () => {
    expect(tickLength(200) / tickLength(50)).toBeCloseTo(4, 9);
  });

  it("ohne gesetzten Wert gilt der Default — ebenfalls massstabsabhängig", () => {
    const plain: Drawing2D = { ...dim, geom: { ...dim.geom, tickLenMm: undefined } as typeof dim.geom };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), plain, false, lwByCode, colorByCode, catByCode, 50);
    const lens = out
      .filter((p) => p.kind === "line")
      .map((p) => (p.kind === "line" ? Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) : 0));
    // Default 3 mm bei 1:50 = 0.15 m (der frühere feste Modellwert).
    expect(Math.min(...lens)).toBeCloseTo(0.15, 9);
  });
});

describe("addDrawing2D — Linienenden (Pfeilspitzen & Co.)", () => {
  const line = (endMarks?: Drawing2D["endMarks"]): Drawing2D => ({
    id: "em1",
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 4, y: 0 } },
    endMarks,
  });
  const render = (d: Drawing2D, scale = 50) => {
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode, scale);
    return out;
  };

  it("ohne Angabe bleibt alles wie bisher: nur die Linie, keine Zusatzgeometrie", () => {
    const out = render(line());
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("line");
  });

  it("gefüllter Pfeil erzeugt ein Dreieck UND verkürzt die Linie dort", () => {
    const out = render(line({ end: "arrow", sizeMm: 4 }));
    const polys = out.filter((p) => p.kind === "polygon");
    expect(polys.length).toBe(1);
    if (polys[0].kind === "polygon") expect(polys[0].pts.length).toBe(3);
    // 4 mm bei 1:50 = 0.2 m Rückzug → Linie endet bei x = 3.8.
    const ln = out.find((p) => p.kind === "line");
    if (ln?.kind === "line") expect(ln.b.x).toBeCloseTo(3.8, 9);
  });

  it("offene Spitze zeichnet zwei Striche und lässt die Linie durchlaufen", () => {
    const out = render(line({ end: "arrowOpen" }));
    const lines = out.filter((p) => p.kind === "line");
    expect(lines.length).toBe(3); // Linie + zwei Schenkel
    const main = lines[0];
    if (main.kind === "line") expect(main.b.x).toBeCloseTo(4, 9);
  });

  it("Punkt-Ende erzeugt einen Kreis, Quadrat-Ende ein Viereck", () => {
    expect(render(line({ start: "dot" })).some((p) => p.kind === "drawingCircle")).toBe(true);
    const sq = render(line({ end: "square" })).find((p) => p.kind === "polygon");
    if (sq?.kind === "polygon") expect(sq.pts.length).toBe(4);
  });

  it("beide Enden gleichzeitig, und die Grösse folgt dem Massstab (Papier-mm)", () => {
    const at50 = render(line({ start: "arrow", end: "arrow", sizeMm: 4 }), 50);
    const at100 = render(line({ start: "arrow", end: "arrow", sizeMm: 4 }), 100);
    expect(at50.filter((p) => p.kind === "polygon").length).toBe(2);
    const seg50 = at50.find((p) => p.kind === "line");
    const seg100 = at100.find((p) => p.kind === "line");
    // Rückzug 0.2 m bei 1:50, 0.4 m bei 1:100 — an BEIDEN Enden.
    if (seg50?.kind === "line" && seg100?.kind === "line") {
      expect(seg50.a.x).toBeCloseTo(0.2, 9);
      expect(seg100.a.x).toBeCloseTo(0.4, 9);
    }
  });

  it("geschlossene Formen ignorieren Linienenden (sie haben keine)", () => {
    const ring: Drawing2D = {
      id: "em2",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "polyline",
        pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }],
        closed: true,
      },
      endMarks: { start: "arrow", end: "arrow" },
    };
    expect(render(ring).some((p) => p.kind === "polygon" && p.pts.length === 3 && p.fill !== "none")).toBe(
      false,
    );
  });

  it("an einem Bogen-Segment folgt die Spitze der BOGEN-Tangente, nicht der Sehne", () => {
    const d: Drawing2D = {
      id: "em3",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "polyline",
        pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }],
        closed: false,
        bulge: [1], // Halbkreis
      },
      endMarks: { end: "arrow", sizeMm: 4 },
    };
    const poly = render(d).find((p) => p.kind === "polygon");
    expect(poly).toBeDefined();
    if (poly?.kind === "polygon") {
      // Halbkreis über (0,0)→(2,0): im Endpunkt (2,0) steht die Tangente
      // SENKRECHT zur Sehne. Die Spitze sitzt auf (2,0), ihr Fusspunkt liegt
      // daher senkrecht darüber/darunter — nicht seitlich.
      const tip = poly.pts[0];
      expect(tip.x).toBeCloseTo(2, 9);
      expect(tip.y).toBeCloseTo(0, 9);
      const baseMid = {
        x: (poly.pts[1].x + poly.pts[2].x) / 2,
        y: (poly.pts[1].y + poly.pts[2].y) / 2,
      };
      expect(Math.abs(baseMid.x - tip.x)).toBeLessThan(1e-6);
      expect(Math.abs(baseMid.y - tip.y)).toBeGreaterThan(0.1);
    }
  });
});

describe("addDrawing2D — Objekt-Transparenz", () => {
  const poly = (opacity?: number): Drawing2D => ({
    id: "op1",
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: {
      shape: "polyline",
      pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }],
      closed: true,
    },
    // Füllung über die Vollton-Füllfarbe (die Fixture führt keine Schraffuren).
    fillColor: "#cccccc",
    opacity,
  });
  const render = (d: Drawing2D) => {
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode, 50);
    return out;
  };

  it("ohne Angabe tragen die Primitive keine Deckkraft (unverändertes Verhalten)", () => {
    expect(render(poly()).every((p) => p.opacity === undefined)).toBe(true);
  });

  it("wird auf ALLE Primitive des Elements gestempelt — Striche wie Füllung", () => {
    const out = render(poly(0.5));
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((p) => p.opacity === 0.5)).toBe(true);
    // Es sind wirklich beide Sorten dabei (sonst wäre der Test wertlos).
    expect(out.some((p) => p.kind === "line")).toBe(true);
    expect(out.some((p) => p.kind === "polygon")).toBe(true);
  });

  it("Deckkraft 1 stempelt nichts (kein unnötiges Feld im Plan)", () => {
    expect(render(poly(1)).every((p) => p.opacity === undefined)).toBe(true);
  });

  it("negative Werte werden auf 0 geklemmt", () => {
    expect(render(poly(-3)).every((p) => p.opacity === 0)).toBe(true);
  });
});

describe("addDrawing2D — Strichmuster-Massstab (LTSCALE je Objekt)", () => {
  const dashed = (dashScale?: number): Drawing2D => ({
    id: "ds1",
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 4, y: 0 } },
    lineStyleId: "dash",
    dashScale,
  });
  const dashOf = (d: Drawing2D) => {
    const out: Primitive[] = [];
    const p = { ...project(), lineStyles: [{ id: "dash", name: "Strich", weight: 0.2, color: "#000", dash: [2, 1] }] };
    addDrawing2D(out, p, d, false, lwByCode, colorByCode, catByCode, 50);
    const ln = out.find((x) => x.kind === "line");
    return ln?.kind === "line" ? ln.dash : undefined;
  };

  it("ohne Angabe bleibt das Muster exakt wie im Linienstil", () => {
    expect(dashOf(dashed())).toEqual([2, 1]);
  });

  it("streckt Striche UND Lücken um denselben Faktor", () => {
    expect(dashOf(dashed(2))).toEqual([4, 2]);
    expect(dashOf(dashed(0.5))).toEqual([1, 0.5]);
  });

  it("Faktor 1 lässt das Muster unangetastet (dieselbe Referenz)", () => {
    expect(dashOf(dashed(1))).toEqual([2, 1]);
  });

  it("unsinnige Faktoren (0/negativ) werden ignoriert statt das Muster zu verschlucken", () => {
    expect(dashOf(dashed(0))).toEqual([2, 1]);
    expect(dashOf(dashed(-2))).toEqual([2, 1]);
  });
});
