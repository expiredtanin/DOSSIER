/**
 * Objektbibliothek 2D ([253]): Katalog aus dem Kern, Platzieren (Befehl `libobj`: Klasse wird im selben Schritt
 * angelegt, Drehen/Spiegeln), Plan-Ausgabe nach Detailgrad, unbekannte Objekt-Id, Möbel sparen den Belag aus.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { libobjCommand, setActiveLibObject, resetLibObjectPlacement } from "./libobj";
import { libCatalog, libDefaultParams, libGeometry, libGroups, libObjectDef } from "../../model/furnitureLib";
import { drawingPrimitives } from "../../plan/generatePlan";
import type { CommandContext, Project } from "../types";
import type { Drawing2D } from "../../model/types";

function project(layers: Project["layers"] = []): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 }],
    layers,
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

function makeCtx(p: Project): CommandContext {
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: null },
  };
}

const LAYER_MOEBEL = { code: "22", name: "Möbel", color: "#4a4a4a", lw: 0.13, visible: true, locked: false };

function place(p: Project, libId: string, at = { x: 3, y: 4 }) {
  setActiveLibObject(libId, libDefaultParams(libObjectDef(libId)!));
  const [, r] = libobjCommand.onInput(libobjCommand.init(), { kind: "point", point: at }, makeCtx(p));
  expect(r.commit).toBeDefined();
  return r.commit!(p);
}

beforeEach(() => resetLibObjectPlacement());

describe("Katalog", () => {
  it("enthält alle Gruppen und Objekte aus dem Kern", () => {
    const c = libCatalog();
    expect(c.objects.length).toBeGreaterThanOrEqual(48);
    expect(libGroups()).toEqual(["sanitary", "kitchen", "tables", "seating", "sleeping", "cupboards", "outdoor"]);
    for (const o of c.objects) expect(libGeometry(o.id, libDefaultParams(o), "mittel").length).toBeGreaterThan(0);
  });

  it("Parameter sind allgemein beschrieben (Art, Vorgabe, Grenzen)", () => {
    const wc = libObjectDef("lib:wc-wand")!;
    expect(wc.params.find((p) => p.key === "w")).toMatchObject({ kind: "length", default: 0.38 });
    expect(libObjectDef("lib:tisch-80x140")!.seeded).toBe(true);
  });
});

describe("Befehl libobj", () => {
  it("setzt ein WC auf Sanitär und legt die Klasse im selben Schritt an", () => {
    const p = project([LAYER_MOEBEL]);
    const next = place(p, "lib:wc-wand");
    expect(next.drawings2d).toHaveLength(1);
    const d = next.drawings2d[0];
    expect(d.categoryCode).toBe("23");
    expect(next.layers.some((l) => l.code === "23" && l.name === "Sanitär")).toBe(true);
    expect(d.geom.shape).toBe("libobj");
    if (d.geom.shape === "libobj") {
      expect(d.geom.libId).toBe("lib:wc-wand");
      expect(d.geom.at).toEqual({ x: 3, y: 4 });
      expect(d.geom.rotation).toBe(0);
    }
  });

  it("Möbel landen auf „Möbel“; eine vorhandene Klasse wird nicht doppelt angelegt", () => {
    const p = project([LAYER_MOEBEL]);
    const next = place(p, "lib:bett-140");
    expect(next.drawings2d[0].categoryCode).toBe("22");
    expect(next.layers.filter((l) => l.code === "22")).toHaveLength(1);
  });

  it("Drehen (R) und Spiegeln (M) gelten für das nächste Objekt", () => {
    const p = project([LAYER_MOEBEL]);
    setActiveLibObject("lib:sofa-2", libDefaultParams(libObjectDef("lib:sofa-2")!));
    let [s] = libobjCommand.onInput(libobjCommand.init(), { kind: "option", id: "rotate" }, makeCtx(p));
    [s] = libobjCommand.onInput(s, { kind: "option", id: "mirror" }, makeCtx(p));
    const [, r] = libobjCommand.onInput(s, { kind: "point", point: { x: 1, y: 1 } }, makeCtx(p));
    const g = r.commit!(p).drawings2d[0].geom;
    expect(g.shape).toBe("libobj");
    if (g.shape === "libobj") {
      expect(g.rotation).toBeCloseTo(Math.PI / 2, 9);
      expect(g.params?.mirror).toBe(true);
    }
  });

  it("Vorschau hängt am Cursor", () => {
    setActiveLibObject("lib:stuhl", {});
    const [, r] = libobjCommand.onMove!(libobjCommand.init(), { x: 2, y: 2 }, null, makeCtx(project()));
    expect(r.draft?.preview.length).toBeGreaterThan(0);
  });
});

function libDrawing(geom: Extract<Drawing2D["geom"], { shape: "libobj" }>): Drawing2D {
  return { id: "o1", type: "drawing2d", levelId: "eg", categoryCode: "23", geom };
}

describe("Plan-Ausgabe", () => {
  const proj = () => project([LAYER_MOEBEL, { code: "23", name: "Sanitär", color: "#4a4a4a", lw: 0.13, visible: true, locked: false }]);

  it("ein gesetztes WC erscheint als Linien an der Lage, gedreht", () => {
    const d = libDrawing({ shape: "libobj", libId: "lib:wc-wand", at: { x: 10, y: 10 }, rotation: 0 });
    const lines = drawingPrimitives(proj(), d).filter((p) => p.kind === "line");
    expect(lines.length).toBeGreaterThan(4);
    const ys = lines.flatMap((l) => [l.a.y, l.b.y]);
    // Wandseite bei y = 10, Bug 55 cm davor.
    expect(Math.min(...ys)).toBeCloseTo(10, 6);
    expect(Math.max(...ys)).toBeCloseTo(10.55, 2);
    const xs = lines.flatMap((l) => [l.a.x, l.b.x]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.38, 2);
  });

  it("Detailgrad: mehr Linien bei höherem Grad — Parameter ändern das Mass", () => {
    const d = libDrawing({ shape: "libobj", libId: "lib:lavabo", at: { x: 0, y: 0 }, rotation: 0, params: { w: 0.8 } });
    const xs = drawingPrimitives(proj(), d).filter((p) => p.kind === "line").flatMap((l) => [l.a.x, l.b.x]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.8, 2);
  });

  it("unbekannte Objekt-Id zeichnet einen Platzhalter-Rahmen statt zu scheitern", () => {
    const d = libDrawing({ shape: "libobj", libId: "lib:gibt-es-nicht", at: { x: 0, y: 0 }, rotation: 0 });
    expect(drawingPrimitives(proj(), d).filter((p) => p.kind === "line").length).toBeGreaterThanOrEqual(3);
  });

  it("gleicher Seed = gleiche Stühle; Unordnung 0 = regelmässig", () => {
    const mk = (mess: number, seed: number) =>
      drawingPrimitives(proj(), libDrawing({ shape: "libobj", libId: "lib:tisch-80x140", at: { x: 0, y: 0 }, rotation: 0, params: { mess }, seed }));
    expect(JSON.stringify(mk(1, 5))).toEqual(JSON.stringify(mk(1, 5)));
    expect(JSON.stringify(mk(1, 5))).not.toEqual(JSON.stringify(mk(1, 6)));
    expect(JSON.stringify(mk(0, 5))).toEqual(JSON.stringify(mk(0, 6)));
  });
});
