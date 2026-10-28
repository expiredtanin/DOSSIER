/**
 * DXF-Export von Verlauf-Schraffuren (`HatchStyle.kind === "gradient"`).
 * Verläufe gehen als echte Gradient-HATCH ins DXF ([C2], 28.10.: Gruppencodes 450–470);
 * es dürfen KEINE (aus dem stehengebliebenen `pattern`-Feld abgeleiteten) Musterlinien
 * mehr ausgegeben werden. Ohne lesbare Farben bleibt es beim Umriss.
 */

import { describe, expect, it } from "vitest";
import "../engine/fileioWasm.setup";
import { buildPlanDxf } from "./exportDxf";
import { num, nums, readDxf, str } from "./cadReadBack.testutil";
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
  it("vektor+crosshatch: erzeugt eine HATCH-Entität mit zwei Musterzeilen (Gegenprobe)", () => {
    const dxf = buildPlanDxf(planWith([polyWith()]), sampleProject);
    expect(countEntities(dxf, "HATCH")).toBe(1);
    expect(countEntities(dxf, "LINE")).toBe(0); // keine einzelnen Schraffurlinien mehr
    expect(countEntities(dxf, "LWPOLYLINE")).toBe(1); // der Umriss
    const h = readDxf(dxf).entities.find((e) => e.type === "HATCH")!;
    expect(nums(h, 53).map((a) => Math.round(a))).toEqual([0, 90]);
  });

  it("gradient: eine Gradient-HATCH (LINEAR, zwei Farben, Winkel) plus Umriss, keine Musterlinien", () => {
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
    expect(countEntities(dxf, "HATCH")).toBe(1);
    expect(countEntities(dxf, "LWPOLYLINE")).toBe(1); // Umriss bleibt erhalten
    const h = readDxf(dxf).entities.find((e) => e.type === "HATCH")!;
    expect(str(h, 470)).toBe("LINEAR");
    expect(num(h, 460)).toBeCloseTo(Math.PI / 4, 9);
    expect(nums(h, 463)).toEqual([0, 1]);
    expect(nums(h, 421)).toEqual([0xffffff, 0x000000]);
  });

  it("gradient radial: SPHERICAL; 3-stellige Farben werden erweitert", () => {
    const dxf = buildPlanDxf(
      planWith([polyWith({ kind: "gradient", gradient: { color1: "#f00", color2: "#00f", angle: 0, type: "radial" } })]),
      sampleProject,
    );
    const h = readDxf(dxf).entities.find((e) => e.type === "HATCH")!;
    expect(str(h, 470)).toBe("SPHERICAL");
    expect(nums(h, 421)).toEqual([0xff0000, 0x0000ff]);
  });

  it("gradient ohne lesbare Farbe oder ohne Parameter: nur der Umriss", () => {
    for (const hatch of [
      polyWith({ kind: "gradient", gradient: { color1: "none", color2: "#000000", angle: 0, type: "linear" } }),
      polyWith({ kind: "gradient" }),
    ]) {
      const dxf = buildPlanDxf(planWith([hatch]), sampleProject);
      expect(countEntities(dxf, "HATCH")).toBe(0);
      expect(countEntities(dxf, "LWPOLYLINE")).toBe(1);
    }
  });

  it("gradient ohne Schraffuren-Option: nur der Umriss", () => {
    const dxf = buildPlanDxf(
      planWith([polyWith({ kind: "gradient", gradient: { color1: "#fff", color2: "#000", angle: 0, type: "linear" } })]),
      sampleProject,
      { includeHatches: false },
    );
    expect(countEntities(dxf, "HATCH")).toBe(0);
  });
});
