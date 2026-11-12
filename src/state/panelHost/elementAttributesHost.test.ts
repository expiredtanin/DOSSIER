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
    setWallThickness: s.setWallThickness,
    setCeilingThickness: s.setCeilingThickness,
    selection: { kind, id },
  } as unknown as FlatHostOpts) as unknown as Host;
}

describe("Mehrfachauswahl setzt alle gewählten Elemente in einem Schritt [195b]", () => {
  it("Öffnungen: Breite und Brüstung gelten für alle, je ein Undo-Schritt", () => {
    getState().loadProject(buildComplexSampleProject());
    const [a, b] = getState().project.openings!;
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

  it("Dächer: Neigung für alle; andere Felder nur für das erste", () => {
    getState().loadProject(buildComplexSampleProject());
    const [a, b] = getState().project.roofs!;
    setState({ selection: { ...EMPTY_SELECTION, roofs: [a.id, b.id] } });
    const host = hostFor("roof", a.id);
    (host.onSetRoofPatch as (p: object) => void)({ pitchDeg: 33 });
    expect(getState().project.roofs!.find((r) => r.id === b.id)!.pitchDeg).toBe(33);
    (host.onSetRoofPatch as (p: object) => void)({ overhang: 0.77 });
    const r2 = getState().project.roofs!;
    expect(r2.find((r) => r.id === a.id)!.overhang).toBe(0.77);
    expect(r2.find((r) => r.id === b.id)!.overhang).not.toBe(0.77);
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
});
