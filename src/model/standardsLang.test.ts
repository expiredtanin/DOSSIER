import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../i18n/translate";
import { withNewProjectNames } from "./newProjectNames";
import { emptyProject } from "./sampleProject";
import { standardsMergeOps, standardsUpdatePlan, withStandards } from "./standards";
import { flattenCategories } from "./layers";

afterEach(() => setLanguage("de"));

const nameOf = (list: { id: string; name: string }[] | undefined, id: string) => list?.find((x) => x.id === id)?.name;

describe("[264] Standards eines neuen Projekts in der Oberflächensprache", () => {
  it("Deutsch: unverändert (Standardnamen deutsch)", () => {
    expect(withNewProjectNames(emptyProject)).toEqual(emptyProject);
    const p = withStandards(withNewProjectNames(emptyProject));
    expect(nameOf(p.components, "std-c-stahlbeton")).toBe("Stahlbeton");
    expect(nameOf(p.wallTypes, "std-wt-aw-kompakt")).toBe("Aussenwand verputzt, Aussendämmung 18 cm");
    expect(nameOf(p.viewTemplates, "std-vt-eingabe-100")).toBe("Eingabeplan 1:100");
    expect(flattenCategories(p.layers).find((c) => c.code === "23")?.name).toBe("Sanitär");
  });

  it("English: Typen, Vorlagen, Baustoffe, Schraffuren, Modelldarstellungen und Klassen englisch, Kennungen gleich", () => {
    setLanguage("en");
    const p = withStandards(withNewProjectNames(emptyProject));
    expect(nameOf(p.components, "std-c-stahlbeton")).toBe("Reinforced concrete");
    expect(nameOf(p.components, "std-c-mineralwolle")).toBe("Mineral wool");
    expect(nameOf(p.wallTypes, "std-wt-aw-kompakt")).toBe("Exterior wall, rendered, 18 cm external insulation");
    expect(nameOf(p.ceilingTypes, "std-ct-stb-estrich")).toMatch(/^Reinforced concrete slab/);
    expect(nameOf(p.roofTypes, "std-rt-steildach-holz")).toBe("Pitched roof, timber, insulated");
    expect(nameOf(p.viewTemplates, "std-vt-eingabe-100")).toBe("Permit drawing 1:100");
    expect(nameOf(p.modelViewOptions, "std-mv-wettbewerb-200")).toBe("Competition 1:200");
    expect(nameOf(p.hatches, "std-h-stahlbeton")).toBe("SIA Reinforced concrete");
    expect(nameOf(p.lineStyles, "std-ls-strich-fein")).toBe("Dashed line");
    expect(nameOf(p.lineStyles, "thin")).toBe("Continuous line");
    expect(nameOf(p.wallTypes, "aw")).toBe("Exterior wall 34.5 cm");
    expect(nameOf(p.windowTypes, "window-standard")).toBe("Window 1.2 × 1.4 m");
    const flat = flattenCategories(p.layers);
    expect(flat.find((c) => c.code === "23")?.name).toBe("Sanitary");
    expect(flat.find((c) => c.code === "24")?.name).toBe("Vehicles & outdoor");
    expect(flat.find((c) => c.code === "65")?.name).toBe("Lighting");
    expect(flat.find((c) => c.code === "20")?.name).toBe("Walls");
    // Kein deutscher Name übrig.
    const all: { name: string }[] = [...(p.doorTypes ?? []), ...(p.windowTypes ?? []), ...(p.stairTypes ?? []), ...(p.components ?? []), ...(p.wallTypes ?? []), ...(p.ceilingTypes ?? []), ...(p.roofTypes ?? []), ...(p.viewTemplates ?? []), ...(p.modelViewOptions ?? []), ...(p.hatches ?? []), ...(p.lineStyles ?? [])];
    expect(all.filter((x) => /[äöüÄÖÜ]|Aussen|Wand\b|Schraffur/.test(x.name)).map((x) => x.name)).toEqual([]);
  });

  it("beide Sprachen: gleiche Kennungen und kein Duplikat beim zweiten Laden oder Wechsel der Sprache", () => {
    const de = withStandards(withNewProjectNames(emptyProject));
    setLanguage("en");
    const en = withStandards(withNewProjectNames(emptyProject));
    expect(en.components?.map((c) => c.id)).toEqual(de.components?.map((c) => c.id));
    expect(standardsMergeOps(en)).toEqual([]);
    // Deutsches Projekt in englischer Oberfläche: nichts nachzuladen, nichts „umbenannt“.
    expect(standardsMergeOps(de)).toEqual([]);
    expect(standardsUpdatePlan(en).changes.every((c) => !c.renamed)).toBe(true);
  });

  it("Beispielprojekte bleiben deutsch, auch in englischer Oberfläche", () => {
    setLanguage("en");
    const p = withStandards(emptyProject, "de");
    expect(nameOf(p.components, "std-c-stahlbeton")).toBe("Stahlbeton");
  });
});
