// [112]/[38] Achsraster und Bemassung im Store: eine Bemassung zwischen zwei Achsen folgt der verschobenen
// Achse (Kern führt `pts` im selben Undo-Schritt nach); Rundmass folgt dem Kreis; Achsfang im Kern.
import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { emptyProject } from "../model/sampleProject";
import { addItems, cmdMutation, patchItem } from "../core";
import type { Drawing2D } from "../model/types";

const dims = (): Drawing2D[] => getState().project.drawings2d.filter((d) => d.geom.shape === "dimension");
const xs = (d: Drawing2D): number[] => (d.geom.shape === "dimension" ? d.geom.pts.map((q) => q.x) : []);

beforeEach(() => {
  setState({ project: emptyProject, undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false });
  getState().clearHistory();
  getState().setProject(cmdMutation({ cmd: "grid", at: [2, 1], xs: "6 6", ys: "5", ctx: { level: "eg", cat: "20" }, stamp: "g" }));
});

describe("Achsraster im Store", () => {
  it("Bemassung zwischen zwei Achsen: Achse verschieben → Mass folgt, ein Undo-Schritt", () => {
    const grid = getState().project.drawings2d.find((d) => d.geom.shape === "grid")!;
    expect(grid).toBeDefined();
    // Achse 1 bei x = 2, Achse 2 bei x = 8, Kette auf y = 3 zwischen den gefangenen Achspunkten.
    getState().setProject(cmdMutation({ cmd: "dimension", pts: [[2, 3], [8, 3]], snaps: [[2, 3], [8, 3]], offset: 1, ctx: { level: "eg" }, stamp: "t" }));
    const d0 = dims()[0];
    expect(d0.geom.shape === "dimension" && d0.geom.refs?.map((r) => r?.feature)).toEqual(["axis", "axis"]);
    expect(xs(d0)).toEqual([2, 8]);

    getState().applyChange((p) =>
      patchItem(p, "drawings2d", grid.id, (d) => (d.geom.shape === "grid" ? { ...d, geom: { ...d.geom, a: d.geom.a.map((x) => (x.label === "2" ? { ...x, pos: 7.5 } : x)) } } : d)),
    );
    expect(xs(dims()[0])).toEqual([2, 9.5]);
    getState().undo();
    expect(xs(dims()[0])).toEqual([2, 8]);
    getState().redo();
    expect(xs(dims()[0])).toEqual([2, 9.5]);
  });

  it("Raster verschieben mit der Bemassung bleibt verbunden; Achsschnittpunkt hängt als axiscross an", () => {
    getState().setProject(cmdMutation({ cmd: "dimension", pts: [[2, 1], [8, 1]], snaps: [[2, 1], [8, 1]], offset: 1, ctx: { level: "eg" }, stamp: "t" }));
    const d = dims()[0];
    expect(d.geom.shape === "dimension" && d.geom.refs?.map((r) => r?.feature)).toEqual(["axiscross", "axiscross"]);
    // Ursprung des Rasters um (1, 0) verschieben → Punkte folgen.
    const grid = getState().project.drawings2d.find((x) => x.geom.shape === "grid")!;
    getState().applyChange((p) => patchItem(p, "drawings2d", grid.id, (x) => (x.geom.shape === "grid" ? { ...x, geom: { ...x.geom, origin: { x: 3, y: 1 } } } : x)));
    expect(xs(dims()[0])).toEqual([3, 9]);
  });

  it("Radiusmass folgt dem Kreis", () => {
    getState().applyChange(
      addItems("drawings2d", [{ id: "K", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "circle", center: { x: 20, y: 20 }, r: 2 } } as Drawing2D]),
    );
    getState().setProject(cmdMutation({ cmd: "dimround", kind: "radius", pts: [[22, 20]], ctx: { level: "eg" }, stamp: "r" }));
    getState().applyChange((p) => patchItem(p, "drawings2d", "K", (x) => (x.geom.shape === "circle" ? { ...x, geom: { ...x.geom, center: { x: 30, y: 20 }, r: 3 } } : x)));
    const d = dims()[0];
    expect(d.geom.shape === "dimension" && d.geom.pts).toEqual([{ x: 30, y: 20 }, { x: 33, y: 20 }]);
  });
});
