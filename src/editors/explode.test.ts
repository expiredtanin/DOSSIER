/**
 * Auflösen (Explode). Kernpunkte: ein BOGEN-Segment einer Polylinie darf beim
 * Zerlegen nicht zur Sehne zusammenfallen, Stil-Eigenschaften bleiben erhalten,
 * und nicht zerlegbare Formen verschwinden nicht.
 */

import { describe, expect, it } from "vitest";
import { explodeDrawings, explodeGeom } from "./explode";
import { sampleProject } from "../model/sampleProject";
import { bulgeArc } from "../geometry/bulge";
import type { Drawing2D, Drawing2DGeom, Project } from "../model/types";

function withDrawing(geom: Drawing2DGeom, extra: Partial<Drawing2D> = {}): Project {
  return {
    ...sampleProject,
    drawings2d: [
      {
        id: "d1",
        type: "drawing2d",
        levelId: sampleProject.drawingLevels[0].id,
        categoryCode: sampleProject.layers[0].code,
        geom,
        ...extra,
      },
    ],
  };
}

describe("explodeGeom — Polylinie", () => {
  it("offene Polylinie → eine Linie je Segment", () => {
    const parts = explodeGeom(
      { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 3 }], closed: false },
      sampleProject,
    );
    expect(parts).toHaveLength(2);
    expect(parts!.every((g) => g.shape === "line")).toBe(true);
  });

  it("geschlossene Polylinie hat ein Segment MEHR (der Schluss zurück zum Start)", () => {
    const parts = explodeGeom(
      { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 3 }], closed: true },
      sampleProject,
    );
    expect(parts).toHaveLength(3);
  });

  it("Bogen-Segment wird zu einem ECHTEN Bogen, nicht zur Sehne", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 4, y: 0 };
    const orig = bulgeArc(a, b, 0.6)!;
    const parts = explodeGeom(
      { shape: "polyline", pts: [a, b], closed: false, bulge: [0.6] },
      sampleProject,
    )!;
    expect(parts).toHaveLength(1);
    const g = parts[0];
    expect(g.shape).toBe("arc");
    if (g.shape !== "arc") throw new Error();
    // Derselbe Kreis wie das Bogen-Segment vorher.
    expect(g.center.x).toBeCloseTo(orig.center.x, 9);
    expect(g.center.y).toBeCloseTo(orig.center.y, 9);
    expect(g.r).toBeCloseTo(orig.r, 9);
    // Die Endpunkte des Bogens sind weiterhin a und b.
    const at = (ang: number) => ({ x: g.center.x + g.r * Math.cos(ang), y: g.center.y + g.r * Math.sin(ang) });
    const ends = [at(g.a0), at(g.a1)];
    const near = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot(p.x - q.x, p.y - q.y) < 1e-9;
    expect(ends.some((p) => near(p, a))).toBe(true);
    expect(ends.some((p) => near(p, b))).toBe(true);
  });
});

describe("explodeGeom — Rechteck und Block", () => {
  it("Rechteck → vier Linien, die den Umriss schliessen", () => {
    const parts = explodeGeom(
      { shape: "rect", min: { x: 0, y: 0 }, max: { x: 2, y: 1 } },
      sampleProject,
    )!;
    expect(parts).toHaveLength(4);
    // Ende jeder Linie ist Anfang der nächsten (geschlossener Ring).
    for (let i = 0; i < 4; i++) {
      const cur = parts[i];
      const nxt = parts[(i + 1) % 4];
      if (cur.shape !== "line" || nxt.shape !== "line") throw new Error();
      expect(cur.b).toEqual(nxt.a);
    }
  });

  it("Block → Teilgeometrien mit Drehung und Einfügepunkt verrechnet", () => {
    const project: Project = {
      ...sampleProject,
      blockDefs: [
        { id: "b1", name: "Test", geom2d: [{ shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }] },
      ],
    };
    // 90° gedreht, um (5,5) eingefügt: (1,0) → (5,6).
    const parts = explodeGeom(
      { shape: "block", blockDefId: "b1", at: { x: 5, y: 5 }, rotation: Math.PI / 2 },
      project,
    )!;
    expect(parts).toHaveLength(1);
    const g = parts[0];
    if (g.shape !== "line") throw new Error();
    expect(g.a.x).toBeCloseTo(5, 9);
    expect(g.a.y).toBeCloseTo(5, 9);
    expect(g.b.x).toBeCloseTo(5, 9);
    expect(g.b.y).toBeCloseTo(6, 9);
  });

  it("unbekannte Block-Definition wird nicht zerlegt (nichts geht verloren)", () => {
    expect(
      explodeGeom({ shape: "block", blockDefId: "weg", at: { x: 0, y: 0 }, rotation: 0 }, sampleProject),
    ).toBeNull();
  });
});

describe("explodeGeom — was NICHT zerlegt wird", () => {
  it.each(["circle", "ellipse", "spline", "text"] as const)("%s bleibt unverändert", (shape) => {
    const geoms: Record<string, Drawing2DGeom> = {
      circle: { shape: "circle", center: { x: 0, y: 0 }, r: 1 },
      ellipse: { shape: "ellipse", center: { x: 0, y: 0 }, rx: 2, ry: 1, rotation: 0 },
      spline: { shape: "spline", pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: false },
      text: { shape: "text", at: { x: 0, y: 0 }, text: "A", height: 0.2, angle: 0 },
    };
    expect(explodeGeom(geoms[shape], sampleProject)).toBeNull();
  });
});

describe("explodeDrawings", () => {
  it("ersetzt das Original durch seine Teile und behält die Stil-Eigenschaften", () => {
    const p = withDrawing(
      { shape: "rect", min: { x: 0, y: 0 }, max: { x: 2, y: 1 } },
      { color: "#ff0000", weightMm: 0.7, dashScale: 2 },
    );
    const out = explodeDrawings(p, ["d1"]);
    expect(out.drawings2d).toHaveLength(4);
    expect(out.drawings2d.every((d) => d.color === "#ff0000" && d.weightMm === 0.7)).toBe(true);
    expect(out.drawings2d.every((d) => d.dashScale === 2)).toBe(true);
    // Neue Identitäten, keine doppelten IDs.
    expect(new Set(out.drawings2d.map((d) => d.id)).size).toBe(4);
    expect(out.drawings2d.some((d) => d.id === "d1")).toBe(false);
  });

  it("lässt nicht zerlegbare Elemente unangetastet (kein stiller Verlust)", () => {
    const p = withDrawing({ shape: "circle", center: { x: 0, y: 0 }, r: 1 });
    expect(explodeDrawings(p, ["d1"])).toBe(p);
  });

  it("rührt nicht gewählte Elemente nicht an", () => {
    const p = withDrawing({ shape: "rect", min: { x: 0, y: 0 }, max: { x: 1, y: 1 } });
    expect(explodeDrawings(p, ["andere"])).toBe(p);
  });
});
