import { describe, expect, it } from "vitest";
import { emptyProject, sampleProject } from "../model/sampleProject";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import type { Project, Room, Wall } from "../model/types";
import { computeKennzahlen, checkRoomProgram, solidVolume } from "./kennzahlen";
import { computeAreaTable, computeIvhb } from "./areaTable";

const sq = (x: number, y: number, s: number) => [
  { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
];

describe("solidVolume", () => {
  it("Prisma, Kegelstumpf (taper) und Kreis", () => {
    const base = { id: "s", type: "extrudedSolid" as const, categoryCode: "20", levelId: "eg", points: sq(0, 0, 2), height: 3 };
    expect(solidVolume(base)).toBeCloseTo(12, 9);
    expect(solidVolume({ ...base, taper: 1 })).toBeCloseTo(4, 9); // Pyramide = A·h/3
    const r = { ...base, circle: { center: { x: 0, y: 0 }, r: 1 } };
    expect(solidVolume(r)).toBeCloseTo(Math.PI * 3, 9);
  });
});

describe("computeKennzahlen", () => {
  const rooms = (p: Project) => p.rooms ?? [];
  it("GF = NGF + KF je Geschoss (SIA 416), NGF aus den Räumen, Summe", () => {
    const k = computeKennzahlen(sampleProject);
    const total = rooms(sampleProject).reduce((s, r) => s + Math.abs(areaOf(r.boundary)), 0);
    expect(k.ngf).toBeCloseTo(total, 6);
    expect(k.gf).toBeCloseTo(k.ngf + k.kf, 6);
    expect(k.kf).toBeGreaterThan(0);
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
        { id: "a", type: "extrudedSolid", categoryCode: "20", levelId: sampleProject.drawingLevels[0].id, points: sq(0, 0, 10), height: 3 } as never,
        { id: "b", type: "extrudedSolid", categoryCode: "20", levelId: sampleProject.drawingLevels[0].id, points: sq(0, 0, 1), height: 3, operation: "subtract" } as never,
      ],
    };
    const k = computeKennzahlen(p);
    expect(k.gv).toBeCloseTo(300 - 3, 6);
  });
  it("[206] ohne freie Körper: GV wie die Flächentabelle (GF × Geschosshöhe), nicht 0", () => {
    const k = computeKennzahlen(sampleProject);
    expect(k.gv).toBeGreaterThan(0);
    expect(k.gv).toBeCloseTo(computeAreaTable(sampleProject).gv, 6);
  });
});

/** Testgebäude des Referenz-Ablaufs (`e2e/release10.spec.ts`): Aussenwände 12 × 10 m, ein Raum innen, Parzelle 30 × 30 m. */
function release10Project(): Project {
  const P = (x: number, y: number) => ({ x, y });
  const c = [P(48, 46), P(60, 46), P(60, 56), P(48, 56)];
  const walls: Wall[] = c.map((a, i) => ({ id: `w${i}`, type: "wall", floorId: "eg", categoryCode: "20", start: a, end: c[(i + 1) % 4], wallTypeId: "aw", height: 2.6 }) as Wall);
  const t = 0.345 / 2;
  const room = { id: "r1", type: "room", floorId: "eg", categoryCode: "40", name: "Raum 1", color: "#eee", siaCategory: "HNF", boundary: [P(48 + t, 46 + t), P(60 - t, 46 + t), P(60 - t, 56 - t), P(48 + t, 56 - t)] } as Room;
  return { ...emptyProject, walls, rooms: [room], siteRules: { parcel: [P(38, 38), P(68, 38), P(68, 68), P(38, 68)] } as Project["siteRules"] };
}

describe("[225] Kennzahlenleiste = Flächentabelle (eine Quelle, SIA 416)", () => {
  const cases: [string, () => Project][] = [
    ["Musterhaus", () => ({ ...sampleProject, parcelArea: 600 })],
    ["Musterhaus komplex", () => buildComplexSampleProject()],
    ["Referenz-Ablauf (release10)", release10Project],
  ];
  it.each(cases)("%s", (_name, make) => {
    const p = make();
    const k = computeKennzahlen(p);
    const tab = computeAreaTable(p);
    const iv = computeIvhb(p);
    expect(k.gf).toBeCloseTo(tab.total.gf, 9);
    expect(k.ngf).toBeCloseTo(tab.total.ngf, 9);
    expect(k.hnf).toBeCloseTo(tab.total.hnf, 9);
    expect(k.gv).toBeCloseTo(tab.gv, 9);
    expect(k.agf).toBeCloseTo(iv.agf, 9);
    expect(k.az).toEqual(iv.az);
    expect(k.uez).toEqual(iv.uz);
    expect(k.levels.map((l) => l.gf)).toEqual(tab.levels.map((l) => l.gf));
  });
  it("Referenz-Ablauf: GF 127.7 m² (NGF 112.5 + KF), nicht nur die Räume", () => {
    const k = computeKennzahlen(release10Project());
    expect(k.ngf).toBeCloseTo(11.655 * 9.655, 3);
    expect(k.gf).toBeGreaterThan(k.ngf + 10);
    expect(k.uez).not.toBeNull();
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

describe("checkRoomProgram mit unfertiger Zeile", () => {
  it("leerer Name zieht keine Räume an sich", () => {
    const n = (sampleProject.rooms ?? []).length;
    const c = checkRoomProgram({ ...sampleProject, roomProgram: [{ name: "  ", area: 10 }] });
    expect(c.rows[0].status).toBe("fehlt");
    expect(c.rows[0].count).toBe(0);
    expect(c.extra.length).toBe(n);
  });
});
