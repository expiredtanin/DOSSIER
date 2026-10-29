// Geschnittene Fenster/Türen im Schnitt (Kern, `core/src/plan/section.rs`), über `generateSectionPlan`
// mit `openings: true` wie in der Schnitt-Ansicht.
import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { DrawingLevel } from "../model/types";
import type { Primitive } from "./generatePlan";
import { computeSection, generateSectionPlan } from "./toSection";

const section = (x: number): DrawingLevel => ({
  id: "sx",
  name: "Sx",
  kind: "section",
  visible: true,
  locked: false,
  // Senkrecht durch W1 (y = 0) bei x, Blick nach Westen.
  linePoints: [{ x, y: -1 }, { x, y: 5 }],
  directionSign: 1,
});

async function openingPrims(level: DrawingLevel, openings = true): Promise<Primitive[]> {
  const out = (await computeSection(sampleProject, level))!;
  return generateSectionPlan(out, false, { openings }).primitives.filter((p) => "openingId" in p && p.openingId);
}

describe("Schnitt: geschnittene Öffnungen", () => {
  it("geschnittenes Fenster: Rahmenprofile an Brüstung/Sturz + Glaslinie, wählbar", async () => {
    const own = (await openingPrims(section(3.5))).filter((p) => "openingId" in p && p.openingId === "O1");
    expect(own.length).toBeGreaterThanOrEqual(4);
    const glass = own.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line");
    expect(glass.length).toBeGreaterThan(0);
    // Glas läuft zwischen Brüstung (0.9 m über Wand-UK) und Sturz (2.1 m) — mit Rahmen dazwischen.
    const vs = glass.flatMap((g) => [g.a.y, g.b.y]);
    expect(Math.min(...vs)).toBeGreaterThan(0.9);
    expect(Math.max(...vs)).toBeLessThan(2.1 + 1e-9);
  });

  it("Schnitt neben dem Fenster: nichts", async () => {
    expect((await openingPrims(section(1.0))).some((p) => "openingId" in p && p.openingId === "O1")).toBe(false);
  });

  it("nur auf Wunsch (Export ohne Öffnungen) und nie in Ansichten", async () => {
    expect(await openingPrims(section(3.5), false)).toEqual([]);
    const out = (await computeSection(sampleProject, { ...section(3.5), kind: "elevation" }))!;
    expect(generateSectionPlan(out, false, { openings: true }).primitives.some((p) => "openingId" in p && p.openingId)).toBe(false);
  });
});
