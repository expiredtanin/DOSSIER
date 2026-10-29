// Objekt-Info der Auswahl ([K4] S3: gerechnet im Kern, `selection_info.rs`) — Wand, Decke,
// Zeichnung, Extrusion (B-Rep-Beschreibung aus TS) und die Meldung bei unbekanntem Wandtyp.
import { describe, expect, it } from "vitest";
import { deriveSelection } from "./selectionInfo";
import { sampleProject } from "../model/sampleProject";
import type { Project, Roof } from "../model/types";

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

  it("Dach: Kantenliste (Umriss, dann Hof), Vorgaben je Kante und Giebel-Standard", () => {
    const p = base();
    const rect = (x: number, y: number, w: number, h: number) => [
      { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
    ];
    const roof = (extra: Partial<Roof>): Roof => ({
      id: "R", type: "roof", floorId: p.drawingLevels.find((z) => z.kind === "floor")!.id, categoryCode: "31",
      outline: rect(0, 0, 12, 8), shape: "walm", pitchDeg: 35, overhang: 0, ridgeAxis: "x", thickness: 0.2, ...extra,
    });
    const edges = (r: Roof) => {
      // Neues Projekt-Objekt je Fall: der Kern gleicht über Referenzen ab.
      return deriveSelection({ ...p, roofs: [r] }, [], null, null, null, null, null, null, null, "R")!.roof!.edges;
    };
    const list = edges(roof({ holes: [rect(4, 2, 4, 4)] }));
    expect(list).toHaveLength(8);
    expect(list.map((e) => e.ring)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(list[0]).toMatchObject({ index: 0, spec: { kind: "default" }, length: 12 });
    expect(list[5].index).toBe(5);
    const specs = edges(roof({ edgePitchDeg: [20, null, -1] }));
    expect(specs.map((e) => e.spec)).toEqual([
      { kind: "pitch", deg: 20 }, { kind: "gable" }, { kind: "default" }, { kind: "default" },
    ]);
    expect(edges(roof({ shape: "sattel" })).map((e) => e.defaultGable)).toEqual([false, true, false, true]);
    expect(edges(roof({})).every((e) => !e.defaultGable)).toBe(true);
  });
});
