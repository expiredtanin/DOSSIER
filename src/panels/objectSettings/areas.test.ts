// [195] Bereichs-Zuordnung des Objekteinstellungs-Fensters je Elementart.
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../../model/sampleProjectComplex";
import { deriveSelection } from "../../state/selectionInfo";
import { settingsAreas } from "./areas";

const p = buildComplexSampleProject();
const none = { otherSelected: false };

describe("Bereiche des Objekteinstellungs-Fensters [195]", () => {
  it("jedes Bauteil im Beispielprojekt: Objekt + Darstellung", () => {
    const cases: [string, string, string | undefined][] = [
      ["Wand", "walls", p.walls[0]?.id],
      ["Decke", "ceilings", p.ceilings?.[0]?.id],
      ["Dach", "roofs", p.roofs?.[0]?.id],
      ["Treppe", "stairs", p.stairs?.[0]?.id],
      ["Stütze", "columns", p.columns?.[0]?.id],
      ["Öffnung", "openings", p.openings?.[0]?.id],
      ["Raum", "rooms", p.rooms?.[0]?.id],
      ["Körper", "solids", p.extrudedSolids?.[0]?.id],
      ["Gelände/Kontext", "contextObjects", p.context?.[0]?.id],
      ["2D-Zeichnung", "drawings", p.drawings2d[0]?.id],
    ];
    let seen = 0;
    for (const [name, kind, id] of cases) {
      if (!id) continue; // Beispielprojekt ohne dieses Element
      const sel = deriveSelection(p, { [kind]: [id] });
      if (!sel) continue;
      seen++;
      expect(settingsAreas({ sel, ...none }), name).toEqual(["object", "appearance"]);
    }
    expect(seen).toBeGreaterThan(4);
  });

  it("Achsraster und Bemassung (2D) tragen beide Bereiche", () => {
    const grid = p.drawings2d.find((d) => d.geom.shape === "grid");
    const dim = p.drawings2d.find((d) => d.geom.shape === "dimension");
    for (const d of [grid, dim]) {
      if (!d) continue;
      const sel = deriveSelection(p, { drawings: [d.id] });
      expect(settingsAreas({ sel, isGrid: d.geom.shape === "grid", ...none })).toEqual(["object", "appearance"]);
    }
  });

  it("Schnittlinie, Baum/Lage und Werkzeug-Voreinstellung: nur Objekt", () => {
    expect(settingsAreas({ sel: null, otherSelected: false, sectionLine: true })).toEqual(["object"]);
    expect(settingsAreas({ sel: null, otherSelected: true })).toEqual(["object"]);
    expect(settingsAreas({ sel: null, otherSelected: false, newComponentTool: true })).toEqual(["object"]);
  });

  it("ohne Auswahl: keine Bereiche", () => {
    expect(settingsAreas({ sel: null, ...none })).toEqual([]);
  });
});
