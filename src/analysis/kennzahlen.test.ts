import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { computeKennzahlen, checkRoomProgram, solidVolume } from "./kennzahlen";

const sq = (x: number, y: number, s: number) => [
  { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
];

describe("solidVolume", () => {
  it("Prisma, Kegelstumpf (taper) und Kreis", () => {
    const base = { id: "s", type: "extrudedSolid" as const, levelId: "eg", points: sq(0, 0, 2), height: 3 };
    expect(solidVolume(base)).toBeCloseTo(12, 9);
    expect(solidVolume({ ...base, taper: 1 })).toBeCloseTo(4, 9); // Pyramide = A·h/3
    const r = { ...base, circle: { center: { x: 0, y: 0 }, r: 1 } };
    expect(solidVolume(r)).toBeCloseTo(Math.PI * 3, 9);
  });
});

describe("computeKennzahlen", () => {
  const rooms = (p: Project) => p.rooms ?? [];
  it("GF/aGF je Geschoss aus Räumen und Summe", () => {
    const k = computeKennzahlen(sampleProject);
    const total = rooms(sampleProject).reduce((s, r) => s + Math.abs(areaOf(r.boundary)), 0);
    expect(k.gf).toBeCloseTo(total, 6);
    expect(k.levels.reduce((s, l) => s + l.gf, 0)).toBeCloseTo(k.gf, 6);
  });
  it("Ziffern nur mit Parzellenfläche", () => {
    expect(computeKennzahlen(sampleProject).az).toBeNull();
    const k = computeKennzahlen({ ...sampleProject, parcelArea: 1000 });
    expect(k.az).toBeCloseTo(k.agf / 1000, 9);
  });
  it("Gebäudevolumen aus freien Körpern, Abzugskörper zählen negativ nicht mit", () => {
    const p: Project = {
      ...sampleProject,
      extrudedSolids: [
        { id: "a", type: "extrudedSolid", levelId: sampleProject.drawingLevels[0].id, points: sq(0, 0, 10), height: 3 } as never,
        { id: "b", type: "extrudedSolid", levelId: sampleProject.drawingLevels[0].id, points: sq(0, 0, 1), height: 3, operation: "subtract" } as never,
      ],
    };
    const k = computeKennzahlen(p);
    expect(k.gv).toBeCloseTo(300 - 3, 6);
  });
});

function areaOf(pts: { x: number; y: number }[]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const q = pts[(i + 1) % pts.length]; a += pts[i].x * q.y - q.x * pts[i].y; }
  return a / 2;
}

describe("checkRoomProgram", () => {
  it("meldet fehlend, zu klein, zu gross und überzählig", () => {
    const p: Project = {
      ...sampleProject,
      rooms: [
        { ...(sampleProject.rooms ?? [])[0], id: "r1", name: "Wohnen", boundary: sq(0, 0, 5) },
        { ...(sampleProject.rooms ?? [])[0], id: "r2", name: "Bad", boundary: sq(10, 0, 2) },
        { ...(sampleProject.rooms ?? [])[0], id: "r3", name: "Keller", boundary: sq(20, 0, 2) },
      ],
      roomProgram: [
        { name: "Wohnen", area: 30 },
        { name: "Bad", area: 4 },
        { name: "Büro", area: 12 },
      ],
    };
    const r = checkRoomProgram(p);
    const by = Object.fromEntries(r.rows.map((x) => [x.name, x]));
    expect(by.Wohnen.status).toBe("zu klein"); // 25 < 30
    expect(by.Bad.status).toBe("ok");
    expect(by["Büro"].status).toBe("fehlt");
    expect(r.extra.map((e) => e.name)).toEqual(["Keller"]);
  });
});
