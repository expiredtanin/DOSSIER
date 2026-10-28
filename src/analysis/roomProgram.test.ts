import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { compareRoomProgram } from "./roomProgram";

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

describe("compareRoomProgram", () => {
  it("Soll, Ist, Differenz, Ampel und Summen", () => {
    const c = compareRoomProgram(withProgram());
    expect(c.tolerance).toBe(0.05);
    expect(c.rows.map((r) => r.status)).toEqual(["ok", "zu klein", "fehlt"]);
    expect(c.rows[1].diff).toBeCloseTo(-1, 9);
    expect(c.rows[1].diffPct).toBeCloseTo(-0.2, 9);
    expect(c.rows.map((r) => r.light)).toEqual(["green", "red", "red"]);
    expect(c.total.soll).toBeCloseTo(25 + 5 + 36, 9);
    expect(c.total.ist).toBeCloseTo(29, 9);
    expect(c.groups.map((g) => g.key)).toEqual(["Tag", "Nacht"]);
  });
  it("Toleranz aus dem Projekt", () => {
    const c = compareRoomProgram({ ...withProgram(), roomProgramTolerance: 0.25 });
    expect(c.rows[1].status).toBe("ok");
  });
});
