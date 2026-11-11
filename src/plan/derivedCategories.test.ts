// [180] Alles Sichtbare liegt auf einer Klasse (Vorgabe Maintainer): Grundriss (alle Geschosse), Schnitte und
// Ansichten beider Musterhäuser sind leer, wenn alle Klassen ausgeblendet sind; jede Klasse der abgeleiteten
// Darstellung (Schatten, Auto-Bemassung, Höhenkoten, Schnittmarken) nimmt genau ihre Primitive mit.
// Kern-Gegenstück mit dem Fixture-Projekt: `src-tauri/core/src/plan/derived_class_tests.rs`.
import { describe, expect, it } from "vitest";
import { computeSection, generateElevationPlan, generatePlan, generateSectionPlan, levelMarksEnabled } from "../core";
import { sampleProject, emptyProject } from "../model/sampleProject";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { withStandards } from "../model/standards";
import { flattenCategories } from "../model/layers";
import { AUTO_DIM_CATEGORY, DERIVED_CATEGORY_CODES, LEVEL_MARK_CATEGORY, SECTION_MARK_CATEGORY, SHADOW_CATEGORY } from "../model/derivedCategories";
import type { Primitive } from "./generatePlan";
import type { Project } from "../model/types";

const SHOW_ALL = () => ({ render: true, greyed: false, locked: false });
const allCodes = (p: Project) => new Set(flattenCategories(p.layers).map((c) => c.code));
const without = (s: Set<string>, code: string) => new Set([...s].filter((c) => c !== code));

const projects: [string, () => Project][] = [
  ["muster", () => sampleProject],
  ["komplex", buildComplexSampleProject],
];

const floorPlan = (p: Project, floor: string, codes: Set<string>): readonly Primitive[] =>
  generatePlan(p, floor, codes, SHOW_ALL, "mittel", false, false, true, 100).primitives;
const elevation = (p: Project, id: string, codes: Set<string>): readonly Primitive[] =>
  generateElevationPlan(p, p.drawingLevels.find((l) => l.id === id)!, { scaleDenominator: 100, visibleCodes: codes, categoryDisplay: SHOW_ALL })?.primitives ?? [];
const describeLeft = (prims: readonly Primitive[]) =>
  prims.slice(0, 5).map((q) => JSON.stringify(q).slice(0, 160));

describe("[180] Klassen der abgeleiteten Darstellung", () => {
  it('„Standards laden“ legt sie an (Codes wie im Kern)', () => {
    const codes = allCodes(withStandards({ ...emptyProject, layers: [] }));
    for (const c of DERIVED_CATEGORY_CODES) expect(codes.has(c), c).toBe(true);
    // Die Musterprojekte haben sie schon.
    for (const c of DERIVED_CATEGORY_CODES) expect(allCodes(sampleProject).has(c), c).toBe(true);
  });

  for (const [name, make] of projects) {
    describe(name, () => {
      const p = make();
      const all = allCodes(p);

      for (const lvl of p.drawingLevels.filter((l) => l.kind === "floor")) {
        it(`Grundriss ${lvl.id}: ohne Klassen leer`, () => {
          expect(floorPlan(p, lvl.id, all).length).toBeGreaterThan(0);
          const rest = floorPlan(p, lvl.id, new Set());
          expect(rest.length, describeLeft(rest).join("\n")).toBe(0);
        });
      }

      for (const lvl of p.drawingLevels.filter((l) => l.kind === "section")) {
        it(`Schnitt ${lvl.id}: ohne Klassen leer`, async () => {
          const out = (await computeSection(p, lvl))!;
          const plan = (codes: Set<string>) => generateSectionPlan(out, false, { visibleCodes: codes, categoryDisplay: SHOW_ALL, openings: true, scaleDenominator: 100 }).primitives;
          expect(plan(all).length).toBeGreaterThan(0);
          const rest = plan(new Set());
          expect(rest.length, describeLeft(rest).join("\n")).toBe(0);
          expect(levelMarksEnabled({ ...lvl, levelMarks: true }, p, (c) => all.has(c))).toBe(true);
          expect(levelMarksEnabled({ ...lvl, levelMarks: true }, p, (c) => c !== LEVEL_MARK_CATEGORY)).toBe(false);
        }, 30_000);
      }

      for (const lvl of p.drawingLevels.filter((l) => l.kind === "elevation")) {
        it(`Ansicht ${lvl.id}: ohne Klassen leer, Schlagschatten auf „Schatten“`, () => {
          const shaded = { ...p, drawingLevels: p.drawingLevels.map((l) => (l.id === lvl.id ? { ...l, shadows: true } : l)) };
          const full = elevation(shaded, lvl.id, all);
          expect(full.length).toBeGreaterThan(0);
          const rest = elevation(shaded, lvl.id, new Set());
          expect(rest.length, describeLeft(rest).join("\n")).toBe(0);
          const shadows = (v: readonly Primitive[]) => v.filter((q) => q.kind === "polygon" && q.contextObjectId === "@viewShadows").length;
          expect(shadows(full)).toBeGreaterThan(0);
          expect(shadows(elevation(shaded, lvl.id, without(all, SHADOW_CATEGORY)))).toBe(0);
        });
      }
    });
  }

  it("komplex EG: Schatten, Auto-Bemassung und Schnittmarken einzeln aus", () => {
    const p = buildComplexSampleProject();
    const all = allCodes(p);
    const full = floorPlan(p, "eg", all);
    const count = (v: readonly Primitive[], hit: (q: Primitive) => boolean) => v.filter(hit).length;
    const sun = (q: Primitive) => q.kind === "polygon" && q.contextObjectId === "@sunStudy";
    const autodim = (q: Primitive) => "drawingId" in q && typeof q.drawingId === "string" && q.drawingId.startsWith("autodim-");
    const marks = (q: Primitive) => q.kind === "polygon" && !!q.sectionLineId;
    for (const [code, hit] of [[SHADOW_CATEGORY, sun], [AUTO_DIM_CATEGORY, autodim], [SECTION_MARK_CATEGORY, marks]] as const) {
      const n = count(full, hit);
      expect(n, code).toBeGreaterThan(0);
      const off = floorPlan(p, "eg", without(all, code));
      expect(count(off, hit), code).toBe(0);
    }
    // Die Aussenbemassung trägt ihre Klasse (je Kette änderbar).
    expect(p.drawings2d.filter((d) => d.id.startsWith("autodim-")).every((d) => d.categoryCode === AUTO_DIM_CATEGORY)).toBe(true);
  });
});
