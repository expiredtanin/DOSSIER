// Objekt-Info der Auswahl ([K4] S3: gerechnet im Kern, `selection_info.rs`) — Wand, Decke,
// Zeichnung, Extrusion (B-Rep-Beschreibung aus TS) und die Meldung bei unbekanntem Wandtyp.
import { describe, expect, it } from "vitest";
import { deriveSelection } from "./selectionInfo";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";

const base = (): Project => structuredClone(sampleProject);

describe("deriveSelection (Kern)", () => {
  it("Wand: Typ-Liste, Geschosse, Länge, Volumen und UK/OK", () => {
    const p = base();
    const w = p.walls[0];
    const sel = deriveSelection(p, [w.id], null)!;
    expect(sel.kind).toBe("wall");
    expect(sel.id).toBe(w.id);
    expect(sel.wall!.wallTypes.length).toBe(p.wallTypes.length);
    expect(sel.wall!.floors.every((f) => p.drawingLevels.some((z) => z.id === f.id && z.kind === "floor"))).toBe(true);
    expect(sel.wall!.length).toBeCloseTo(Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y), 12);
    expect(sel.wall!.netVolume).toBeLessThanOrEqual(sel.wall!.grossVolume);
    expect(sel.wall!.zTop).toBeGreaterThan(sel.wall!.zBottom);
    expect(sel.bbox.minX).toBe(Math.min(w.start.x, w.end.x));
  });

  it("unbekannter Wandtyp bricht mit derselben Meldung ab wie bisher", () => {
    const p = base();
    p.walls[0] = { ...p.walls[0], wallTypeId: "fehlt" };
    expect(() => deriveSelection(p, [p.walls[0].id], null)).toThrow("Unbekannter Wandtyp: fehlt");
  });

  it("Zeichnung: offene Linie ohne Füllung, Rechteck mit Ebenen-Vorgaben", () => {
    const p = base();
    const lvl = p.drawingLevels[0].id;
    const code = p.layers[0].code;
    p.drawings2d = [
      { id: "l", type: "drawing2d", levelId: lvl, categoryCode: code, geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 3, y: -2 } } },
      { id: "r", type: "drawing2d", levelId: lvl, categoryCode: code, hatchId: "h", geom: { shape: "rect", min: { x: 1, y: 1 }, max: { x: 2, y: 4 } } },
    ];
    const l = deriveSelection(p, [], "l")!;
    expect(l.closed).toBe(false);
    expect(l.effectiveHatchId).toBeNull();
    expect(l.bbox).toEqual({ minX: 0, minY: -2, maxX: 3, maxY: 0 });
    const r = deriveSelection(p, [], "r")!;
    expect(r.closed).toBe(true);
    expect(r.fillHatchId).toBe("h");
    expect(r.effectiveHatchId).toBe("h");
    expect(deriveSelection(p, [], "nix")).toBeNull();
  });

  it("Extrusion: Fläche im Kern, B-Rep-Beschreibung (truck) aus TS", () => {
    const p = base();
    const lvl = p.drawingLevels[0].id;
    p.extrudedSolids = [
      { id: "x", type: "extrudedSolid", levelId: lvl, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 3 }], height: 2 },
    ];
    const sel = deriveSelection(p, [], null, null, null, null, null, "x")!;
    expect(sel.extrudedSolid!.area).toBeCloseTo(3, 12);
    expect(sel.extrudedSolid!.spec).toMatchObject({ kind: "extrude", height: 2 });
    expect(Object.keys(sel.extrudedSolid!)).toEqual([
      "height", "taper", "cornerRadius", "chamfer", "area", "spec", "subtract", "canSubtract", "baseOffset", "floorId", "floorName",
    ]);
  });
});
