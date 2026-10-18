import { describe, it, expect } from "vitest";
import type { LayerCategory } from "../model/types";
import { planImportCategories } from "./dxfToDrawings";

const cat = (code: string, name: string, children?: LayerCategory[]): LayerCategory => ({
  code,
  name,
  color: "#000000",
  lw: 0.18,
  visible: true,
  locked: false,
  children,
});

describe("planImportCategories", () => {
  it("legt fehlende Layer als Unterkategorien EINER neuen Elternkategorie an", () => {
    const existing = [cat("20", "Wände"), cat("90", "Referenzen")];
    const { parent, codeByLayer } = planImportCategories(
      ["01421", "01422"],
      existing,
      "Import Luzern",
      { "01421": "#ff0000" },
    );
    expect(parent?.name).toBe("Import Luzern");
    expect(parent?.children?.map((c) => c.name)).toEqual(["01421", "01422"]);
    expect(parent?.children?.[0].color).toBe("#ff0000");
    // Codes laufen hinter dem grössten bestehenden weiter und sind eindeutig.
    const codes = [parent!.code, ...parent!.children!.map((c) => c.code)];
    expect(new Set(codes).size).toBe(3);
    expect(codes.every((c) => parseInt(c, 10) > 90)).toBe(true);
    expect(codeByLayer.get("01421")).toBe(parent!.children![0].code);
  });

  it("nutzt bestehende gleichnamige Kategorien (case-insensitiv, auch verschachtelt)", () => {
    const existing = [cat("05", "Kontext", [cat("10", "Situation")])];
    const { parent, codeByLayer } = planImportCategories(["SITUATION"], existing, "Import");
    expect(parent).toBeNull();
    expect(codeByLayer.get("SITUATION")).toBe("10");
  });

  it("teilt sich eine Kategorie bei Layern, die sich nur in der Schreibweise unterscheiden", () => {
    const { parent, codeByLayer } = planImportCategories(["Gebaeude", "GEBAEUDE"], [], "Import");
    expect(parent?.children).toHaveLength(1);
    expect(codeByLayer.get("Gebaeude")).toBe(codeByLayer.get("GEBAEUDE"));
  });

  it("legt nichts an, wenn keine Layer vorhanden sind", () => {
    expect(planImportCategories([], [cat("20", "Wände")], "Import").parent).toBeNull();
  });
});
