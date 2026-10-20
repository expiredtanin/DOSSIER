import { describe, expect, it } from "vitest";
import type { Drawing2D, HatchStyle } from "../model/types";
import { DEFAULT_SOLID_FILL, applyFillMode } from "./fillMode";

const hatches = [
  { id: "none", name: "Ohne", pattern: "none" },
  { id: "diag", name: "Diagonal", pattern: "diagonal" },
] as unknown as HatchStyle[];
const base = { id: "d", type: "drawing2d", levelId: "L", categoryCode: "60" } as unknown as Drawing2D;

describe("applyFillMode", () => {
  it("none: entfernt Farbe und Schraffur, Quellen auf eigenen Wert", () => {
    const d = applyFillMode({ ...base, background: "#fff", fillColor: "#eee", hatchId: "diag" } as Drawing2D, hatches, "none");
    expect(d.background).toBeUndefined();
    expect(d.fillColor).toBeUndefined();
    expect(d.hatchId).toBeUndefined();
    expect(d.backgroundSource).toBe("object");
  });
  it("solid: behält vorhandene Füllfarbe, sonst Vorgabe; ohne Schraffur", () => {
    expect(applyFillMode({ ...base, fillColor: "#123456" } as Drawing2D, hatches, "solid").background).toBe("#123456");
    expect(applyFillMode(base, hatches, "solid").background).toBe(DEFAULT_SOLID_FILL);
    expect(applyFillMode({ ...base, hatchId: "diag" } as Drawing2D, hatches, "solid").hatchId).toBeUndefined();
  });
  it("hatch: wählt die erste echte Schraffur (nie 'Ohne'), behält die Füllfarbe", () => {
    const d = applyFillMode({ ...base, background: "#abcdef" } as Drawing2D, hatches, "hatch");
    expect(d.hatchId).toBe("diag");
    expect(d.background).toBe("#abcdef");
    expect(applyFillMode({ ...base, hatchId: "none" } as Drawing2D, hatches, "hatch").hatchId).toBe("diag");
  });
});
