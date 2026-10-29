import { describe, expect, it } from "vitest";
import { sampleProject } from "./sampleProject";
import type { DrawingLevel, LayerCategory } from "./types";
import {
  addChildByCode,
  applyVisibilityByCode,
  categoryLabel,
  collectVisibleCodes,
  findCategory,
  flattenCategories,
  insertAfterCode,
  nextFreeCode,
  patchCategoryByCode,
  planImportLayers,
  recomputeFloorElevations,
  removeCategoryByCode,
  toggleCategoryByCode,
} from "./layers";

const cat = (code: string, name: string, visible = true, children?: LayerCategory[]): LayerCategory => ({
  code, name, color: "#000", lw: 0.2, visible, locked: false, ...(children ? { children } : {}),
});
const tree = () => [cat("20", "Wände"), cat("05", "Import", true, [cat("100", "a"), cat("101", "b", false)])];
const codes = (t: LayerCategory[]) => flattenCategories(t).map((c) => c.code);

describe("Kategorie-Baum (Kern)", () => {
  it("flach, suchen, sichtbare Codes, Beschriftung", () => {
    const t = tree();
    expect(codes(t)).toEqual(["20", "05", "100", "101"]);
    expect(findCategory(t, "101")?.name).toBe("b");
    expect(findCategory(t, "x")).toBeUndefined();
    expect([...collectVisibleCodes(t)]).toEqual(["20", "05", "100"]);
    expect(categoryLabel(t, "20")).toBe("20 Wände");
    expect(categoryLabel(t, "zz")).toBe("zz");
  });

  it("Umschalten, Sichtbarkeit nach Codes, Ändern, Unterkategorie, Entfernen", () => {
    const t = tree();
    expect(findCategory(toggleCategoryByCode(t, "101"), "101")?.visible).toBe(true);
    expect(findCategory(applyVisibilityByCode(t, { "20": false, nix: true }), "20")?.visible).toBe(false);
    expect(findCategory(patchCategoryByCode(t, "100", { name: "neu", hatch: undefined }), "100")?.name).toBe("neu");
    expect(findCategory(addChildByCode(t, "20", cat("21", "k")), "20")?.children?.[0].code).toBe("21");
    expect(codes(removeCategoryByCode(t, "05"))).toEqual(["20"]);
    expect(t[1].children?.length).toBe(2); // Eingabe unverändert
  });

  it("Duplikat direkt nach dem Original, auch bei Unterkategorien", () => {
    expect(codes(insertAfterCode(tree(), "20", cat("22", "c")))).toEqual(["20", "22", "05", "100", "101"]);
    expect(codes(insertAfterCode(tree(), "100", cat("102", "c")))).toEqual(["20", "05", "100", "102", "101"]);
  });

  it("nächster freier Code", () => {
    expect(nextFreeCode([])).toBe("01");
    expect(nextFreeCode(tree())).toBe("102");
  });

  it("Import-Layer: bestehende Namen (case-insensitiv) behalten ihren Code", () => {
    const r = planImportLayers(["wände", "Neu", "NEU"], tree(), { Neu: "#123" }, {});
    expect(r.children).toHaveLength(1);
    expect(r.children[0]).toMatchObject({ code: "102", name: "Neu", color: "#123", lw: 0.18 });
    expect(r.parentCode).toBe("103");
    expect([...r.codeByLayer]).toEqual([["wände", "20"], ["Neu", "102"], ["NEU", "102"]]);
  });
});

describe("Geschoss-Stapelung (Kern)", () => {
  it("stapelt floorHeight, Nicht-Geschosse verlieren baseElevation", () => {
    const l = [
      { id: "a", name: "A", kind: "floor", visible: true, locked: false, floorHeight: 2.6, baseElevation: 9 },
      { id: "s", name: "S", kind: "section", visible: true, locked: false, baseElevation: 1 },
      { id: "b", name: "B", kind: "floor", visible: true, locked: false, floorHeight: 3 },
    ] as DrawingLevel[];
    const r = recomputeFloorElevations(l);
    expect(r.map((x) => x.baseElevation)).toEqual([0, undefined, 2.6]);
    expect(l[0].baseElevation).toBe(9);
  });

  it("Musterprojekt trägt die gestapelten Höhen ausgeschrieben (Modul wird vor dem Kern geladen)", () => {
    expect(recomputeFloorElevations(sampleProject.drawingLevels)).toEqual(sampleProject.drawingLevels);
  });
});
