// Dach-Auswahl: deriveSelection liefert für ein selektiertes Dach eine
// Roof-Selection mit den erwarteten Attributen (Form/Neigung/Firsthöhe/Fläche).

import { describe, it, expect } from "vitest";
import { deriveSelection } from "./selectionInfo";
import type { Project, Roof } from "../model/types";

const roof: Roof = {
  id: "RF1",
  type: "roof",
  floorId: "eg",
  categoryCode: "31",
  outline: [
    { x: 0, y: 0 },
    { x: 6, y: 0 },
    { x: 6, y: 4 },
    { x: 0, y: 4 },
  ],
  shape: "sattel",
  pitchDeg: 45,
  overhang: 0,
  ridgeAxis: "x",
  thickness: 0.2,
};

const project = {
  id: "p",
  name: "T",
  layers: [{ code: "31", name: "Dächer", color: "#7a4a3a", lw: 0.35, visible: true, locked: false }],
  drawingLevels: [
    { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, baseElevation: 0 },
  ],
  walls: [],
  drawings2d: [],
  roofs: [roof],
} as unknown as Project;

describe("deriveSelection — Dach", () => {
  it("liefert eine Roof-Selection mit Form + abgeleiteten Werten", () => {
    const sel = deriveSelection(project, [], null, null, null, null, null, null, null, "RF1");
    expect(sel?.kind).toBe("roof");
    expect(sel?.roof?.shape).toBe("sattel");
    expect(sel?.roof?.pitchDeg).toBe(45);
    // Firsthöhe = halbe Tiefe (2) · tan45 (1) = 2.
    expect(sel?.roof?.ridgeHeight).toBeCloseTo(2, 6);
    // Grundfläche 6×4 = 24.
    expect(sel?.roof?.footprintArea).toBeCloseTo(24, 6);
    expect(sel?.id).toBe("RF1");
  });

  it("ohne Dach-Auswahl kein Roof (null bei leerer Auswahl)", () => {
    expect(deriveSelection(project, [], null)).toBeNull();
  });
});
