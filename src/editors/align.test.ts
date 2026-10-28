/** Ausrichten und Verteilen der 2D-Auswahl. */

import { describe, expect, it } from "vitest";
import { alignOps, distributeOps } from "./align";
import type { AlignMode, DistributeAxis } from "./align";
import { applyOps } from "../core/ops";
import { sampleProject } from "../model/sampleProject";
import type { Drawing2D, Project } from "../model/types";

const alignDrawings = (p: Project, ids: string[], m: AlignMode) => applyOps(p, alignOps(p, ids, m));
const distributeDrawings = (p: Project, ids: string[], a: DistributeAxis) => applyOps(p, distributeOps(p, ids, a));

/** Rechtecke als Testobjekte: bbox ist direkt ablesbar. */
function rects(boxes: [string, number, number, number, number][]): Project {
  const drawings2d: Drawing2D[] = boxes.map(([id, x0, y0, x1, y1]) => ({
    id,
    type: "drawing2d",
    levelId: sampleProject.drawingLevels[0].id,
    categoryCode: sampleProject.layers[0].code,
    geom: { shape: "rect", min: { x: x0, y: y0 }, max: { x: x1, y: y1 } },
  }));
  return { ...sampleProject, drawings2d };
}

const box = (p: Project, id: string) => {
  const g = p.drawings2d.find((d) => d.id === id)!.geom;
  if (g.shape !== "rect") throw new Error();
  return g;
};

describe("alignDrawings", () => {
  const P = rects([
    ["a", 0, 0, 2, 1],
    ["b", 5, 3, 6, 5],
    ["c", 10, 1, 14, 2],
  ]);

  it("linksbündig: alle an den linkesten Rand der AUSWAHL", () => {
    const out = alignDrawings(P, ["a", "b", "c"], "left");
    expect(box(out, "a").min.x).toBeCloseTo(0, 9);
    expect(box(out, "b").min.x).toBeCloseTo(0, 9);
    expect(box(out, "c").min.x).toBeCloseTo(0, 9);
    // Nur verschoben, nicht verzerrt: Breiten unverändert.
    expect(box(out, "c").max.x - box(out, "c").min.x).toBeCloseTo(4, 9);
  });

  it("rechtsbündig richtet an der rechten Kante aus", () => {
    const out = alignDrawings(P, ["a", "b", "c"], "right");
    for (const id of ["a", "b", "c"]) expect(box(out, id).max.x).toBeCloseTo(14, 9);
  });

  it("zentriert (X) bringt alle Mitten auf die Mitte der Auswahl", () => {
    const out = alignDrawings(P, ["a", "b", "c"], "centerX");
    const mid = (id: string) => (box(out, id).min.x + box(out, id).max.x) / 2;
    expect(mid("a")).toBeCloseTo(7, 9); // Hülle 0..14 → Mitte 7
    expect(mid("b")).toBeCloseTo(7, 9);
    expect(mid("c")).toBeCloseTo(7, 9);
  });

  it("oben/unten wirken auf Y und lassen X in Ruhe", () => {
    const out = alignDrawings(P, ["a", "b", "c"], "top");
    for (const id of ["a", "b", "c"]) expect(box(out, id).max.y).toBeCloseTo(5, 9);
    expect(box(out, "a").min.x).toBeCloseTo(0, 9); // X unverändert
  });

  it("unter zwei Elementen passiert nichts", () => {
    expect(alignDrawings(P, ["a"], "left")).toBe(P);
    expect(alignDrawings(P, [], "left")).toBe(P);
  });

  it("rührt nicht gewählte Elemente nicht an", () => {
    const out = alignDrawings(P, ["a", "b"], "left");
    expect(box(out, "c").min.x).toBeCloseTo(10, 9);
  });
});

describe("distributeDrawings", () => {
  it("verteilt die Mitten mit gleichen Abständen; die Äusseren bleiben stehen", () => {
    const P = rects([
      ["a", 0, 0, 2, 1], // Mitte 1
      ["b", 3, 0, 4, 1], // Mitte 3.5 (wandert)
      ["c", 8, 0, 10, 1], // Mitte 9
      ["d", 18, 0, 20, 1], // Mitte 19
    ]);
    const out = distributeDrawings(P, ["a", "b", "c", "d"], "x");
    const mid = (id: string) => (box(out, id).min.x + box(out, id).max.x) / 2;
    expect(mid("a")).toBeCloseTo(1, 9);
    expect(mid("d")).toBeCloseTo(19, 9);
    // Gleiche Schrittweite (19−1)/3 = 6.
    expect(mid("b")).toBeCloseTo(7, 9);
    expect(mid("c")).toBeCloseTo(13, 9);
  });

  it("nutzt die Reihenfolge auf der Achse, nicht die Auswahlreihenfolge", () => {
    const P = rects([
      ["links", 0, 0, 1, 1],
      ["rechts", 10, 0, 11, 1],
      ["mitte", 8, 0, 9, 1],
    ]);
    const out = distributeDrawings(P, ["rechts", "links", "mitte"], "x");
    const mid = (id: string) => (box(out, id).min.x + box(out, id).max.x) / 2;
    expect(mid("mitte")).toBeCloseTo(5.5, 9); // genau mittig zwischen 0.5 und 10.5
  });

  it("verteilt entlang Y, ohne X zu verändern", () => {
    const P = rects([
      ["a", 0, 0, 1, 1],
      ["b", 5, 2, 6, 3],
      ["c", 0, 10, 1, 11],
    ]);
    const out = distributeDrawings(P, ["a", "b", "c"], "y");
    const midY = (id: string) => (box(out, id).min.y + box(out, id).max.y) / 2;
    expect(midY("b")).toBeCloseTo(5.5, 9); // zwischen 0.5 und 10.5
    expect(box(out, "b").min.x).toBeCloseTo(5, 9); // X unangetastet
  });

  it("unter drei Elementen gibt es nichts zu verteilen", () => {
    const P = rects([
      ["a", 0, 0, 1, 1],
      ["b", 5, 0, 6, 1],
    ]);
    expect(distributeDrawings(P, ["a", "b"], "x")).toBe(P);
  });
});
