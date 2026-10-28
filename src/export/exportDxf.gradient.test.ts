/**
 * DXF-Export von Verlauf-Schraffuren (`HatchStyle.kind === "gradient"`).
 * DXF trägt keine echten Farbverläufe (wie bereits bei Bild-Schraffuren
 * akzeptiert) — der Export muss auf die reine Umriss-Polylinie zurückfallen
 * und darf KEINE (aus dem stehengebliebenen `pattern`-Feld abgeleiteten)
 * Musterlinien mehr ausgeben.
 */

import { describe, expect, it } from "vitest";
import "../engine/fileioWasm.setup";
import { buildPlanDxf } from "./exportDxf";
import { readDxf } from "./cadReadBack.testutil";
import { sampleProject } from "../model/sampleProject";
import type { Plan } from "../plan/generatePlan";
import type { HatchRender } from "../plan/generatePlan/shared";

function planWith(primitives: Plan["primitives"]): Plan {
  return { primitives, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } } as Plan;
}

function countEntities(dxf: string, type: string): number {
  return readDxf(dxf).entities.filter((e) => e.type === type).length;
}

const SQUARE = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 4 },
  { x: 0, y: 4 },
];

function polyWith(hatchOver: Partial<HatchRender> = {}): Plan["primitives"][number] {
  return {
    kind: "polygon",
    pts: SQUARE,
    fill: "#eeeeee",
    stroke: "#111111",
    strokeWidthMm: 0.25,
    hatch: {
      pattern: "crosshatch", // würde OHNE gradient-Ausschluss ein Kreuzmuster erzeugen
      scale: 1,
      angle: 0,
      color: "#123456",
      lineWeight: 0.13,
      dash: null,
      ...hatchOver,
    },
  } as Plan["primitives"][number];
}

describe("buildPlanDxf — Verlauf-Schraffur", () => {
  it("vektor+crosshatch: erzeugt Musterlinien (Gegenprobe)", () => {
    const dxf = buildPlanDxf(planWith([polyWith()]), sampleProject);
    expect(countEntities(dxf, "LINE")).toBeGreaterThan(0);
    expect(countEntities(dxf, "LWPOLYLINE")).toBe(1); // nur der Umriss
  });

  it("gradient: KEINE Musterlinien, nur die Umriss-Polylinie", () => {
    const dxf = buildPlanDxf(
      planWith([
        polyWith({
          kind: "gradient",
          gradient: { color1: "#ffffff", color2: "#000000", angle: 45, type: "linear" },
        }),
      ]),
      sampleProject,
    );
    expect(countEntities(dxf, "LINE")).toBe(0);
    expect(countEntities(dxf, "LWPOLYLINE")).toBe(1); // Umriss bleibt erhalten
  });
});
