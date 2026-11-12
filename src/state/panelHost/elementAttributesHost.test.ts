// [195b] Wandtyp bei Mehrfachauswahl: gilt für alle gewählten Wände, ein Undo-Schritt.
import { describe, expect, it } from "vitest";
import { getState, setState } from "../appStore";
import { buildComplexSampleProject } from "../../model/sampleProjectComplex";
import { EMPTY_SELECTION } from "../selection";
import { buildElementAttributesHost } from "./elementAttributesHost";
import type { FlatHostOpts } from "./types";

describe("onSetWallType [195b]", () => {
  it("setzt den Typ aller gewählten Wände in einem Schritt", () => {
    getState().loadProject(buildComplexSampleProject());
    const [a, b] = getState().project.walls;
    const target = getState().project.wallTypes.find((t) => t.id !== a.wallTypeId && t.id !== b.wallTypeId)!;
    setState({ selection: { ...EMPTY_SELECTION, walls: [a.id, b.id] } });
    const s = getState();
    const host = buildElementAttributesHost({
      applyChange: s.applyChange,
      updateWall: s.updateWall,
      selection: { kind: "wall", id: a.id },
    } as unknown as FlatHostOpts) as { onSetWallType: (id: string) => void };
    const depth = getState().undoDepth;
    host.onSetWallType(target.id);
    const walls = getState().project.walls;
    expect(walls.find((w) => w.id === a.id)!.wallTypeId).toBe(target.id);
    expect(walls.find((w) => w.id === b.id)!.wallTypeId).toBe(target.id);
    expect(getState().undoDepth).toBe(depth + 1);
  });
});

type Host = Record<string, (...a: never[]) => void>;
function hostFor(kind: string, id: string): Host {
  const s = getState();
  return buildElementAttributesHost({
    applyChange: s.applyChange,
    updateWall: s.updateWall,
    updateCeiling: s.updateCeiling,
    updateOpening: s.updateOpening,
    updateRoof: s.updateRoof,
    project: s.project,
    updateStair: s.updateStair,
    updateRoom: s.updateRoom,
    setWallThickness: s.setWallThickness,
    setCeilingThickness: s.setCeilingThickness,
    selection: { kind, id },
  } as unknown as FlatHostOpts) as unknown as Host;
}

describe("Mehrfachauswahl setzt alle gewählten Elemente in einem Schritt [195b]", () => {
  it("Öffnungen: Breite und Brüstung gelten für alle, je ein Undo-Schritt", () => {
    getState().loadProject(buildComplexSampleProject());
    const [a, b] = getState().project.openings!.filter((o) => o.kind === "window");
    setState({ selection: { ...EMPTY_SELECTION, openings: [a.id, b.id] } });
    const host = hostFor("opening", a.id);
    const depth = getState().undoDepth;
    (host.onSetOpeningWidth as (w: number) => void)(1.234);
    const os = getState().project.openings!;
    expect(os.find((o) => o.id === a.id)!.width).toBe(1.234);
    expect(os.find((o) => o.id === b.id)!.width).toBe(1.234);
    expect(getState().undoDepth).toBe(depth + 1);
    (host.onSetOpeningSill as (w: number) => void)(0.77);
    expect(getState().project.openings!.find((o) => o.id === b.id)!.sillHeight).toBe(0.77);
    expect(getState().undoDepth).toBe(depth + 2);
  });

  it("Decken: Oberkante und Dicke für alle, je ein Undo-Schritt", () => {
    getState().loadProject(buildComplexSampleProject());
    const [a, b] = getState().project.ceilings!;
    setState({ selection: { ...EMPTY_SELECTION, ceilings: [a.id, b.id] } });
    const host = hostFor("ceiling", a.id);
    let depth = getState().undoDepth;
    (host.onSetCeilingTop as (x: unknown) => void)({ mode: "custom", z: 9.5 });
    const cs = getState().project.ceilings!;
    expect(cs.find((c) => c.id === b.id)!.top).toEqual({ mode: "custom", z: 9.5 });
    expect(getState().undoDepth).toBe(depth + 1);
    depth = getState().undoDepth;
    (host.onSetCeilingThickness as (x: number) => void)(0.31);
    expect(getState().undoDepth).toBe(depth + 1);
    getState().undo();
    expect(getState().undoDepth).toBe(depth);
  });

  it("Dächer: Neigung, Dicke, Traufhöhe, Überstand für alle in EINEM Undo-Schritt; Gauben/Kanten nur das erste", () => {
    getState().loadProject(buildComplexSampleProject());
    const [a, b] = getState().project.roofs!;
    setState({ selection: { ...EMPTY_SELECTION, roofs: [a.id, b.id] } });
    const host = hostFor("roof", a.id);
    const patch = host.onSetRoofPatch as (p: object, k?: string) => void;
    patch({ pitchDeg: 33 });
    expect(getState().project.roofs!.find((r) => r.id === b.id)!.pitchDeg).toBe(33);
    const depth = getState().undoDepth;
    patch({ overhang: 0.77 });
    patch({ thickness: 0.31 });
    patch({ baseElevation: 4.2 });
    const r2 = getState().project.roofs!;
    for (const id of [a.id, b.id]) {
      const r = r2.find((x) => x.id === id)!;
      expect(r.overhang).toBe(0.77);
      expect(r.thickness).toBe(0.31);
      expect(r.baseElevation).toBe(4.2);
    }
    expect(getState().undoDepth).toBe(depth + 3);
    getState().undo();
    getState().undo();
    getState().undo();
    expect(getState().project.roofs!.find((r) => r.id === b.id)!.overhang).toBe(b.overhang);
    // dachspezifisch: nur das erste Dach
    patch({ edgePitchDeg: [20, 20, 20, 20] });
    const r3 = getState().project.roofs!;
    expect(r3.find((r) => r.id === a.id)!.edgePitchDeg).toEqual([20, 20, 20, 20]);
    expect(r3.find((r) => r.id === b.id)!.edgePitchDeg).toEqual(b.edgePitchDeg);
  });

  it("Wände: Unterkante und Dicke für alle", () => {
    getState().loadProject(buildComplexSampleProject());
    const [a, b] = getState().project.walls;
    setState({ selection: { ...EMPTY_SELECTION, walls: [a.id, b.id] } });
    const host = hostFor("wall", a.id);
    (host.onSetWallBottom as (x: unknown) => void)({ mode: "custom", z: 0.2 });
    expect(getState().project.walls.find((w) => w.id === b.id)!.bottom).toEqual({ mode: "custom", z: 0.2 });
    const depth = getState().undoDepth;
    (host.onSetWallThickness as (x: number) => void)(0.29);
    expect(getState().undoDepth).toBe(depth + 1);
  });

  it("Öffnungen: Zusatzfelder und Editor-Patch nur für Öffnungen GLEICHER Art", () => {
    getState().loadProject(buildComplexSampleProject());
    const os = getState().project.openings!;
    const doors = os.filter((o) => o.kind === "door");
    const win = os.find((o) => o.kind === "window")!;
    setState({ selection: { ...EMPTY_SELECTION, openings: [doors[0].id, doors[1].id, win.id] } });
    const host = hostFor("opening", doors[0].id);
    const depth = getState().undoDepth;
    (host.onSetOpeningHinge as (x: string) => void)("end");
    const after = getState().project.openings!;
    expect(after.find((o) => o.id === doors[1].id)!.hinge).toBe("end");
    expect(after.find((o) => o.id === win.id)!.hinge).toBe(os.find((o) => o.id === win.id)!.hinge);
    expect(getState().undoDepth).toBe(depth + 1);
    // Editor: Instanz-Patch für alle Türen, die Position nur für das erste Element.
    (host.onPatchOpening as (x: object) => void)({ frameDetail: undefined, shape: "bogen" });
    expect(getState().project.openings!.find((o) => o.id === doors[1].id)!.shape).toBe("bogen");
    expect(getState().project.openings!.find((o) => o.id === win.id)!.shape).not.toBe("bogen");
    expect(getState().undoDepth).toBe(depth + 2);
  });

  it("Wände: Referenzlinie für alle in einem Schritt", () => {
    getState().loadProject(buildComplexSampleProject());
    const [a, b] = getState().project.walls;
    setState({ selection: { ...EMPTY_SELECTION, walls: [a.id, b.id] } });
    const host = hostFor("wall", a.id);
    const depth = getState().undoDepth;
    (host.onSetWallReferenceLine as (x: string) => void)("right");
    expect(getState().project.walls.find((w) => w.id === b.id)!.referenceLine).toBe("right");
    expect(getState().undoDepth).toBe(depth + 1);
  });

  it("Treppen, Räume, Stützen, Körper: Setter wirken auf alle, Raumname nur auf das erste", () => {
    getState().loadProject(buildComplexSampleProject());
    const p = getState().project;
    const [s1, s2] = p.stairs!;
    setState({ selection: { ...EMPTY_SELECTION, stairs: [s1.id, s2.id] } });
    let depth = getState().undoDepth;
    (hostFor("stair", s1.id).onSetStairWidth as (x: number) => void)(1.37);
    expect(getState().project.stairs!.find((s) => s.id === s2.id)!.width).toBe(1.37);
    expect(getState().undoDepth).toBe(depth + 1);

    const [r1, r2] = p.rooms!;
    setState({ selection: { ...EMPTY_SELECTION, rooms: [r1.id, r2.id] } });
    depth = getState().undoDepth;
    const sia = r1.siaCategory === "NNF" ? "VF" : "NNF";
    (hostFor("room", r1.id).onSetRoomSia as (x: string) => void)(sia);
    expect(getState().project.rooms!.find((r) => r.id === r2.id)!.siaCategory).toBe(sia);
    expect(getState().undoDepth).toBe(depth + 1);
    (hostFor("room", r1.id).onSetRoomName as (x: string) => void)("Eigenname");
    expect(getState().project.rooms!.find((r) => r.id === r2.id)!.name).not.toBe("Eigenname");

    const [c1, c2] = p.columns!;
    setState({ selection: { ...EMPTY_SELECTION, columns: [c1.id, c2.id] } });
    depth = getState().undoDepth;
    (hostFor("column", c1.id).onSetColumnHeight as (x: number) => void)(3.3);
    expect(getState().project.columns!.find((c) => c.id === c2.id)!.height).toBe(3.3);
    expect(getState().undoDepth).toBe(depth + 1);

    const [e1, e2] = p.extrudedSolids!;
    setState({ selection: { ...EMPTY_SELECTION, solids: [e1.id, e2.id] } });
    depth = getState().undoDepth;
    (hostFor("extrudedSolid", e1.id).onSetExtrudedSolidHeight as (x: number) => void)(2.2);
    expect(getState().project.extrudedSolids!.find((e) => e.id === e2.id)!.height).toBe(2.2);
    expect(getState().undoDepth).toBe(depth + 1);
  });

  it("Dach: Kanten bleiben beim ersten Dach", () => {
    getState().loadProject(buildComplexSampleProject());
    const [a, b] = getState().project.roofs!;
    setState({ selection: { ...EMPTY_SELECTION, roofs: [a.id, b.id] } });
    const before = JSON.stringify(b);
    (hostFor("roof", a.id).onSetRoofEdge as (i: number, s: object) => void)(0, { kind: "pitch", pitchDeg: 51 });
    expect(JSON.stringify(getState().project.roofs!.find((r) => r.id === b.id))).toBe(before);
  });
});
