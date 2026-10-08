/** „Eigenschaften übertragen" für 2D-Elemente. */

import { describe, expect, it } from "vitest";
import { applyDrawingStyle, readDrawingStyle } from "./matchProps";
import { sampleProject } from "../model/sampleProject";
import type { Drawing2D, Project } from "../model/types";

function proj(...ds: Partial<Drawing2D>[]): Project {
  return {
    ...sampleProject,
    drawings2d: ds.map((d, i) => ({
      id: `d${i}`,
      type: "drawing2d",
      levelId: sampleProject.drawingLevels[0].id,
      categoryCode: sampleProject.layers[0].code,
      geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
      ...d,
    })) as Drawing2D[],
  };
}
const at = (p: Project, i: number) => p.drawings2d[i];

describe("readDrawingStyle", () => {
  it("liest nur gesetzte Stil-Felder", () => {
    const p = proj({ color: "#ff0000", weightMm: 0.5 });
    expect(readDrawingStyle(at(p, 0))).toEqual({ color: "#ff0000", weightMm: 0.5 });
  });

  it("nimmt Identität, Form und EBENE bewusst NICHT mit", () => {
    const p = proj({ color: "#00ff00" });
    const style = readDrawingStyle(at(p, 0)) as Record<string, unknown>;
    for (const k of ["id", "type", "geom", "levelId", "categoryCode"]) {
      expect(style[k]).toBeUndefined();
    }
  });
});

describe("applyDrawingStyle", () => {
  it("überträgt das Aussehen auf die Ziele", () => {
    const p = proj({ color: "#ff0000", weightMm: 0.7, dashScale: 2 }, {}, {});
    const out = applyDrawingStyle(p, ["d1", "d2"], readDrawingStyle(at(p, 0)));
    for (const i of [1, 2]) {
      expect(at(out, i).color).toBe("#ff0000");
      expect(at(out, i).weightMm).toBe(0.7);
      expect(at(out, i).dashScale).toBe(2);
    }
  });

  it("Form, Ebene und Identität des Ziels bleiben unangetastet", () => {
    const p = proj(
      { color: "#ff0000" },
      { geom: { shape: "circle", center: { x: 5, y: 5 }, r: 3 }, categoryCode: "99" },
    );
    const out = applyDrawingStyle(p, ["d1"], readDrawingStyle(at(p, 0)));
    expect(at(out, 1).id).toBe("d1");
    expect(at(out, 1).geom).toEqual({ shape: "circle", center: { x: 5, y: 5 }, r: 3 });
    expect(at(out, 1).categoryCode).toBe("99");
  });

  it("ENTFERNT am Ziel, was die Quelle nicht hat — sonst sähe es anders aus als das Vorbild", () => {
    const p = proj({ color: "#ff0000" }, { color: "#0000ff", hatchId: "solid", opacity: 0.4 });
    const out = applyDrawingStyle(p, ["d1"], readDrawingStyle(at(p, 0)));
    expect(at(out, 1).color).toBe("#ff0000");
    expect(at(out, 1).hatchId).toBeUndefined();
    expect(at(out, 1).opacity).toBeUndefined();
  });

  it("überträgt auch die By-Layer/By-Object-Quellen (sonst löste sich das Aussehen anders auf)", () => {
    const p = proj({ foregroundSource: "layer", hatchSource: "layer" }, {});
    const out = applyDrawingStyle(p, ["d1"], readDrawingStyle(at(p, 0)));
    expect(at(out, 1).foregroundSource).toBe("layer");
    expect(at(out, 1).hatchSource).toBe("layer");
  });

  it("der Schraffur-URSPRUNG wird nicht mitgenommen (Ortsbezug, kein Aussehen)", () => {
    const p = proj({ hatchId: "h", hatchOrigin: { x: 9, y: 9 } }, {});
    const out = applyDrawingStyle(p, ["d1"], readDrawingStyle(at(p, 0)));
    expect(at(out, 1).hatchId).toBe("h");
    expect(at(out, 1).hatchOrigin).toBeUndefined();
  });

  it("leere Zielliste lässt das Projekt unverändert", () => {
    const p = proj({ color: "#ff0000" });
    expect(applyDrawingStyle(p, [], readDrawingStyle(at(p, 0)))).toBe(p);
  });
});
