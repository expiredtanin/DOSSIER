// [203] Geschoss-Grundriss wie Archicad: zeigt nur sein Geschoss. Andere Geschosse erscheinen nur als bewusst
// eingeschaltete Pausfolie (Zeichnungsebenen-Modus „Andere grau“ bzw. „Andere grau & gesperrt“), dann gedimmt;
// das Achsraster (in allen Geschossen gezeigt) steht nur einmal im Plan.
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { collectVisibleCodes } from "../model/layers";
import { generateVisibleLevelsPlan, materializeGreyed, materializeUnderlay } from "./generatePlan";
import { itemDisplay } from "../panels/displayMode";
import type { DisplayMode } from "../panels/types";

const p = buildComplexSampleProject();
const codes = collectVisibleCodes(p.layers);
const floorOf = new Map((p.rooms ?? []).map((r) => [r.id, r.floorId]));

function planFor(mode: DisplayMode, active = "eg") {
  const levelDisplay = (id: string) => itemDisplay(mode, id === active, p.drawingLevels.find((l) => l.id === id)?.visible ?? false);
  const plan = materializeGreyed(materializeUnderlay(generateVisibleLevelsPlan(p, active, codes, undefined, "mittel", false, false, levelDisplay, 100)), true);
  const stamps = plan.primitives.flatMap((q) => (q.kind === "text" && q.roomId ? [{ floor: floorOf.get(q.roomId), greyed: !!q.greyed }] : []));
  const axisA = plan.primitives.filter((q) => q.kind === "drawingText" && q.drawingId === "raster" && q.text === "A").length;
  return { stamps, axisA };
}

describe("[203] Geschoss-Grundriss zeigt nur sein Geschoss", () => {
  it("Musterhaus komplex: alle Geschosse sichtbar (Auge an, für 3D) — EG zeigt nur EG-Stempel, Raster einmal", () => {
    expect(p.drawingLevels.filter((l) => l.kind === "floor").every((l) => l.visible)).toBe(true);
    for (const mode of ["all", "all_force", "locked", "active"] as DisplayMode[]) {
      const { stamps, axisA } = planFor(mode);
      expect(stamps.length, mode).toBeGreaterThan(3);
      expect(stamps.every((s) => s.floor === "eg"), mode).toBe(true);
      expect(axisA, mode).toBe(2);
    }
  });

  it("Pausfolie nur bewusst („Andere grau“): andere Geschosse gedimmt, Raster weiter nur einmal", () => {
    for (const mode of ["grey", "grey_locked"] as DisplayMode[]) {
      const { stamps, axisA } = planFor(mode);
      const own = stamps.filter((s) => s.floor === "eg");
      const others = stamps.filter((s) => s.floor !== "eg");
      expect(own.length).toBeGreaterThan(3);
      expect(own.every((s) => !s.greyed)).toBe(true);
      expect(others.length, mode).toBeGreaterThan(0);
      expect(others.every((s) => s.greyed), mode).toBe(true);
      expect(axisA, mode).toBe(2);
    }
  });
});
