// Kontext-Objekt-Auswahl: deriveSelection liefert für ein selektiertes
// Kontext-Objekt (importiertes Mesh/Terrain/Konturen) Bbox + reale LV95-
// Koordinate (falls project.geoAnchor gesetzt) — s. Nutzer-Wunsch, direkt im
// Object-Info-Panel prüfen zu können, ob/wohin georeferenziert importiert wurde.

import { describe, it, expect } from "vitest";
import { deriveSelection } from "./selectionInfo";
import type { Project } from "../model/types";

const baseProject = {
  id: "p",
  name: "T",
  layers: [],
  drawingLevels: [
    { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, baseElevation: 0 },
  ],
  walls: [],
  drawings2d: [],
};

describe("deriveSelection — Kontext-Objekt", () => {
  it("importedMesh: Bbox aus x/y (Höhe z ignoriert), ohne geoAnchor kein lv95Center", () => {
    const project = {
      ...baseProject,
      context: [
        {
          id: "CTX1",
          type: "importedMesh",
          name: "Test",
          positions: [0, 0, 5, 10, 6, 8, 4, 3, 2],
          indices: [0, 1, 2],
        },
      ],
    } as unknown as Project;
    const sel = deriveSelection(project, [], null, null, null, null, null, null, null, null, "CTX1");
    expect(sel?.kind).toBe("contextObject");
    expect(sel?.id).toBe("CTX1");
    expect(sel?.bbox).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 6 });
    expect(sel?.contextObject?.objType).toBe("importedMesh");
    expect(sel?.contextObject?.lv95Center).toBeUndefined();
  });

  it("mit geoAnchor: lv95Center = Bbox-Mittelpunkt zurückgerechnet auf LV95", () => {
    const project = {
      ...baseProject,
      geoAnchor: { lv95: { e: 2600000, n: 1200000 }, model: { x: 0, y: 0 } },
      context: [
        {
          id: "CTX1",
          type: "importedMesh",
          name: "Test",
          positions: [0, 0, 0, 100, 50, 0],
          indices: [0, 1, 0],
        },
      ],
    } as unknown as Project;
    const sel = deriveSelection(project, [], null, null, null, null, null, null, null, null, "CTX1");
    // Bbox-Mittelpunkt (50,25) -> LV95 = origin + Mittelpunkt (origin = lv95 - model = lv95, model (0,0)).
    expect(sel?.contextObject?.lv95Center).toEqual({ e: 2600050, n: 1200025 });
  });

  it("mit geoAnchor.model != (0,0): Origin korrekt berücksichtigt", () => {
    const project = {
      ...baseProject,
      geoAnchor: { lv95: { e: 2600000, n: 1200000 }, model: { x: 500, y: 300 } },
      context: [
        {
          id: "CTX1",
          type: "importedMesh",
          name: "Test",
          positions: [500, 300, 0],
          indices: [0, 0, 0],
        },
      ],
    } as unknown as Project;
    const sel = deriveSelection(project, [], null, null, null, null, null, null, null, null, "CTX1");
    // Der Modellpunkt (500,300) IST der Anker -> muss exakt auf lv95 (2600000,1200000) zurückrechnen.
    expect(sel?.contextObject?.lv95Center).toEqual({ e: 2600000, n: 1200000 });
  });

  it("contourSet: Bbox aus contours[].pts statt positions", () => {
    const project = {
      ...baseProject,
      context: [
        {
          id: "CS1",
          type: "contourSet",
          name: "Höhenlinien",
          contours: [
            { z: 400, pts: [{ x: -5, y: 2 }, { x: 8, y: -3 }], closed: false },
          ],
        },
      ],
    } as unknown as Project;
    const sel = deriveSelection(project, [], null, null, null, null, null, null, null, null, "CS1");
    expect(sel?.contextObject?.objType).toBe("contourSet");
    expect(sel?.bbox).toEqual({ minX: -5, minY: -3, maxX: 8, maxY: 2 });
  });

  it("unbekannte Id -> null", () => {
    const project = { ...baseProject, context: [] } as unknown as Project;
    expect(deriveSelection(project, [], null, null, null, null, null, null, null, null, "does-not-exist")).toBeNull();
  });

  it("keine Kontext-Auswahl (null) -> fällt durch zu anderen Kanälen (hier auch leer -> null)", () => {
    const project = { ...baseProject, context: [] } as unknown as Project;
    expect(deriveSelection(project, [], null)).toBeNull();
  });
});
