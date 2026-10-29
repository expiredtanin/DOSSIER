/**
 * `generatePlan` — Baurecht (`Project.siteRules`): Parzellengrenze, zulässige Fläche und
 * Verstösse im Geschoss nächst ±0.00.
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import { sampleProject } from "../model/sampleProject";
import { flattenCategories } from "../model/types";
import type { Project, SiteRules } from "../model/types";

const ALL = new Set(flattenCategories(sampleProject.layers).map((c) => c.code));
/** Erkennungsmerkmale des Baurechts (`core/src/plan/extras.rs`). */
const SITE_CLS = { parcel: "site-parcel", allowed: "site-allowed", violationFill: "#d0342c" } as const;
const site: SiteRules = {
  parcel: [{ x: -10, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 20 }, { x: -10, y: 20 }],
  defaultSetback: 4,
};
const withSite = (s: SiteRules | undefined): Project => ({ ...sampleProject, siteRules: s });
const prims = (p: Project, floorId: string) => generatePlan(p, floorId, ALL).primitives;

describe("Baurecht im Grundriss", () => {
  it("Parzellengrenze und zulässige Fläche als Linien im EG", () => {
    const ps = prims(withSite(site), "eg");
    expect(ps.filter((q) => q.kind === "line" && q.cls === SITE_CLS.parcel).length).toBe(4);
    expect(ps.filter((q) => q.kind === "line" && q.cls === SITE_CLS.allowed).length).toBe(4);
    expect(ps.some((q) => q.kind === "polygon" && q.fill === SITE_CLS.violationFill)).toBe(false);
  });
  it("Gebäude über dem Grenzabstand → rote Fläche, zuoberst gezeichnet", () => {
    const ps = prims(withSite({ ...site, defaultSetback: 12 }), "eg");
    const last = ps[ps.length - 1];
    expect(last.kind === "polygon" && last.fill === SITE_CLS.violationFill).toBe(true);
  });
  it("nicht im OG, nicht ausgeblendet, nicht ohne Baurecht", () => {
    const has = (ps: ReturnType<typeof prims>) => ps.some((q) => q.kind === "line" && q.cls === SITE_CLS.parcel);
    expect(has(prims(withSite(site), "og"))).toBe(false);
    expect(has(prims(withSite({ ...site, show: false }), "eg"))).toBe(false);
    expect(has(prims(withSite(undefined), "eg"))).toBe(false);
  });
  it("Planbegrenzung umfasst die Parzelle", () => {
    const b = generatePlan(withSite(site), "eg", ALL).bounds;
    expect(b.minX).toBeLessThanOrEqual(-10);
    expect(b.maxY).toBeGreaterThanOrEqual(20);
  });
});
