/**
 * `commitTransform`/`transformPreview` mit MEHREREN gewählten 2D-Elementen
 * (`TransformSelection.drawingIds`) — Nutzer-Report: "wenn ich zwei Linien
 * anwähle, dass ich dann m usw nicht verwenden kann". Vorher trug
 * `TransformSelection` nur ein einzelnes `drawingId`, das bei einer
 * Mehrfachauswahl (2+ Elemente) `null` war → Bewegen/Kopieren/Spiegeln/
 * Drehen/Feld griffen gar nicht.
 */

import { describe, it, expect } from "vitest";
import { commitTransform } from "./transform";
import type { TransformSelection } from "./transform";
import type { Drawing2D, Project } from "../model/types";

function project(drawings: Drawing2D[]): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [],
    layers: [],
    walls: [],
    doors: [],
    drawings2d: drawings,
  };
}

function line(id: string, x: number): Drawing2D {
  return {
    id,
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: { shape: "line", a: { x, y: 0 }, b: { x: x + 1, y: 0 } },
  };
}

describe("commitTransform — Mehrfachauswahl (drawingIds)", () => {
  it("move: verschiebt ALLE gewählten 2D-Elemente, nicht nur eines", () => {
    const p = project([line("d1", 0), line("d2", 5), line("d3", 10)]);
    const sel: TransformSelection = { wallIds: [], drawingId: null, drawingIds: ["d1", "d2"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 2, y: 3 }], "move", 1);
    const d1 = next.drawings2d.find((d) => d.id === "d1")!.geom;
    const d2 = next.drawings2d.find((d) => d.id === "d2")!.geom;
    const d3 = next.drawings2d.find((d) => d.id === "d3")!.geom;
    if (d1.shape === "line") expect(d1.a).toEqual({ x: 2, y: 3 });
    if (d2.shape === "line") expect(d2.a).toEqual({ x: 7, y: 3 }); // 5+2
    if (d3.shape === "line") expect(d3.a).toEqual({ x: 10, y: 0 }); // nicht gewählt, unverändert
  });

  it("copy: dupliziert ALLE gewählten 2D-Elemente (Original bleibt)", () => {
    const p = project([line("d1", 0), line("d2", 5)]);
    const sel: TransformSelection = { wallIds: [], drawingId: null, drawingIds: ["d1", "d2"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 1, y: 0 }], "copy", 1);
    expect(next.drawings2d.length).toBe(4); // 2 Original + 2 Kopien
  });

  it("array: dupliziert ALLE gewählten 2D-Elemente N-mal", () => {
    const p = project([line("d1", 0), line("d2", 5)]);
    const sel: TransformSelection = { wallIds: [], drawingId: null, drawingIds: ["d1", "d2"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 1, y: 0 }], "array", 3);
    expect(next.drawings2d.length).toBe(8); // 2 Original + 2×3 Kopien
  });

  it("weiterhin abwärtskompatibel: einzelnes `drawingId` (ohne drawingIds) funktioniert unverändert", () => {
    const p = project([line("d1", 0)]);
    const sel: TransformSelection = { wallIds: [], drawingId: "d1" };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 3, y: 0 }], "move", 1);
    const d1 = next.drawings2d[0].geom;
    if (d1.shape === "line") expect(d1.a).toEqual({ x: 3, y: 0 });
  });

  it("drawingId + drawingIds zusammen werden dedupliziert (kein Doppel-Verschieben)", () => {
    const p = project([line("d1", 0), line("d2", 5)]);
    const sel: TransformSelection = { wallIds: [], drawingId: "d1", drawingIds: ["d1", "d2"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 1, y: 0 }], "copy", 1);
    expect(next.drawings2d.length).toBe(4); // je EINE Kopie pro Element, nicht zwei für d1
  });
});
