/**
 * u-Achse der Schnittebene (`sectionUAxisModel`, `sectionPlaneFromLevel`): Blickrichtungs-RECHTS wie
 * im Kern-Schnitt. Die Aussen/Innen-Lage der Schicht-Bänder prüft der Kern
 * (`core/src/plan/section.rs`, `schichten_aussen_aussen_und_override_auf_allen_schichten`).
 */

import { describe, it, expect } from "vitest";
import { sectionPlaneFromLevel, sectionUAxisModel } from "./toSection";
import { sampleProject } from "../model/sampleProject";

// Schnitt A: horizontale Linie y=2 (x −1…6), quer durch W2 (x=5) und W4 (x=0).
const planeA = sectionPlaneFromLevel(
  sampleProject.drawingLevels.find((l) => l.id === "schnitt-a")!,
)!;

describe("Schnitt-u-Weltachse", () => {
  it("entspricht der Kern-Konvention u = cross(up, normal) → Grundriss (Nz, −Nx)", () => {
    // Schnitt A: Ebenennormale world = (0,0,1) → uWorld model = (1, 0) —
    // Betrachter-RECHTS (Entspiegelung: Blick nach Norden ⇒ Osten rechts).
    expect(planeA.normal[0]).toBeCloseTo(0, 9);
    expect(planeA.normal[1]).toBeCloseTo(0, 9);
    expect(planeA.normal[2]).toBeCloseTo(1, 9);
    const u = sectionUAxisModel(planeA);
    expect(u.x).toBeCloseTo(1, 9);
    expect(u.y).toBeCloseTo(0, 9);
  });
});
