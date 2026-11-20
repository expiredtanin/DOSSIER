// [317] Pick-Ids in Schnitt und Ansicht: jede Id, die ein Plan-Primitiv trägt, muss zur Art passen — `ceilingId` eine
// Decke, `stairId` eine Treppe, `columnId` eine Stütze oder ein Träger usw. Sonst wählt der Klick ein Element, das
// es nicht gibt (Treppe in der Ansicht, Stütze/Träger im Schnitt liefen früher als `ceilingId`).
import { describe, expect, it } from "vitest";
import { computeSection, generateElevationPlan, generateSectionPlan } from "../core";
import type { Project } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { buildUmbauSampleProject } from "../model/sampleProjectUmbau";
import { buildWettbewerbSampleProject } from "../model/sampleProjectWettbewerb";

type Lists = Record<string, { id: string }[] | undefined>;
const LIST: Record<string, string[]> = {
  wallId: ["walls"],
  ceilingId: ["ceilings"],
  openingId: ["openings"],
  stairId: ["stairs"],
  roofId: ["roofs"],
  columnId: ["columns", "beams"],
  extrudedSolidId: ["extrudedSolids"],
  drawingId: ["drawings2d"],
  roomId: ["rooms"],
};

function badIds(p: Project, prims: readonly unknown[]): string[] {
  const lists = p as unknown as Lists;
  const bad = new Set<string>();
  for (const pr of prims as Record<string, unknown>[]) {
    for (const [key, names] of Object.entries(LIST)) {
      const id = pr[key];
      if (typeof id === "string" && !names.some((n) => (lists[n] ?? []).some((e) => e.id === id))) bad.add(`${key}=${id}`);
    }
  }
  return [...bad];
}

const PROJECTS: [string, () => Project][] = [
  ["Muster", () => sampleProject],
  ["komplex", buildComplexSampleProject],
  ["Wettbewerb", buildWettbewerbSampleProject],
  ["Umbau", buildUmbauSampleProject],
];

describe("Pick-Ids in Schnitt und Ansicht gehören zur richtigen Art", () => {
  for (const [name, make] of PROJECTS) {
    it(name, async () => {
      const p = make();
      let stairIds = 0;
      let columnIds = 0;
      for (const l of p.drawingLevels.filter((x) => x.kind === "section" || x.kind === "elevation")) {
        const plan =
          l.kind === "section"
            ? generateSectionPlan((await computeSection(p, l))!, false, { openings: true, scaleDenominator: 100 })
            : generateElevationPlan(p, l, { scaleDenominator: 100 })!;
        expect(badIds(p, plan.primitives), `${name} ${l.id}`).toEqual([]);
        for (const pr of plan.primitives as unknown as Record<string, unknown>[]) {
          if (pr.stairId) stairIds++;
          if (pr.columnId) columnIds++;
        }
      }
      // Die Beispiele zeigen Treppen bzw. Stützen/Träger tatsächlich (sonst prüft der Test nichts).
      if (name === "Muster" || name === "Umbau") expect(stairIds).toBeGreaterThan(0);
      if (name === "komplex") expect(columnIds).toBeGreaterThan(0);
    }, 120_000);
  }
});
