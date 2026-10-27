import { describe, it, expect } from "vitest";
import type { Project } from "../model/types";
import { categoryNameForPick } from "./pickLabels";

const project = {
  layers: [
    { code: "20", name: "Wände", color: "#000", lw: 0.5, visible: true, locked: false },
    {
      code: "05", name: "Import: Luzern", color: "#000", lw: 0.5, visible: true, locked: false,
      children: [{ code: "100", name: "01421", color: "#000", lw: 0.18, visible: true, locked: false }],
    },
  ],
  walls: [{ id: "w1", categoryCode: "20" }],
  openings: [{ id: "t1", categoryCode: "20" }],
  drawings2d: [{ id: "d1", categoryCode: "100" }, { id: "d2", categoryCode: "99" }],
} as unknown as Project;

describe("categoryNameForPick", () => {
  it("liefert den Kategorie-Namen (auch aus verschachtelten Import-Kategorien)", () => {
    expect(categoryNameForPick(project, "wall", "w1")).toBe("Wände");
    expect(categoryNameForPick(project, "drawing", "d1")).toBe("01421");
    expect(categoryNameForPick(project, "opening", "t1")).toBe("Wände");
  });
  it("undefined bei unbekannter ID/Kategorie und bei Schnittlinien", () => {
    expect(categoryNameForPick(project, "drawing", "nix")).toBeUndefined();
    expect(categoryNameForPick(project, "drawing", "d2")).toBeUndefined();
    expect(categoryNameForPick(project, "section", "s")).toBeUndefined();
    expect(categoryNameForPick(project, "room", "r")).toBeUndefined();
  });
});
