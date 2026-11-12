import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Layout, Project, Room, Wall } from "../model/types";
import { computeAreaTable } from "../analysis/areaTable";
import { computeCostEstimate, defaultCostEstimate, formatChf } from "../analysis/costEstimate";
import { areaReportToCsv, layoutAreaReport, parseAreaReportCsv } from "./areaReport";
import { buildCostReport } from "./costReport";
import { sheetTables } from "./sheetTable";

// Haus wie im Flächen-Nachweis-Test: Achsen 10 × 8 m, Wände 0.3 m, GF 85.49 m², GV = GF × 2.6 m.
function house(): Project {
  const base = structuredClone(sampleProject) as Project;
  const wt = base.wallTypes[0]!;
  const type = { ...wt, id: "w30", layers: [{ ...wt.layers[0]!, thickness: 0.3 }] };
  const pts = [[0, 0], [10, 0], [10, 8], [0, 8]] as const;
  const walls = pts.map((a, i): Wall => {
    const b = pts[(i + 1) % 4]!;
    return { ...(base.walls[0] as Wall), id: `hw${i}`, floorId: "eg", start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, wallTypeId: "w30", height: 2.6, bottom: undefined, top: undefined };
  });
  const room: Room = { ...(base.rooms![0] as Room), id: "a", floorId: "eg", siaCategory: "HNF", name: "a", boundary: [{ x: 0.15, y: 0.15 }, { x: 9.85, y: 0.15 }, { x: 9.85, y: 7.85 }, { x: 0.15, y: 7.85 }] };
  return { ...base, name: "Haus", wallTypes: [type], walls, rooms: [room], openings: [], extrudedSolids: undefined, roofs: undefined, layouts: [] };
}

describe("Kostenschätzung grob [209]", () => {
  it("Beispielwerte: Mengen aus der Flächentabelle, Summen und MwSt", () => {
    const p = house();
    const r = computeCostEstimate(p);
    const area = computeAreaTable(p);
    expect(r.isDefault).toBe(true);
    expect(r.hasExample).toBe(true);
    expect(r.method).toBe("gv");
    expect(r.quantities.gv).toBeCloseTo(area.gv, 9);
    expect(r.quantities.gf).toBeCloseTo(area.total.gf, 9);
    expect(r.rows.map((x) => x.code)).toEqual(["B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    // 800 CHF/m³ GV für B–J (Beispiel), +15 % Honorare, +10 % Reserve, +8.1 % MwSt.
    expect(r.subtotal).toBeCloseTo(area.gv * 800, 6);
    expect(r.gross).toBeCloseTo(area.gv * 800 * 1.15 * 1.1 * 1.081, 4);
    expect(r.low).toBeCloseTo(r.gross * 0.85, 4);
    expect(r.perGv).toBeCloseTo(r.gross / area.gv, 6);
  });

  it("Methode m² GF, eigene Kennwerte und Bezug Fassade", () => {
    const p = house();
    const est = defaultCostEstimate(p, "gf");
    est.groups = [{ code: "B–J", name: "Gebäude", basis: "method", rate: 3000 }, { code: "E", basis: "facade", rate: 200 }];
    est.feesPct = 0;
    est.reservePct = 0;
    const r = computeCostEstimate({ ...p, costEstimate: est });
    expect(r.hasExample).toBe(false);
    expect(r.rows[0]!.unit).toBe("m²");
    expect(r.rows[0]!.amount).toBeCloseTo(85.49 * 3000, 1); // i_overlay-Raster
    // Fassade: Aussenumfang 2 × (10.3 + 8.3) × 2.6 m.
    expect(r.rows[1]!.quantity).toBeCloseTo(37.2 * 2.6, 3);
    expect(r.net).toBeCloseTo(r.subtotal, 9);
  });

  it("Bericht: CSV-Rundreise mit denselben Zahlen, PDF-Layout mit Apostroph", () => {
    const p = house();
    const r = computeCostEstimate(p);
    const report = buildCostReport(p, r);
    const csv = areaReportToCsv(report);
    expect(csv).toContain("Kostenschätzung grob");
    expect(csv).toContain("Konstruktion Gebäude");
    expect(csv).not.toMatch(/\d'\d{3}/); // CSV ohne Tausender-Trenner
    const back = parseAreaReportCsv(csv);
    const rows = back.sections[0]!.rows;
    const gross = rows.find((x) => x[1] === "Total inkl. MwSt.")!;
    expect(gross[5]).toBe(Math.round(r.gross));
    const texts = layoutAreaReport(report).pages.flat().flatMap((x) => (x.k === "text" ? [x.s] : []));
    expect(texts).toContain(formatChf(r.gross));
    expect(texts.some((s) => s.includes("Beispielwert"))).toBe(true);
  });

  it("Blatt-Tabelle „costs“ folgt dem Modell", () => {
    const p = house();
    const layout: Layout = { id: "L", name: "Blatt", tables: [{ id: "k", source: "costs", xMm: 10, yMm: 10, widthMm: 180 }] } as unknown as Layout;
    const q = { ...p, layouts: [layout] };
    const out = sheetTables(q, "L");
    const texts = out[0]!.prims.flatMap((x) => (x.k === "text" ? [x.s] : []));
    expect(texts).toContain(formatChf(computeCostEstimate(q).gross));
    expect(texts.some((s) => s.startsWith("Total inkl. MwSt."))).toBe(true);
    expect(texts).toContain("Konstruktion Gebäude");
  });

  it("formatChf: Schweizer Schreibweise", () => {
    expect(formatChf(1234567.5, 2)).toBe("1'234'567.50");
    expect(formatChf(-1000)).toBe("-1'000");
    expect(formatChf(999)).toBe("999");
    expect(formatChf(Number.NaN)).toBe("–");
  });
});
