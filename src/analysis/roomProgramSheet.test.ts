import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { compareRoomProgram, layoutRoomProgram } from "./roomProgram";
import { addProgramSheet, buildProgramSheet } from "./roomProgramSheet";
import { computeAreaTable } from "./areaTable";
import { computeKennzahlen } from "./kennzahlen";

const sq = (x: number, y: number, s: number) => [
  { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
];
const base = (sampleProject.rooms ?? [])[0]!;

const withProgram = (): Project => ({
  ...sampleProject,
  rooms: [
    { ...base, id: "r1", name: "Wohnen 1", boundary: sq(0, 0, 5) },
    { ...base, id: "r2", name: "Bad", boundary: sq(10, 0, 2) },
  ],
  roomProgram: [
    { name: "Wohnen", area: 25, group: "Tag" },
    { name: "Bad", area: 5, group: "Nacht" },
    { name: "Zimmer", area: 12, count: 3, group: "Nacht" },
  ],
});

const labels = { levelName: "Raumprogramm", area: (a: number) => `${a.toFixed(1)} m²`, groupTitle: (n: string, a: number) => `${n} · ${a.toFixed(1)} m²` };

describe("Räume generieren", () => {
  it("neues Blatt, Rechtecke mit Soll-Fläche im Verhältnis 4:3, Ist unverändert", () => {
    const p = withProgram();
    const sheet = buildProgramSheet(p, labels, "t1");
    expect(sheet.level.kind).toBe("drawing");
    expect(sheet.level.name).toBe("Raumprogramm");
    const rects = sheet.drawings.filter((d) => d.geom.shape === "rect");
    expect(rects).toHaveLength(1 + 1 + 3);
    const areas = rects.map((d) => {
      const g = d.geom as { min: { x: number; y: number }; max: { x: number; y: number } };
      const w = g.max.x - g.min.x;
      const h = g.max.y - g.min.y;
      expect(w / h).toBeCloseTo(4 / 3, 9);
      return w * h;
    });
    expect(areas.sort((a, b) => a - b).map((a) => Math.round(a * 1e6) / 1e6)).toEqual([5, 12, 12, 12, 25]);
    // Gruppentitel
    expect(sheet.drawings.filter((d) => d.geom.shape === "text" && (d.geom as { text: string }).text.startsWith("Nacht"))).toHaveLength(1);

    const q = addProgramSheet(p, sheet);
    expect(q.drawingLevels).toHaveLength(p.drawingLevels.length + 1);
    expect(q.rooms).toBe(p.rooms);
    expect(computeKennzahlen(q).gf).toBeCloseTo(computeKennzahlen(p).gf, 9);
    expect(computeAreaTable(q).total.ngf).toBeCloseTo(computeAreaTable(p).total.ngf, 9);
    expect(compareRoomProgram(q).total.ist).toBeCloseTo(compareRoomProgram(p).total.ist, 9);
    // zweites Mal: eindeutiger Name
    expect(buildProgramSheet(q, labels, "t2").level.name).toBe("Raumprogramm 2");
    expect(new Set(q.drawings2d.map((d) => d.id)).size).toBe(q.drawings2d.length);
  });
  it("leeres Programm → nichts", () => {
    const p: Project = { ...sampleProject, roomProgram: [] };
    const s = buildProgramSheet(p, labels, "x");
    expect(s.drawings).toHaveLength(0);
    expect(addProgramSheet(p, s)).toBe(p);
    expect(layoutRoomProgram(p).items).toHaveLength(0);
  });
});
