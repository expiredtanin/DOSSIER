// Ressourcen, Stifte/Paletten, Text-Stile, Kontext-Schicht und 3D-Griffe laufen über Ops ([K4] S3):
// jede Aktion = genau ein Undo-Schritt, Ergebnis wie erwartet. Beim Umbau wurden 37 Schritte dieser Aktionen
// gegen die alte setProject-Fassung (git HEAD) verglichen: Projekt, Undo-Tiefe und Meldungen gleich.
import { beforeEach, describe, expect, it } from "vitest";
import { getState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import type { ContextObject, Project } from "../model/types";

const st = () => getState();

beforeEach(() => {
  const p: Project = {
    ...structuredClone(sampleProject),
    components: sampleProject.components.map((c, i) => (i === 0 ? { ...c, colorPenId: "p1" } : c)),
    walls: sampleProject.walls.map((w, i) => (i === 0 ? { ...w, colorPenId: "p1" } : w)),
  };
  st().setProject(p);
  st().clearHistory();
});

/** Eine Aktion → ein Undo-Schritt; Undo stellt das Projekt exakt wieder her. */
function oneStep(label: string, act: () => void): void {
  const before = st().project;
  const depth = st().undoDepth;
  act();
  expect(st().undoDepth, label).toBe(depth + 1);
  st().undo();
  expect(JSON.parse(JSON.stringify(st().project)), label).toEqual(JSON.parse(JSON.stringify(before)));
  st().redo();
}

describe("Ressourcen und Stiftsätze über Ops", () => {
  it("Bauteile, Schraffuren, Linienstile: anlegen, ändern, geschütztes Löschen", () => {
    const c0 = st().project.components[0].id;
    const h0 = st().project.hatches[0].id;
    oneStep("patchComponent", () => st().patchComponent(c0, { name: "X" }));
    expect(st().project.components[0].name).toBe("X");
    oneStep("addComponent", () => st().addComponent());
    expect(st().project.components).toHaveLength(sampleProject.components.length + 1);
    // Von einer Wandart verwendetes Bauteil: Meldung, keine Änderung, kein Undo-Schritt.
    const depth = st().undoDepth;
    st().deleteComponent(c0);
    expect(st().undoDepth).toBe(depth);
    oneStep("addHatch", () => st().addHatch());
    oneStep("patchHatch", () => st().patchHatch(h0, { scale: 3 }));
    oneStep("addLineStyle", () => st().addLineStyle());
    oneStep("importHatches", () => st().importHatches([{ name: "H", pattern: "diagonal", scale: 1, angle: 0, color: "#000" }]));
  });

  it("Text-Stile: die Vorgaben werden beim ersten Ändern ins Projekt übernommen", () => {
    expect(st().project.textStyles).toBeUndefined();
    oneStep("addTextStyle", () => st().addTextStyle());
    expect(st().project.textStyles!.length).toBeGreaterThan(1);
    const id = st().project.textStyles![0].id;
    oneStep("patchTextStyle", () => st().patchTextStyle(id, { label: "Neu" }));
    expect(st().project.textStyles![0].label).toBe("Neu");
  });

  it("Stifte: Stift anlegen, Stiftsatz aktivieren und Farbe ändern bäckt die Farben ein", () => {
    oneStep("addPen", () => st().addPen());
    oneStep("addPenSet", () => st().addPenSet());
    const setId = st().project.penSets![0].id;
    expect(st().project.activePenSetId).toBe(setId); // erster Satz wird aktiv
    oneStep("patchPenSetColor", () => st().patchPenSetColor(setId, "p1", "#123456"));
    // Bauteil und Wand mit `colorPenId: "p1"` tragen jetzt die gebackene Farbe — in einem Schritt.
    expect(st().project.components[0].color).toBe("#123456");
    expect(st().project.walls[0].color).toBe("#123456");
    oneStep("patchPenSetWeight", () => st().patchPenSetWeight(setId, "p1", 0.7));
    expect(st().project.walls[0].strokeWeight).toBe(0.7);
    oneStep("addPenSet 2", () => st().addPenSet());
    const set2 = st().project.penSets![1].id;
    oneStep("patchPenSetColor inaktiv", () => st().patchPenSetColor(set2, "p1", "#abcdef"));
    expect(st().project.walls[0].color).toBe("#123456"); // aktiver Satz unverändert
    oneStep("setActivePenSet", () => st().setActivePenSet(set2));
    expect(st().project.walls[0].color).toBe("#abcdef");
    // Aktiver Satz ist geschützt.
    const depth = st().undoDepth;
    st().deletePenSet(set2);
    expect(st().undoDepth).toBe(depth);
    oneStep("deletePen", () => st().deletePen("p1"));
    expect(st().project.components[0].colorPenId).toBeUndefined(); // Verweis gelöst, Farbe bleibt
    oneStep("seedStandardPenSet", () => st().seedStandardPenSet());
    expect(st().project.pens).toHaveLength(255);
  });

  it("Farbpaletten", () => {
    oneStep("addCustomPalette", () => st().addCustomPalette());
    const id = st().project.customPalettes![0].id;
    oneStep("addColor", () => st().addColorToCustomPalette(id, "#ff0000"));
    oneStep("addColor 2", () => st().addColorToCustomPalette(id, "#00ff00"));
    oneStep("addColor Duplikat", () => st().addColorToCustomPalette(id, "#FF0000"));
    expect(st().project.customPalettes![0].colors).toEqual(["#FF0000", "#00ff00"]);
    oneStep("addColor neue Palette", () => st().addColorToCustomPalette(undefined, "#0000ff"));
    expect(st().project.customPalettes).toHaveLength(2);
    oneStep("removeColor", () => st().removeColorFromCustomPalette(id, "#00ff00"));
    oneStep("builtin", () => st().setBuiltinPaletteVisible("ral", false));
    expect(st().project.builtinPaletteBanks).toMatchObject({ ral: false });
  });
});

describe("Kontext-Schicht über Ops", () => {
  const mesh = (id: string, categoryCode: string): ContextObject =>
    ({ id, type: "importedMesh", name: id, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], categoryCode }) as unknown as ContextObject;

  it("Hinzufügen ergänzt fehlende Kategorien, Entfernen und Leeren je ein Schritt", () => {
    const codes = (p: Project) => JSON.stringify(p.layers);
    const before = codes(st().project);
    oneStep("addContextObjects", () => st().addContextObjects([mesh("m1", "15"), mesh("m2", "15")]));
    expect(st().project.context!.map((o) => o.id)).toEqual(["m1", "m2"]);
    expect(codes(st().project)).not.toBe(before);
    oneStep("removeContextObject", () => st().removeContextObject("m1"));
    expect(st().project.context!.map((o) => o.id)).toEqual(["m2"]);
    oneStep("removeContextObjects", () => st().removeContextObjects(["m2"]));
    expect(st().project.context).toEqual([]);
  });
});

describe("3D-Griffe: Element und mitgeführte Ecken", () => {
  it("ein Zug mit mehreren Maus-Schritten = ein Undo-Schritt (Gruppe mit Schlüssel)", () => {
    const [a, b] = st().project.walls;
    const depth = st().undoDepth;
    for (let k = 1; k <= 6; k++) {
      st().groupChanges(() => {
        st().moveGripOf(null, a.id, 1, { x: a.end.x + k * 0.1, y: a.end.y });
        st().moveGripOf(null, b.id, 0, { x: a.end.x + k * 0.1, y: a.end.y });
      }, `grip3d:${a.id}:1`);
    }
    expect(st().undoDepth).toBe(depth + 1);
    expect(st().project.walls[0].end.x).toBeCloseTo(a.end.x + 0.6, 12);
    expect(st().project.walls[1].start.x).toBeCloseTo(a.end.x + 0.6, 12);
    st().undo();
    expect(st().project.walls[0].end).toEqual(a.end);
    expect(st().project.walls[1].start).toEqual(b.start);
  });
});
