import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { areaReportToCsv, parseAreaReportCsv } from "./areaReport";
import { buildOpeningReport, openingSchedule } from "./openingSchedule";

const p: Project = {
  ...sampleProject,
  name: "Test",
  openings: (sampleProject.openings ?? []).map((o, i) =>
    i === 0 ? { ...o, mark: "T-Haus", fireRating: "EI30", soundClass: "Rw 32 dB", uValue: 1.4, burglaryClass: "RC2", notes: 'Eingang; mit "Zusatz"', isExternal: true } : o,
  ),
};

describe("Fenster- und Türliste", () => {
  it("eine Zeile je Öffnung, eigene Angaben übernommen, Rest automatisch nummeriert", () => {
    const rows = openingSchedule(p);
    expect(rows.length).toBe((p.openings ?? []).length);
    const first = rows.find((r) => r.id === p.openings![0]!.id)!;
    expect(first).toMatchObject({ mark: "T-Haus", markAuto: false, fireRating: "EI30", soundClass: "Rw 32 dB", uValue: 1.4, burglaryClass: "RC2", external: true });
    for (const r of rows.filter((r) => r.id !== first.id)) expect(r.markAuto).toBe(true);
    expect(new Set(rows.map((r) => r.mark)).size).toBe(rows.length);
  });
  it("Bericht: Abschnitte je Art, CSV-Rundreise", () => {
    const rep = buildOpeningReport(p);
    expect(rep.sections.length).toBeGreaterThan(0);
    const parsed = parseAreaReportCsv(areaReportToCsv(rep));
    const all = parsed.sections.flatMap((s) => s.rows);
    expect(all.length).toBe((p.openings ?? []).length);
    expect(all.some((r) => r[0] === "T-Haus" && r.includes('Eingang; mit "Zusatz"'))).toBe(true);
  });
  it("leeres Projekt: kein Abschnitt", () => {
    expect(buildOpeningReport({ ...p, openings: [] }).sections).toEqual([]);
  });
});
