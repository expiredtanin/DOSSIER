import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../i18n/translate";
import { withNewProjectNames } from "./newProjectNames";
import { emptyProject } from "./sampleProject";
import { flattenCategories } from "./layers";

afterEach(() => setLanguage("de"));

describe("[264] Vorgaben eines neuen Projekts in der UI-Sprache", () => {
  it("Deutsch: bleibt wie das Leere Projekt", () => {
    const p = withNewProjectNames(emptyProject);
    expect(p.name).toBe("Leeres Projekt");
    expect(p.drawingLevels.map((l) => l.name)).toEqual(emptyProject.drawingLevels.map((l) => l.name));
    expect(p.layers).toEqual(emptyProject.layers);
  });

  it("English: Projekt, Geschosse, Schnitt, Ansicht und Ebenen englisch; Kennungen und Codes bleiben", () => {
    setLanguage("en");
    const p = withNewProjectNames(emptyProject);
    expect(p.name).toBe("Empty project");
    const names = Object.fromEntries(p.drawingLevels.map((l) => [l.id, l.name]));
    expect(names).toMatchObject({ eg: "Ground floor", og: "First floor", "schnitt-a": "Section A", "ansicht-sued": "Elevation South" });
    const flat = flattenCategories(p.layers);
    expect(flat.find((c) => c.code === "20")?.name).toBe("Walls");
    expect(flat.find((c) => c.code === "22")?.name).toBe("Furniture");
    expect(flat.map((c) => c.code)).toEqual(flattenCategories(emptyProject.layers).map((c) => c.code));
    expect(p.drawingLevels.map((l) => l.id)).toEqual(emptyProject.drawingLevels.map((l) => l.id));
  });

  it("jeder Ebenencode des Vorgabeprojekts hat einen Namen in beiden Sprachen", () => {
    const codes = flattenCategories(emptyProject.layers).map((c) => c.code);
    for (const lang of ["de", "en"] as const) {
      setLanguage(lang);
      const names = flattenCategories(withNewProjectNames(emptyProject).layers);
      for (const c of codes) expect(names.find((n) => n.code === c)?.name).not.toMatch(/^newProject/);
    }
  });
});
