// [189] Zuordnung der Panels: Attribute zeigen nur Gestaltung, alles Bauteil-/BIM-Bezogene gehört in die Objekt-Info;
// Taste T öffnet für Fenster/Türen den Öffnungs-Dialog, sonst den passenden Abschnitt der Objekt-Info.

import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../../model/sampleProjectComplex";
import { deriveSelection } from "../../state/selectionInfo";
import { attrGroups, infoGroups, objectSettingsTarget, INFO_GROUP_TITLE, type InfoGroupId } from "./groups";

const p = buildComplexSampleProject();
const ctx = { isGrid: false, sectionLine: false, newComponentTool: false };

describe("Panel-Zuordnung [189]", () => {
  it("Wand: Gestaltung in Attribute, Typ/Aufbau/Ansichtsschraffur in der Objekt-Info", () => {
    const sel = deriveSelection(p, { walls: [p.walls[0].id] });
    expect(sel?.wall).toBeTruthy();
    expect(attrGroups({ sel, openEnds: false, isDimension: false })).toEqual(["stroke", "fill"]);
    expect(infoGroups({ sel, ...ctx })).toEqual(["wall", "surfacePattern"]);
  });

  it("Fenster/Tür: nur die Objekt-Info trägt den Öffnungs-Abschnitt", () => {
    const sel = deriveSelection(p, { openings: [p.openings![0].id] });
    expect(infoGroups({ sel, ...ctx })).toEqual(["opening", "openingEditor"]);
  });

  it("Decke, Raum, Treppe, Dach: je ein eigener Abschnitt der Objekt-Info", () => {
    const cases: [string, Partial<Parameters<typeof deriveSelection>[1]>, InfoGroupId][] = [
      ["Decke", { ceilings: [p.ceilings?.[0].id] }, "ceiling"],
      ["Raum", { rooms: [p.rooms?.[0].id] }, "room"],
      ["Treppe", { stairs: [p.stairs?.[0]?.id] }, "stair"],
      ["Dach", { roofs: [p.roofs?.[0]?.id] }, "roof"],
    ] as never;
    for (const [name, selection, group] of cases) {
      const sel = deriveSelection(p, selection);
      if (!sel) continue; // Beispielprojekt ohne dieses Element
      expect(infoGroups({ sel, ...ctx }), name).toContain(group);
    }
  });

  it("Attribute: ohne Auswahl nichts; Linienenden/Bemassung nur wo sie gelten", () => {
    expect(attrGroups({ sel: null, openEnds: true, isDimension: true })).toEqual([]);
    const sel = deriveSelection(p, { walls: [p.walls[0].id] });
    expect(attrGroups({ sel, openEnds: true, isDimension: false })).toEqual(["stroke", "ends", "fill"]);
    expect(attrGroups({ sel, openEnds: false, isDimension: true })).toEqual(["stroke", "dimension", "fill"]);
  });

  it("Werkzeug-Voreinstellung und Schnittlinie stehen ohne Auswahl in der Objekt-Info", () => {
    expect(infoGroups({ sel: null, isGrid: false, sectionLine: false, newComponentTool: true })).toEqual(["newComponent"]);
    expect(infoGroups({ sel: null, isGrid: false, sectionLine: true, newComponentTool: false })).toEqual(["sectionLine"]);
    expect(infoGroups({ sel: null, ...ctx })).toEqual([]);
  });

  it("jede Gruppe hat einen Titel", () => {
    const all: InfoGroupId[] = ["newComponent", "sectionLine", "wall", "ceiling", "roof", "surfacePattern", "opening", "openingEditor", "stair", "room", "roomStamp", "extrudedSolid", "column", "detailRef", "dimRefs", "dimText", "grid"];
    for (const g of all) expect(INFO_GROUP_TITLE[g]).toBeTruthy();
  });
});

describe("Taste T: Ziel [189]", () => {
  it("Fenster/Tür öffnet den Öffnungs-Abschnitt (kein eigener Dialog mehr, [195])", () => {
    const sel = deriveSelection(p, { openings: [p.openings![0].id] });
    expect(objectSettingsTarget(sel, "select")).toEqual({ group: "opening" });
  });

  it("Wand öffnet den Wand-Abschnitt der Objekt-Info", () => {
    const sel = deriveSelection(p, { walls: [p.walls[0].id] });
    expect(objectSettingsTarget(sel, "select")).toEqual({ group: "wall" });
  });

  it("ohne Auswahl: Wand-/Decken-Werkzeug → Typ des neuen Bauteils, sonst nichts", () => {
    expect(objectSettingsTarget(null, "wall")).toEqual({ group: "newComponent" });
    expect(objectSettingsTarget(null, "ceiling")).toEqual({ group: "newComponent" });
    expect(objectSettingsTarget(null, "select")).toBeNull();
    expect(objectSettingsTarget(null, "line")).toBeNull();
  });
});
