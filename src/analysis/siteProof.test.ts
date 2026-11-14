import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Project, Room, SiteRules, Wall } from "../model/types";
import { applyOps } from "../core/ops";
import { setField } from "../core/opsBuild";
import { computeSiteProof } from "./siteProof";
import { areaReportToCsv, buildAreaReport } from "../export/areaReport";

// Einfaches Haus wie in areaReport.test.ts: Achsen 10 × 8 m, EG-Räume innen 9.7 × 7.7 m, Parzelle 400 m².
function house(rules?: Partial<SiteRules>): Project {
  const base = structuredClone(sampleProject) as Project;
  const wt = base.wallTypes[0]!;
  const type = { ...wt, id: "w30", layers: [{ ...wt.layers[0]!, thickness: 0.3 }] };
  const pts = [[0, 0], [10, 0], [10, 8], [0, 8]] as const;
  const walls = pts.map((a, i): Wall => {
    const b = pts[(i + 1) % 4]!;
    return { ...(base.walls[0] as Wall), id: `hw${i}`, floorId: "eg", start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, wallTypeId: "w30", height: 2.6, bottom: undefined, top: undefined };
  });
  const room = (id: string, cat: Room["siaCategory"], y0: number, y1: number): Room => ({
    ...(base.rooms![0] as Room), id, floorId: "eg", siaCategory: cat, name: id,
    boundary: [{ x: 0.15, y: y0 }, { x: 9.85, y: y0 }, { x: 9.85, y: y1 }, { x: 0.15, y: y1 }],
  });
  const p: Project = { ...base, name: "Haus", wallTypes: [type], walls, rooms: [room("a", "HNF", 0.15, 4.15), room("b", "NNF", 4.15, 5.85), room("c", "VF", 5.85, 7.85)], openings: [], extrudedSolids: undefined, roofs: undefined, parcelArea: 400, siteRules: undefined };
  if (!rules) return p;
  const siteRules: SiteRules = { parcel: [{ x: -5, y: -5 }, { x: 15, y: -5 }, { x: 15, y: 15 }, { x: -5, y: 15 }], defaultSetback: 1, ...rules };
  return applyOps(p, [setField("siteRules", siteRules)]);
}

const row = (p: ReturnType<typeof computeSiteProof>, k: string) => p.rows.find((r) => r.key === k)!;

describe("computeSiteProof (Kern site_proof.rs)", () => {
  it("ohne Baurecht: Projektwerte da, keine Vorgaben, nichts erfüllt/verletzt", () => {
    const pr = computeSiteProof(house());
    expect(pr.hasLimits).toBe(false);
    expect(pr.allOk).toBeNull();
    expect(pr.rows.every((r) => r.allowed === null && r.ok === null)).toBe(true);
    expect(row(pr, "az").actual).toBeCloseTo(74.69 / 400, 5);
    expect(row(pr, "totalHeight").actual).toBeCloseTo(2.6, 4);
    expect(pr.notes).toContain("noRules");
  });

  it("Vorgaben: Reserve, Überschreitung, Untergrenze", () => {
    const pr = computeSiteProof(house({ maxAz: 0.5, maxGfz: 0.2, maxHeight: 6, minGz: 0.3 }), { greenArea: 160 });
    expect(row(pr, "az").ok).toBe(true);
    expect(row(pr, "az").reserve).toBeCloseTo(0.5 - 74.69 / 400, 5);
    expect(row(pr, "gfz").ok).toBe(false);
    expect(row(pr, "gfz").reserve!).toBeLessThan(0);
    expect(row(pr, "totalHeight").ok).toBe(true);
    expect(row(pr, "gz").actual).toBeCloseTo(0.4, 5);
    expect(row(pr, "gz").ok).toBe(true);
    expect(row(pr, "setback").ok).toBe(true);
    expect(pr.allOk).toBe(false);
    expect(pr.basis.find((b) => b.key === "agsf")).toMatchObject({ value: 400, source: "parcelArea" });
  });
});

describe("Baurecht-Nachweis im Bericht", () => {
  it("Abschnitte Nachweis + Grundlagen; fehlende Vorgabe als Strich; CSV enthält sie", () => {
    const rep = buildAreaReport(house({ maxAz: 0.5 }), { areas: false, siteProof: true });
    expect(rep.sections).toHaveLength(2);
    const az = rep.sections[0]!.rows.find((r) => typeof r.cells[0] === "string" && r.cells[0].startsWith("AZ"))!;
    expect(az.cells[1]).toEqual({ n: 0.5, d: 2 });
    expect(az.cells[4]).toBe("ja");
    const gfz = rep.sections[0]!.rows.find((r) => typeof r.cells[0] === "string" && r.cells[0].startsWith("GFZ"))!;
    expect(gfz.cells[1]).toBe("—");
    expect(gfz.cells[4]).toBe("—");
    const csv = areaReportToCsv(rep);
    expect(csv).toContain("0.50");
    expect(csv).toContain("aGSF");
  });
});
