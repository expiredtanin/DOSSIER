// [158] Raumbuch: Zeilen aus dem Kern, Bericht (CSV-Rundreise) und Blatt-Tabelle.
import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Layout, Project, Room } from "../model/types";
import { areaReportToCsv, parseAreaReportCsv } from "./areaReport";
import { buildRoomBookReport, hasSlope, roomBook, usageLabel } from "./roomBook";
import { sheetTables, tableLabels } from "./sheetTable";
import { t } from "../i18n/translate";

const base = sampleProject.rooms![0]!;
const bad: Room = {
  ...base,
  id: "R-bad",
  name: "Bad",
  usage: "bath",
  floorFinish: "Feinsteinzeug 30×60",
  wallFinish: "Plattenbelag",
  ceilingFinish: "Weissputz",
  boundary: [
    { x: 6, y: 0 },
    { x: 8, y: 0 },
    { x: 8, y: 2 },
    { x: 6, y: 2 },
  ],
  stamp: { number: "0.02", name: "Bad", showFloorArea: true, showUsage: false },
};
const p: Project = {
  ...sampleProject,
  name: "Test",
  rooms: [
    { ...base, usage: "living", floorFinish: sampleProject.components[0]!.id, ceilingFinish: "Weissputz", stamp: { number: "0.01", name: "Wohnen", showFloorArea: true, showUsage: true } },
    bad,
  ],
};

describe("Raumbuch ([158])", () => {
  it("eine Zeile je Raum mit Oberflächen, Nassraum aus der Nutzung, Mengen je Material", () => {
    const b = roomBook(p);
    expect(b.rows.map((r) => r.number)).toEqual(["0.01", "0.02"]);
    const w = b.rows[0]!;
    expect(w).toMatchObject({ usage: "living", wet: false, floorFinish: sampleProject.components[0]!.name, ceilingFinish: "Weissputz" });
    expect(w.wallArea).toBeGreaterThan(0);
    expect(w.wallArea).toBeLessThan(w.perimeter * w.clearHeight);
    expect(b.rows[1]).toMatchObject({ wet: true, floorFinish: "Feinsteinzeug 30×60", area: 4 });
    const ceil = b.quantities.find((q) => q.surface === "ceiling" && q.finish === "Weissputz")!;
    expect(ceil.rooms).toBe(2);
    expect(ceil.area).toBeCloseTo(w.area + 4, 9);
  });

  it("Wandseiten, Leibungen, Sockel und Höhenbereiche ([158])", () => {
    const w = roomBook(p).rows[0]!;
    expect(w.skirting).toBeGreaterThan(0);
    expect(w.skirting).toBeLessThanOrEqual(w.perimeter);
    expect(w.wallSides.reduce((a, s) => a + s.length, 0)).toBeCloseTo(w.perimeter, 6);
    expect(w.wallSides.reduce((a, s) => a + s.area, 0)).toBeCloseTo(w.wallArea, 6);
    expect(w.revealArea).toBeGreaterThanOrEqual(0);
    // Ohne Dach: überall die lichte Höhe, alles im obersten Höhenbereich.
    expect(w.heightMin).toBeCloseTo(w.clearHeight, 9);
    expect(hasSlope(w)).toBe(false);
    expect(w.areaUnder1 + w.area1To15 + w.areaOver15).toBeCloseTo(w.area, 6);
    const rep = buildRoomBookReport(p);
    expect(rep.sections[0]!.columns).toContain(t("roomBook.col.skirting"));
    expect(rep.sections[0]!.rows[0]!.cells.length).toBe(rep.sections[0]!.columns.length);
  });

  it("Bericht: Raumbuch und Mengen, CSV-Rundreise", () => {
    const rep = buildRoomBookReport(p);
    expect(rep.sections.map((s) => s.heading)).toEqual([t("roomBook.title"), t("roomBook.quantities")]);
    const parsed = parseAreaReportCsv(areaReportToCsv(rep));
    const rows = parsed.sections[0]!.rows;
    expect(rows.length).toBe(2);
    expect(rows[1]).toContain("Feinsteinzeug 30×60");
    expect(rows[1]).toContain(usageLabel("bath"));
    expect(parsed.sections[1]!.rows.some((r) => r.includes("Weissputz"))).toBe(true);
  });

  it("ohne Räume: leerer Bericht ohne Abschnitte", () => {
    expect(buildRoomBookReport({ ...p, rooms: [] }).sections).toEqual([]);
  });

  it("als Tabelle auf dem Blatt", () => {
    const layout: Layout = { id: "L1", name: "Blatt", paper: "a3", orientation: "landscape", viewports: [], tables: [{ id: "rb", source: "roomBook", xMm: 10, yMm: 20, widthMm: 260 }] };
    const q: Project = { ...p, layouts: [layout] };
    const [tb] = sheetTables(q, "L1");
    expect(tb!.total).toBe(2);
    const texts = tb!.prims.filter((x) => x.k === "text").map((x) => (x as { s: string }).s);
    expect(texts).toContain(tableLabels(q)["roomBook.col.floorFinish"]);
    expect(texts).toContain("0.02");
    expect(texts).toContain(usageLabel("bath"));
  });
});
