// Kontext-Schicht im Grundriss (generatePlan → addContextContours):
//   • ImportedMesh -> [152] im Geschoss nach Ansichtsbereich: Schnittfläche, Aufsicht (mesh-view), Überkopf gestrichelt.
//   • TerrainMesh -> nur 2D-Bounding-Box-Umriss (4 Linien).
//   • Nutzer-Report: importierte Gebäude waren im Plan UNSICHTBAR (nur 3D).

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
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
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context,
  } as unknown as Project;
}

const visible = new Set<string>();

function contextLines(p: Project) {
  return generatePlan(p, "eg", visible).primitives.filter(
    (pr) => pr.kind === "line" && (pr as { cls?: string }).cls === "context-line",
  );
}

/** [152] Aufsichts-/Überkopf-Linien importierter Netze im Geschoss. */
function meshLines(p: Project, codes: Set<string> = visible) {
  return generatePlan(p, "eg", codes).primitives.filter(
    (pr) => pr.kind === "line" && (pr as { cls?: string }).cls === "mesh-view",
  );
}

/** Quader [0..2]×[0..3]×[z0..z1] (12 Dreiecke, Aussennormalen). */
function box(z0: number, z1: number) {
  const positions: number[] = [];
  for (let k = 0; k < 8; k++) positions.push(k & 1 ? 2 : 0, k & 2 ? 3 : 0, k & 4 ? z1 : z0);
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const indices = quads.flatMap((q) => [q[0], q[1], q[2], q[0], q[2], q[3]]);
  return { positions, indices };
}

describe("generatePlan — importierte Netze im Grundriss ([152])", () => {
  it("ein Gebäude durch die Schnitthöhe wird geschnitten (Poché, anwählbar)", () => {
    const p = projectWith([{ id: "B1", type: "importedMesh", name: "Haus", ...box(0, 5) }]);
    const cut = generatePlan(p, "eg", visible).primitives.filter((pr) => pr.kind === "polygon" && pr.contextObjectId === "B1" && pr.fill !== "none");
    expect(cut).toHaveLength(1);
  });

  it("eine Fläche am Boden als Aufsicht, ohne Triangulations-Diagonale", () => {
    const p = projectWith([{ id: "B1", type: "importedMesh", name: "Platte", positions: [0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0], indices: [0, 1, 2, 0, 2, 3] }]);
    expect(meshLines(p)).toHaveLength(4);
  });

  it("ein Träger über der Schnitthöhe als gestrichelte Überkopf-Linie", () => {
    const p = projectWith([{ id: "T1", type: "importedMesh", name: "Träger", ...box(2.2, 2.4) }]);
    const lines = meshLines(p);
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.kind === "line" && Array.isArray(l.dash))).toBe(true);
  });

  it("ein Netz des Geschosses darüber erscheint nicht", () => {
    const p = projectWith([{ id: "O1", type: "importedMesh", name: "OG", ...box(2.6, 5) }]);
    expect(generatePlan(p, "eg", visible).primitives.filter((pr) => pr.kind === "polygon" && pr.contextObjectId === "O1")).toHaveLength(0);
  });
});

describe("generatePlan — Kontext-Objekte anklickbar (Pick-Region)", () => {
  it("importedMesh bekommt ein unsichtbares Bbox-Pick-Band mit contextObjectId", () => {
    const p = projectWith([
      {
        id: "B1",
        type: "importedMesh",
        name: "Haus",
        positions: [0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0],
        indices: [0, 1, 2, 0, 2, 3],
      },
    ]);
    const plan = generatePlan(p, "eg", visible);
    const pick = plan.primitives.find(
      (pr) => pr.kind === "polygon" && pr.contextObjectId === "B1",
    );
    expect(pick).toBeDefined();
    if (pick?.kind === "polygon") {
      expect(pick.fill).toBe("none");
      expect(pick.stroke).toBe("none");
      // Bbox der Grundfläche: [0..2]×[0..3].
      const xs = pick.pts.map((p) => p.x);
      const ys = pick.pts.map((p) => p.y);
      expect(Math.min(...xs)).toBe(0);
      expect(Math.max(...xs)).toBe(2);
      expect(Math.min(...ys)).toBe(0);
      expect(Math.max(...ys)).toBe(3);
    }
  });

  it("terrainMesh bekommt ebenfalls ein Pick-Band mit contextObjectId", () => {
    const p = projectWith([
      {
        id: "T1",
        type: "terrainMesh",
        name: "Gelände",
        positions: [0, 0, 400, 10, 0, 401, 5, 8, 402],
        indices: [0, 1, 2],
      },
    ]);
    const plan = generatePlan(p, "eg", visible);
    const pick = plan.primitives.find(
      (pr) => pr.kind === "polygon" && pr.contextObjectId === "T1",
    );
    expect(pick).toBeDefined();
  });
});

describe("generatePlan — Kontext-Umriss (TerrainMesh)", () => {
  it("zeichnet nur die 2D-Bounding-Box (4 Linien), nicht das ganze TIN", () => {
    // 3 Vertices spannen ein Dreieck; die Bbox-Ausdehnung ist [0..10]×[0..8].
    const p = projectWith([
      {
        id: "T1",
        type: "terrainMesh",
        name: "Gelände",
        positions: [0, 0, 400, 10, 0, 401, 5, 8, 402],
        indices: [0, 1, 2],
      },
    ]);
    const lines = contextLines(p);
    expect(lines.length).toBe(4);
    const xs = lines.flatMap((l) => (l.kind === "line" ? [l.a.x, l.b.x] : []));
    const ys = lines.flatMap((l) => (l.kind === "line" ? [l.a.y, l.b.y] : []));
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(10);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(8);
  });
});

describe("generatePlan — Luftbild (ContextImage)", () => {
  it("gibt georeferenzierte Bilder als backgroundImages aus (nicht als Primitive)", () => {
    const p = projectWith([
      {
        id: "IMG1",
        type: "image",
        name: "Luftbild",
        layer: "Luftbild",
        src: "data:image/jpeg;base64,AAAA",
        min: { x: -100, y: -80 },
        max: { x: 100, y: 80 },
      },
    ]);
    const plan = generatePlan(p, "eg", visible);
    expect(plan.backgroundImages).toHaveLength(1);
    expect(plan.backgroundImages![0]).toMatchObject({
      id: "IMG1",
      src: "data:image/jpeg;base64,AAAA",
      min: { x: -100, y: -80 },
      max: { x: 100, y: 80 },
      opacity: 1,
    });
    // Kein Bild-Primitiv in den Vektor-Primitiven (DXF/PDF lassen es aus).
    expect(plan.primitives.some((pr) => (pr as { kind?: string }).kind === "image")).toBe(false);
  });

  it("reicht `filters` (Sättigung/Helligkeit/Kontrast/Graustufen) unverändert durch", () => {
    const p = projectWith([
      {
        id: "IMG1",
        type: "image",
        name: "Luftbild",
        src: "data:image/jpeg;base64,AAAA",
        min: { x: 0, y: 0 },
        max: { x: 10, y: 10 },
        filters: { saturation: 0.4, brightness: 1.1, contrast: 1.2, grayscale: 0.6 },
      },
    ]);
    const plan = generatePlan(p, "eg", visible);
    expect(plan.backgroundImages![0].filters).toEqual({
      saturation: 0.4,
      brightness: 1.1,
      contrast: 1.2,
      grayscale: 0.6,
    });
  });

  it("`filters` fehlt bei einem Bild ohne Korrektur (kein leeres Objekt erfunden)", () => {
    const p = projectWith([
      {
        id: "IMG1",
        type: "image",
        name: "Luftbild",
        src: "data:image/jpeg;base64,AAAA",
        min: { x: 0, y: 0 },
        max: { x: 10, y: 10 },
      },
    ]);
    const plan = generatePlan(p, "eg", visible);
    expect(plan.backgroundImages![0].filters).toBeUndefined();
  });

  it("[140] auch im Schwarz-Weiss-Modus (Tusche-Standard) bleibt das Luftbild", () => {
    const p = projectWith([
      {
        id: "IMG1",
        type: "image",
        name: "Luftbild",
        src: "data:image/jpeg;base64,AAAA",
        min: { x: 0, y: 0 },
        max: { x: 10, y: 10 },
      },
    ]);
    const plan = generatePlan(p, "eg", visible, undefined, "mittel", false, true);
    expect(plan.backgroundImages).toHaveLength(1);
  });
});

describe("generatePlan — Kontext-Objekte: Ebenen-Sichtbarkeit (categoryCode)", () => {
  // Ein Kontext-Objekt MIT `categoryCode` respektiert dieselbe visibleCodes-
  // Allowlist wie jedes andere Bauteil (Wand/Dach/…) — Nutzer-Report: "sollten
  // wie Gebäude/Dächer ausblendbar sein". Objekte OHNE categoryCode (ältere
  // Importe) bleiben unabhängig davon immer sichtbar (Rückwärtskompatibilität).
  const buildingMesh = (id: string, categoryCode?: string) => ({
    id,
    type: "importedMesh" as const,
    name: "Haus",
    categoryCode,
    positions: [0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0],
    indices: [0, 1, 2, 0, 2, 3],
  });

  it("visibleCodes ohne den categoryCode des Objekts blendet es aus", () => {
    const p = projectWith([buildingMesh("B1", "12")]);
    const visibleWithoutBuildings = new Set<string>(["20"]); // nur Wände sichtbar
    const lines = generatePlan(p, "eg", visibleWithoutBuildings).primitives.filter(
      (pr) => pr.kind === "line" && (pr as { cls?: string }).cls === "mesh-view",
    );
    expect(lines.length).toBe(0);
  });

  it("visibleCodes MIT dem categoryCode des Objekts zeigt es normal", () => {
    const p = projectWith([buildingMesh("B1", "12")]);
    const visibleWithBuildings = new Set<string>(["12"]);
    const lines = generatePlan(p, "eg", visibleWithBuildings).primitives.filter(
      (pr) => pr.kind === "line" && (pr as { cls?: string }).cls === "mesh-view",
    );
    expect(lines.length).toBeGreaterThan(0);
  });

  it("ein Objekt OHNE categoryCode bleibt immer sichtbar (Altbestand)", () => {
    const p = projectWith([buildingMesh("B1", undefined)]);
    const visibleEmpty = new Set<string>(); // schliesst alles Benannte aus
    const lines = generatePlan(p, "eg", visibleEmpty).primitives.filter(
      (pr) => pr.kind === "line" && (pr as { cls?: string }).cls === "mesh-view",
    );
    expect(lines.length).toBeGreaterThan(0);
  });
});
