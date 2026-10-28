import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Project, Room, Wall } from "../model/types";
import { computeAreaTable, computeIvhb } from "../analysis/areaTable";
import { areaReportToCsv, areaReportToSvg, buildAreaReport, buildAreaReportPdf, cellText, layoutAreaReport, parseAreaReportCsv } from "./areaReport";

// Einfaches Haus: Achsen 10 × 8 m, Wände 0.3 m, EG-Räume innen 9.7 × 7.7 m (Handrechnung siehe flaechen.rs).
function house(): Project {
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
  return { ...base, name: "Haus", wallTypes: [type], walls, rooms: [room("a", "HNF", 0.15, 4.15), room("b", "NNF", 4.15, 5.85), room("c", "VF", 5.85, 7.85)], openings: [], extrudedSolids: undefined, roofs: undefined, parcelArea: 400 };
}

describe("computeAreaTable", () => {
  it("einfaches Haus: Flächenarten, KF aus den Wänden, GF = NGF + KF", () => {
    const t = computeAreaTable(house());
    const eg = t.levels.find((l) => l.levelId === "eg")!;
    expect(eg.hnf).toBeCloseTo(38.8, 4);
    expect(eg.nnf).toBeCloseTo(16.49, 4);
    expect(eg.vf).toBeCloseTo(19.4, 4);
    expect(eg.ngf).toBeCloseTo(74.69, 4);
    expect(eg.kf).toBeCloseTo(10.8, 4);
    expect(eg.gf).toBeCloseTo(85.49, 4);
    expect(t.total.gf).toBeCloseTo(85.49, 4);
    expect(t.gvSource).toBe("levels");
    expect(t.gv).toBeCloseTo(85.49 * 2.6, 3);
  });
});

describe("computeIvhb", () => {
  it("Ziffern aus Parzellenfläche, Eingaben überschreiben", () => {
    const p = house();
    const v = computeIvhb(p);
    expect(v.agsfSource).toBe("parcelArea");
    expect(v.gfz).toBeCloseTo(85.49 / 400, 5);
    expect(v.az).toBeCloseTo(74.69 / 400, 5);
    expect(v.uz).toBeCloseTo(85.49 / 400, 5);
    expect(v.gz).toBeNull();
    const w = computeIvhb(p, { agsf: 200, greenArea: 100, agfBasis: "gf" });
    expect(w.agsfSource).toBe("input");
    expect(w.az).toBeCloseTo(85.49 / 200, 5);
    expect(w.gz).toBeCloseTo(0.5, 9);
  });
  it("ohne Parzelle keine Ziffern", () => {
    const { parcelArea: _p, ...p } = house();
    const v = computeIvhb(p as Project);
    expect(v.agsf).toBeNull();
    expect(v.az).toBeNull();
  });
});

describe("Bericht", () => {
  const report = buildAreaReport(house(), { areas: true, ivhb: true, ivhbOptions: { greenArea: 160 } });

  it("hat Flächentabelle, Kennziffern, Höhen und Fussnoten", () => {
    expect(report.sections).toHaveLength(3);
    const areas = report.sections[0]!;
    expect(areas.columns).toContain("NGF");
    expect(areas.rows.at(-1)!.total).toBe(true);
    expect(report.notes.some((n) => n.includes("SIA 416"))).toBe(true);
  });

  it("CSV-Rundreise gibt die ausgegebenen Zahlen zurück", () => {
    const csv = areaReportToCsv(report);
    const back = parseAreaReportCsv(csv);
    expect(back.title).toBe(report.title);
    expect(back.projectName).toBe("Haus");
    expect(back.sections).toHaveLength(report.sections.length);
    report.sections.forEach((s, i) => {
      expect(back.sections[i]!.heading).toBe(s.heading);
      expect(back.sections[i]!.columns).toEqual(s.columns);
      s.rows.forEach((r, j) => {
        r.cells.forEach((c, k) => {
          const got = back.sections[i]!.rows[j]![k];
          if (typeof c === "string") expect(got).toBe(c);
          else expect(got).toBe(c.n === null ? null : Number(cellText(c)));
        });
      });
    });
    expect(back.notes).toEqual(report.notes);
  });

  it("CSV: Felder mit Semikolon und Anführungszeichen bleiben heil", () => {
    const r = { ...report, projectName: 'Haus "A"; Süd' };
    expect(parseAreaReportCsv(areaReportToCsv(r)).projectName).toBe('Haus "A"; Süd');
  });

  it("SVG und PDF entstehen aus derselben Seitenaufteilung", () => {
    const svg = areaReportToSvg(report);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("NGF");
    const lay = layoutAreaReport(report);
    expect(lay.pages.length).toBeGreaterThanOrEqual(1);
    const pdf = buildAreaReportPdf(report);
    expect(pdf.getNumberOfPages()).toBe(lay.pages.length);
    expect(pdf.output("arraybuffer").byteLength).toBeGreaterThan(1000);
  });

  it("viele Geschosse laufen auf eine zweite Seite", () => {
    const sec = report.sections[0]!;
    const rows = Array.from({ length: 60 }, (_, i) => ({ cells: [`G${i}`, ...sec.rows[0]!.cells.slice(1)] }));
    const lay = layoutAreaReport({ ...report, sections: [{ ...sec, rows }] });
    expect(lay.pages.length).toBeGreaterThan(1);
  });
});
