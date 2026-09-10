// `deriveSelection` für ein selektiertes Kontext-Objekt-Luftbild
// (`ContextImage`) muss `isImage`/`opacity`/`imageFilters` setzen, damit
// AttributesPanel.tsx seine (mit Drawing2D-Bildern geteilte) Deckkraft-Zeile
// + die neue Bildkorrektur-Sektion anzeigt (s. PENDENZEN.md „Bildschraffur:
// Bild-Filter"). `selectionInfo.ts` hatte bislang KEINE Tests — dieser Fokus-
// Test deckt nur den neuen Pfad ab, keine vollständige Modul-Abdeckung.

import { describe, it, expect } from "vitest";
import { deriveSelection } from "./selectionInfo";
import type { Project } from "../model/types";

function projectWith(context: Project["context"]): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [],
    walls: [],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context,
  } as unknown as Project;
}

describe("deriveSelection — Kontext-Objekt-Luftbild (ContextImage)", () => {
  it("setzt isImage/opacity/imageFilters für ein Luftbild mit Filtern", () => {
    const project = projectWith([
      {
        id: "IMG1",
        type: "image",
        name: "Luftbild",
        src: "data:image/jpeg;base64,AAAA",
        min: { x: 0, y: 0 },
        max: { x: 10, y: 10 },
        opacity: 0.8,
        filters: { saturation: 0.5, brightness: 1.1, contrast: 1, grayscale: 0.2 },
      },
    ]);
    const sel = deriveSelection(project, [], null, null, null, null, null, null, null, null, "IMG1");
    expect(sel?.kind).toBe("contextObject");
    expect(sel?.isImage).toBe(true);
    expect(sel?.opacity).toBe(0.8);
    expect(sel?.imageFilters).toEqual({ saturation: 0.5, brightness: 1.1, contrast: 1, grayscale: 0.2 });
  });

  it("opacity fällt auf 1 zurück, wenn das Bild keine eigene Deckkraft trägt", () => {
    const project = projectWith([
      { id: "IMG1", type: "image", name: "Luftbild", src: "x", min: { x: 0, y: 0 }, max: { x: 1, y: 1 } },
    ]);
    const sel = deriveSelection(project, [], null, null, null, null, null, null, null, null, "IMG1");
    expect(sel?.opacity).toBe(1);
    expect(sel?.imageFilters).toBeUndefined();
  });

  it("isImage bleibt false/undefined für ein Nicht-Bild-Kontext-Objekt (z. B. importiertes Mesh)", () => {
    const project = projectWith([
      { id: "M1", type: "importedMesh", name: "Haus", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
    ]);
    const sel = deriveSelection(project, [], null, null, null, null, null, null, null, null, "M1");
    expect(sel?.isImage).toBeFalsy();
    expect(sel?.opacity).toBeUndefined();
    expect(sel?.imageFilters).toBeUndefined();
  });
});
