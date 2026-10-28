import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { areaReportToCsv, parseAreaReportCsv } from "./areaReport";
import { buildProgramReport } from "./programReport";

const sq = (x: number, y: number, s: number) => [
  { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
];
const base = (sampleProject.rooms ?? [])[0]!;

const p: Project = {
  ...sampleProject,
  name: "Test",
  rooms: [
    { ...base, id: "r1", name: "Wohnen", boundary: sq(0, 0, 5) },
    { ...base, id: "r2", name: "Bad", boundary: sq(10, 0, 2) },
    { ...base, id: "r3", name: "Keller", boundary: sq(20, 0, 2) },
  ],
  roomProgram: [
    { name: "Wohnen", area: 25, group: "Tag", siaCategory: "HNF" },
    { name: "Bad", area: 5, group: "Nacht", siaCategory: "HNF" },
    { name: "Büro", area: 12, group: "Nacht" },
  ],
};

describe("buildProgramReport", () => {
  const r = buildProgramReport(p);
  it("Tabelle je Raum mit Total, Gruppen und Flächenarten", () => {
    expect(r.sections.map((s) => s.rows.length)).toEqual([4, 2, 2]);
    const total = r.sections[0].rows[3];
    expect(total.total).toBe(true);
    expect(total.cells[5]).toEqual({ n: 42, d: 2 });
    expect(total.cells[7]).toEqual({ n: 29, d: 2 });
    expect(r.notes.some((n) => n.includes("Keller") || n.includes("1"))).toBe(true);
  });
  it("CSV-Rundreise: Zahlen so wie ausgegeben", () => {
    const back = parseAreaReportCsv(areaReportToCsv(r));
    expect(back.sections).toHaveLength(3);
    expect(back.sections[0].rows[1][8]).toBe(-1); // Bad: 4 − 5
    expect(back.sections[0].rows[1][9]).toBe(-20); // −20.0 %
  });
});
