/**
 * Store-Actions für benutzerdefinierte Farbpaletten (`model/types.ts::
 * CustomPalette`, Farbmischer → „Diese Farbe speichern"). Reine CRUD ohne
 * Baking-/Aktiv-Semantik (anders als Stiftsätze) — hier geht es nur um
 * Anlegen/Umbenennen/Löschen sowie das Hinzufügen/Entfernen einzelner
 * Farben inkl. Dedupe- und Auto-Anlegen-Verhalten.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";

let clock = 0;
beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock++);
  setState({
    project: { ...sampleProject, components: sampleProject.components.slice(0, 1), customPalettes: [] },
    undoDepth: 0,
    redoDepth: 0,
    canUndo: false,
    canRedo: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("addCustomPalette", () => {
  it("legt eine neue, leere Palette mit Default-Namen an", () => {
    getState().addCustomPalette();
    const palettes = getState().project.customPalettes!;
    expect(palettes.length).toBe(1);
    expect(palettes[0].colors).toEqual([]);
    expect(palettes[0].name.length).toBeGreaterThan(0);
  });

  it("mehrere Paletten können nebeneinander existieren", () => {
    getState().addCustomPalette();
    getState().addCustomPalette();
    expect(getState().project.customPalettes!.length).toBe(2);
  });
});

describe("renameCustomPalette/deleteCustomPalette", () => {
  it("benennt genau die angegebene Palette um", () => {
    getState().addCustomPalette();
    getState().addCustomPalette();
    const [a, b] = getState().project.customPalettes!;
    getState().renameCustomPalette(a.id, "Fassade");
    const after = getState().project.customPalettes!;
    expect(after.find((p) => p.id === a.id)?.name).toBe("Fassade");
    expect(after.find((p) => p.id === b.id)?.name).toBe(b.name);
  });

  it("löscht genau die angegebene Palette", () => {
    getState().addCustomPalette();
    getState().addCustomPalette();
    const [a, b] = getState().project.customPalettes!;
    getState().deleteCustomPalette(a.id);
    const after = getState().project.customPalettes!;
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(b.id);
  });
});

describe("addColorToCustomPalette", () => {
  it("legt automatisch eine Palette an, wenn keine `paletteId` passt", () => {
    getState().addColorToCustomPalette(undefined, "#ff0000");
    const palettes = getState().project.customPalettes!;
    expect(palettes.length).toBe(1);
    expect(palettes[0].colors).toEqual(["#ff0000"]);
  });

  it("fügt neue Farben VORNE ein (zuletzt gespeichert zuerst)", () => {
    getState().addCustomPalette();
    const id = getState().project.customPalettes![0].id;
    getState().addColorToCustomPalette(id, "#ff0000");
    getState().addColorToCustomPalette(id, "#00ff00");
    expect(getState().project.customPalettes![0].colors).toEqual(["#00ff00", "#ff0000"]);
  });

  it("dedupliziert case-insensitive: erneutes Speichern verschiebt nur nach vorn", () => {
    getState().addCustomPalette();
    const id = getState().project.customPalettes![0].id;
    getState().addColorToCustomPalette(id, "#ff0000");
    getState().addColorToCustomPalette(id, "#00ff00");
    getState().addColorToCustomPalette(id, "#FF0000");
    const colors = getState().project.customPalettes![0].colors;
    expect(colors).toEqual(["#FF0000", "#00ff00"]);
  });
});

describe("removeColorFromCustomPalette", () => {
  it("entfernt genau die angegebene Farbe (case-insensitive)", () => {
    getState().addCustomPalette();
    const id = getState().project.customPalettes![0].id;
    getState().addColorToCustomPalette(id, "#ff0000");
    getState().addColorToCustomPalette(id, "#00ff00");
    getState().removeColorFromCustomPalette(id, "#FF0000");
    expect(getState().project.customPalettes![0].colors).toEqual(["#00ff00"]);
  });
});

describe("Sichtbarkeit (Farbwahl-Popover)", () => {
  it("setCustomPaletteVisible blendet genau eine eigene Palette aus/ein", () => {
    getState().addCustomPalette();
    const id = getState().project.customPalettes![0].id;
    // Default: Feld fehlt ⇒ gilt als sichtbar (Bestandsprojekte unverändert).
    expect(getState().project.customPalettes![0].visible).toBeUndefined();
    getState().setCustomPaletteVisible(id, false);
    expect(getState().project.customPalettes![0].visible).toBe(false);
    getState().setCustomPaletteVisible(id, true);
    expect(getState().project.customPalettes![0].visible).toBe(true);
  });

  it("setBuiltinPaletteVisible schaltet einzelne Bänke, ohne die anderen anzufassen", () => {
    getState().setBuiltinPaletteVisible("ral", false);
    expect(getState().project.builtinPaletteBanks).toEqual({ ral: false });
    getState().setBuiltinPaletteVisible("tango", false);
    expect(getState().project.builtinPaletteBanks).toEqual({ ral: false, tango: false });
    getState().setBuiltinPaletteVisible("ral", true);
    expect(getState().project.builtinPaletteBanks).toEqual({ ral: true, tango: false });
  });
});
