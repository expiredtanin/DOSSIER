/**
 * `generatePlan` — Schattenstudie (`Project.sunStudy`): Boden-Schatten als halbtransparente
 * Flächen ZUUNTERST im Grundriss des Geschosses nächst ±0.00, sonst nirgends.
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import { sampleProject } from "../model/sampleProject";
import { flattenCategories } from "../model/types";
import type { Project } from "../model/types";

const ALL = new Set(flattenCategories(sampleProject.layers).map((c) => c.code));
/** Füllfarbe der Schattenflächen (`core/src/plan/extras.rs::SUN_SHADOW_FILL`). */
const SUN_SHADOW_FILL = "#3c3c3c";

const withStudy = (when: string, show = true): Project => ({ ...sampleProject, sunStudy: { when, show } });
const shadows = (p: Project, floorId: string) =>
  generatePlan(p, floorId, ALL).primitives.filter((q) => q.kind === "polygon" && q.fill === SUN_SHADOW_FILL);

describe("Schattenstudie im Grundriss", () => {
  it("Wintermittag: Schatten im EG, zuunterst gezeichnet", () => {
    const p = withStudy("2026-12-21T11:00:00Z");
    expect(shadows(p, "eg").length).toBeGreaterThan(0);
    const first = generatePlan(p, "eg", ALL).primitives[0];
    expect(first.kind === "polygon" && first.fill === SUN_SHADOW_FILL).toBe(true);
  });
  it("im OG nur auf dem Balkon, nicht ausgeschaltet, nicht nachts, nicht ohne Studie", () => {
    // [186] OG: kein Gelände-Schatten; die EG-Decke ragt nördlich als Balkon (y 3.17…4) unter dem Dachvorsprung
    // vor — im Freien, auf der Schattenseite, also beschattet (vorher galt die Traufe als Abdeckung).
    const og = shadows(withStudy("2026-12-21T11:00:00Z"), "og");
    const ys = og.flatMap((q) => (q.kind === "polygon" ? q.pts.map((p) => p.y) : []));
    expect(og.length).toBe(1);
    expect(Math.min(...ys)).toBeGreaterThan(3.1);
    expect(Math.max(...ys)).toBeLessThan(4 + 1e-6);
    expect(shadows(withStudy("2026-12-21T11:00:00Z", false), "eg")).toEqual([]);
    expect(shadows(withStudy("2026-12-21T22:00:00Z"), "eg")).toEqual([]);
    expect(shadows(sampleProject, "eg")).toEqual([]);
  });
  it("ungültiges Datum → kein Schatten, kein Absturz", () => {
    expect(shadows(withStudy("kein Datum"), "eg")).toEqual([]);
  });
  it("Planbegrenzung schliesst den ganzen Schatten ein (Druck/Einpassen)", () => {
    const plan = generatePlan(withStudy("2026-12-21T11:00:00Z"), "eg", ALL);
    const ys = shadows(withStudy("2026-12-21T11:00:00Z"), "eg").flatMap((q) => (q.kind === "polygon" ? q.pts.map((p) => p.y) : []));
    expect(plan.bounds.maxY).toBeGreaterThanOrEqual(Math.max(...ys) - 1e-9);
    expect(plan.bounds.maxY).toBeGreaterThan(generatePlan(sampleProject, "eg", ALL).bounds.maxY);
  });
});
