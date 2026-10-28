import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { documentFor } from "../core/document";
import { emitSlabs } from "./toWalls3d/ceilings";
import { emitColumns } from "./toWalls3d/columns";
import { projectToWalls3d } from "./toWalls3d";
import { emitOpeningMeshes } from "./toWalls3d/openings";
import { emitRoofs, emitRoofCutLayers } from "./toWalls3d/roofs";
import { emitStairs, emitStairMeshes, emitStairRailings } from "./toWalls3d/stairs";

const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
let seed = 21;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

describe("model3d walls", () => {
  it("sample project both paths", () => {
    const doc = documentFor(sampleProject);
    for (const layered of [true, false]) {
      expect(doc.query<unknown[]>("walls", [layered ? 1 : 0])).toEqual(plain(projectToWalls3d(sampleProject, layered)));
    }
  });
  it("random walls/openings/ceilings/roofs", () => {
    let n = 0;
    for (let t = 0; t < 150; t++) {
      const lvl = sampleProject.drawingLevels.filter((l) => l.kind === "floor");
      const pts = [[0, 0], [6, 0], [6, 4], [0, 4], [3, 0], [3, 4], [8, 2], [-2, 2]];
      const walls = Array.from({ length: 2 + Math.floor(rnd() * 6) }, (_, k) => {
        const a = pick(pts), b = pick(pts);
        return { ...sampleProject.walls[0], id: "w" + k, floorId: pick(lvl).id, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] + (a[1] === b[1] && a[0] === b[0] ? 1 : 0) },
          wallTypeId: pick(sampleProject.wallTypes).id,
          ...(rnd() < 0.3 ? { referenceLine: pick(["left", "right", "center"]) } : {}),
          ...(rnd() < 0.15 ? { referenceOffset: rnd() * 0.3 - 0.15 } : {}),
          ...(rnd() < 0.2 ? { sliceTermination: pick(["below", "above", "both"]) } : {}),
          height: pick([2.5, 2.6, 3]) };
      });
      const openings = walls.flatMap((w, k) => rnd() < 0.6 ? [{ id: "o" + k, type: "opening", hostWallId: w.id, categoryCode: "21", kind: pick(["window", "door"]),
        ...(rnd() < 0.5 ? { typeId: pick(["window-standard", "window-double", "door-standard", "door-entry"]) } : {}),
        position: rnd() * 2, width: 0.6 + rnd(), height: 1.2 + rnd(), sillHeight: pick([0, 0.9]) }] : []);
      const ceilings = Array.from({ length: Math.floor(rnd() * 3) }, (_, k) => ({ id: "c" + k, type: "ceiling", floorId: pick(lvl).id, categoryCode: "20",
        outline: [{ x: -1, y: -1 }, { x: 7, y: -1 }, { x: 7, y: 5 }, { x: -1, y: 5 }], wallTypeId: sampleProject.wallTypes[0].id,
        ...(sampleProject.ceilingTypes?.length && rnd() < 0.5 ? { ceilingTypeId: pick(sampleProject.ceilingTypes).id } : {}) }));
      const roofs = rnd() < 0.5 ? [{ id: "R1", type: "roof", floorId: pick(lvl).id, categoryCode: "35", outline: [{ x: -1, y: -1 }, { x: 7, y: -1 }, { x: 7, y: 5 }, { x: -1, y: 5 }],
        shape: pick(["sattel", "walm", "pult", "flach"]), pitchDeg: 30, overhang: 0.3, ridgeAxis: pick(["x", "y"]), thickness: 0.2 }] : [];
      const kinds = ["fest", "dreh", "kipp", "drehkipp", "schiebe"];
      const wts = Array.from({ length: 2 }, (_, k) => ({ ...sampleProject.windowTypes![0], id: "wt" + k, kind: pick(kinds), wingCount: 1 + Math.floor(rnd() * 3),
        frameWidth: rnd() < 0.5 ? pick([0.04, 0.06, 0.09]) : undefined, transomHeight: rnd() < 0.5 ? pick([0.2, 0.4]) : undefined,
        mullionRows: rnd() < 0.5 ? pick([1, 2, 3]) : undefined, mullionCols: rnd() < 0.5 ? pick([1, 2]) : undefined,
        sillBoard: pick(["keine", "innen", "aussen", "beide", undefined]), glazingPanes: pick([1, 2, 3, undefined]), glazing: pick(["einfach", "zweifach", "dreifach"]),
        frameCornerJoin: pick(["vertikal", "horizontal", "gehrung", undefined]), insetFromFace: rnd() < 0.5 ? 0.1 : undefined, insetFace: pick(["aussen", "innen", undefined]),
        innerLayerRecess: rnd() < 0.3 ? true : undefined, shading: rnd() < 0.4 ? { create: true, kind: "rollladen", box: { width: 1, height: 0.2, depth: 0.2 } } : undefined,
        sashes: rnd() < 0.6 ? Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ kind: pick(["fluegel", "fluegel", "pfosten"]), autoWidth: pick([true, false, undefined]), width: rnd() < 0.5 ? 0.4 : undefined, postWidth: rnd() < 0.5 ? 0.08 : undefined, opening: pick([...kinds, undefined]), hingeSide: pick(["left", "right", undefined]) })) : undefined }));
      const dts = Array.from({ length: 2 }, (_, k) => ({ ...sampleProject.doorTypes![0], id: "dt" + k, leafStyle: pick(["glatt", "glas", "kassette"]), glazingRatio: rnd() < 0.5 ? pick([0.3, 1]) : undefined,
        frameKind: pick(["zarge", "blockrahmen", undefined]), threshold: pick([true, false, undefined]), leafCount: pick([1, 2]) , panelCols: rnd() < 0.5 ? 2 : undefined, panelRows: rnd() < 0.5 ? 3 : undefined }));
      const openings2 = openings.map((o: any) => ({ ...o, ...(rnd() < 0.8 ? { typeId: o.kind === "door" ? pick(dts).id : pick(wts).id } : {}), ...(rnd() < 0.3 ? { wingCount: 2 } : {}) }));
      const project: any = { ...sampleProject, walls, openings: openings2, ceilings, roofs, windowTypes: wts, doorTypes: dts };
      const doc = documentFor(project);
      for (const [dc, dn] of [[0, "grob"], [1, "mittel"], [2, "fein"]] as const) {
        expect(doc.query<unknown[]>("openingMeshes", [dc])).toEqual(plain(emitOpeningMeshes(project, dn)));
      }
      for (const layered of [true, false]) {
        let want: unknown;
        try { want = plain(projectToWalls3d(project, layered)); } catch { want = undefined; }
        if (want === undefined) { expect(() => doc.query("walls", [layered ? 1 : 0])).toThrow(); continue; }
        expect(doc.query<unknown[]>("walls", [layered ? 1 : 0])).toEqual(want);
        n += (want as unknown[]).length;
      }
    }
    expect(n).toBeGreaterThan(500);
  });
});

describe("model3d stairs", () => {
  it("random", () => {
    let n = 0;
    for (let t = 0; t < 200; t++) {
      const lvl = sampleProject.drawingLevels.filter((l) => l.kind === "floor");
      const types = Array.from({ length: 3 }, (_, k) => ({ id: "st" + k, name: "t", structure: pick(["massiv", "beton", "wange", "aufgesattelt", "spindel"]), closedRisers: rnd() < 0.5,
        treadThickness: pick([0.04, 0.06]), nosing: rnd() < 0.5 ? 0.03 : undefined, railing: pick(["keine", "links", "rechts", "beide", undefined]), defaultWidth: 1 }));
      const stairs = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, k) => {
        const shape = pick(["straight", "L", "spiral"]);
        return { id: "s" + k, type: "stair", floorId: pick(lvl).id, categoryCode: "25", shape, start: { x: rnd() * 5, y: rnd() * 5 }, dir: pick([{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]),
          runLength: 2 + rnd() * 3, ...(shape === "L" ? { run2Length: 1.5, turn: pick([1, -1]) } : {}), ...(shape === "spiral" ? { center: { x: 2, y: 2 }, radius: 1.2, sweep: 4 } : {}),
          width: 1, stepCount: 8 + Math.floor(rnd() * 8), ...(rnd() < 0.5 ? { totalRise: 2.6 } : {}), ...(rnd() < 0.5 ? { up: pick([true, false]) } : {}),
          ...(rnd() < 0.7 ? { typeId: pick(types).id } : {}), ...(rnd() < 0.3 ? { referenz: pick(["links", "rechts", "mitte"]) } : {}) };
      });
      const project: any = { ...sampleProject, stairs, stairTypes: types };
      const doc = documentFor(project);
      for (const fs of [false, true]) {
        const a = doc.query<unknown[]>("stairSlabs", [fs ? 1 : 0]);
        const b = plain(emitStairs(project, { forSection: fs }));
        expect(a).toEqual(b);
        n += b.length;
      }
      expect(doc.query("stairMeshes")).toEqual(plain(emitStairMeshes(project)));
      expect(doc.query("stairRailings")).toEqual(plain(emitStairRailings(project)));
    }
    expect(n).toBeGreaterThan(300);
  });
});

describe("model3d roofs", () => {
  it("random", () => {
    let n = 0;
    const L = [{ x: 0, y: 0 }, { x: 11, y: 0 }, { x: 11, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 6 }, { x: 0, y: 6 }];
    const R = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }];
    for (let t = 0; t < 200; t++) {
      const lvl = sampleProject.drawingLevels.filter((l) => l.kind === "floor");
      const roofTypes = sampleProject.roofTypes ?? [];
      const roofs = Array.from({ length: 1 + Math.floor(rnd() * 2) }, (_, k) => ({ id: "R" + k, type: "roof", floorId: pick(lvl).id, categoryCode: "35", outline: pick([L, R]),
        shape: pick(["sattel", "walm", "pult", "flach", "mansarde", "zelt"]), pitchDeg: 10 + Math.floor(rnd() * 40), overhang: rnd() * 0.5, ridgeAxis: pick(["x", "y"]), thickness: pick([0.1, 0.2]),
        ...(roofTypes.length && rnd() < 0.7 ? { roofTypeId: pick(roofTypes).id } : {}), ...(rnd() < 0.3 ? { color: "#aa3322" } : {}), ...(rnd() < 0.3 ? { baseElevation: 3 } : {}) }));
      const project: any = { ...sampleProject, roofs };
      const doc = documentFor(project);
      const a = doc.query<unknown[]>("roofMeshes");
      const b = plain(emitRoofs(project));
      expect(a).toEqual(b);
      expect(plain(doc.query("roofCutLayers"))).toEqual(plain(emitRoofCutLayers(project)));
      n += b.length;
    }
    expect(n).toBeGreaterThan(100);
  });
});

describe("model3d slabs/columns", () => {
  it("random", () => {
    let ns = 0, nc = 0;
    for (let t = 0; t < 200; t++) {
      const lvl = sampleProject.drawingLevels.filter((l) => l.kind === "floor");
      const ceilings = Array.from({ length: Math.floor(rnd() * 4) }, (_, k) => ({
        id: "c" + k, type: "ceiling", floorId: pick(lvl).id, categoryCode: "20",
        outline: [{ x: 0, y: 0 }, { x: 5 + k, y: 0 }, { x: 5 + k, y: 4 }, { x: 0, y: 4 }],
        ...(rnd() < 0.5 ? { openings: [[{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }]] } : {}),
        wallTypeId: sampleProject.wallTypes[0].id,
        ...(rnd() < 0.5 && sampleProject.ceilingTypes?.length ? { ceilingTypeId: pick(sampleProject.ceilingTypes).id } : {}),
        ...(rnd() < 0.3 ? { thickness: 0.25 } : {}),
        ...(rnd() < 0.2 ? { top: { mode: "custom", z: 3.1 } } : {}),
      }));
      const columns = Array.from({ length: Math.floor(rnd() * 4) }, (_, k) => ({
        id: "k" + k, type: "column", floorId: pick(lvl).id, categoryCode: "20",
        position: { x: k, y: 1 }, rotation: rnd() * 3, height: pick([0, 2.5, 3]),
        profile: pick([{ kind: "rect", width: 0.3, depth: 0.4 }, { kind: "round", radius: 0.2 }]),
        ...(rnd() < 0.5 ? { componentId: pick(sampleProject.components).id } : {}),
        ...(rnd() < 0.3 ? { componentId: "nope" } : {}),
      }));
      const project: any = { ...sampleProject, ceilings, columns };
      const doc = documentFor(project);
      const a = doc.query<unknown[]>("slabs");
      const b = plain(emitSlabs(project));
      expect(a).toEqual(b);
      const c = doc.query<unknown[]>("columnMeshes");
      const d = plain(emitColumns(project));
      expect(c).toEqual(d);
      ns += b.length; nc += d.length;
    }
    expect(ns).toBeGreaterThan(100);
    expect(nc).toBeGreaterThan(100);
  });
});
