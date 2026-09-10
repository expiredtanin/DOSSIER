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
    doors: [],
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

  it("mit bulge an einem Segment: tessellierter Bogen statt einer Geraden", () => {
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
    const lines = out.filter((p) => p.kind === "line");
    // Segment 0 (Halbkreis, bulge=1) tessellierter Bogen → mehrere Teilstücke;
    // Segment 1 bleibt eine einzelne Gerade → insgesamt > 2 (statt 2 wie oben).
    expect(lines.length).toBeGreaterThan(2);
    // Erster und letzter Punkt der gesamten Kette bleiben exakt die echten Endpunkte.
    if (lines[0].kind === "line") {
      expect(lines[0].a).toEqual({ x: 0, y: 0 });
    }
    if (lines[lines.length - 1].kind === "line") {
      expect(lines[lines.length - 1].b).toEqual({ x: 4, y: 0 });
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
