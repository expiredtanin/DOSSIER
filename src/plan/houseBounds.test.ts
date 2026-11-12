// [204] Einpassen beim Öffnen: das Plan-Ausmass hat zusätzlich das Ausmass nur der Bauteile (ohne Kataster/Gelände).
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { emptyProject } from "../model/sampleProject";
import { collectVisibleCodes } from "../model/layers";
import { generatePlan } from "./generatePlan";

const area = (b: { minX: number; minY: number; maxX: number; maxY: number }) => (b.maxX - b.minX) * (b.maxY - b.minY);

describe("Bauteil-Ausmass des Grundrisses [204]", () => {
  const p = buildComplexSampleProject();
  const codes = collectVisibleCodes(p.layers);

  it("Musterhaus komplex: Gebäude deutlich kleiner als das ganze Ausmass mit Kontext", () => {
    const plan = generatePlan(p, "eg", codes, undefined, "mittel", false, true, true, 100);
    const h = plan.houseBounds;
    expect(h).toBeDefined();
    const b = plan.bounds;
    // Das Gebäude liegt im Ausmass …
    expect(h!.minX).toBeGreaterThanOrEqual(b.minX - 1e-9);
    expect(h!.maxX).toBeLessThanOrEqual(b.maxX + 1e-9);
    expect(h!.minY).toBeGreaterThanOrEqual(b.minY - 1e-9);
    expect(h!.maxY).toBeLessThanOrEqual(b.maxY + 1e-9);
    // … und das Kataster/Gelände macht das Ausmass deutlich grösser.
    expect(area(h!)).toBeLessThan(area(b) * 0.5);
    // Haus ~ 10 × 12 m, nicht das Grundstück.
    expect(h!.maxX - h!.minX).toBeLessThan(40);
  });

  it("ohne Bauteile: kein Bauteil-Ausmass (Aufrufer fällt auf das Ausmass zurück)", () => {
    const plan = generatePlan(emptyProject, "eg", new Set(), undefined, "mittel", false, true, true, 100);
    expect(plan.houseBounds).toBeUndefined();
  });
});
