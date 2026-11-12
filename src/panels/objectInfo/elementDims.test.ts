import { describe, expect, it } from "vitest";
import { elementDimensions } from "./elementDims";
import { deriveSelection } from "../../state/selectionInfo";
import { sampleProject } from "../../model/sampleProject";

describe("elementDimensions [204a]", () => {
  const p = structuredClone(sampleProject);
  it("Wand: Länge, Dicke, Höhe statt Achs-Rechteck", () => {
    const w = p.walls[0];
    const d = elementDimensions(deriveSelection(p, { walls: [w.id] })!)!;
    expect(d.map((x) => x.label)).toEqual(["objinfo.wall.length", "objinfo.wall.thickness", "objinfo.wall.height"]);
    expect(d[1].value).toBeGreaterThan(0);
    expect(d[2].value).toBeGreaterThan(1);
  });
  it("Öffnung: Breite, Höhe, Brüstung (nicht die Wanddicke)", () => {
    const o = p.openings![0];
    const d = elementDimensions(deriveSelection(p, { openings: [o.id] })!)!;
    expect(d.map((x) => x.label)).toEqual(["objinfo.opening.width", "objinfo.opening.height", "objinfo.opening.sill"]);
    expect(d[0].value).toBe(o.width);
    expect(d[1].value).toBe(o.height);
  });
  it("Zeichnung: generisch", () => {
    const sel = deriveSelection(p, { drawings: p.drawings2d.slice(0, 1).map((x) => x.id) });
    if (sel) expect(elementDimensions(sel)).toBeNull();
  });
});
