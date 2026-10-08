// Objekt-Sperre (`isLocked`/`setLocked`/`setLockedForMembers`) — reine
// Funktionen, s. objectLock.ts. Deckt alle acht `MemberKind`-Arten ab.

import { describe, it, expect } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { isLocked, setLocked, setLockedForMembers } from "./objectLock";
import type { Project, Wall, Drawing2D } from "../model/types";

const wall: Wall = {
  id: "w1",
  type: "wall",
  floorId: "eg",
  categoryCode: "20",
  start: { x: 0, y: 0 },
  end: { x: 4, y: 0 },
  wallTypeId: sampleProject.wallTypes[0]?.id ?? "wt1",
  height: 2.6,
};

const drawing: Drawing2D = {
  id: "d1",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } },
};

function project(overrides: Partial<Project>): Project {
  return { ...sampleProject, walls: [wall], drawings2d: [drawing], ...overrides };
}

describe("isLocked", () => {
  it("liefert false für ein Element ohne locked-Feld (Default/Alt-Daten)", () => {
    expect(isLocked(project({}), "wallIds", "w1")).toBe(false);
  });

  it("liefert false für eine unbekannte ID (kein Crash)", () => {
    expect(isLocked(project({}), "wallIds", "does-not-exist")).toBe(false);
  });

  it("liefert true, wenn locked explizit gesetzt ist", () => {
    const p = project({ walls: [{ ...wall, locked: true }] });
    expect(isLocked(p, "wallIds", "w1")).toBe(true);
  });

  it("funktioniert für drawingIds (Drawing2D)", () => {
    const p = project({ drawings2d: [{ ...drawing, locked: true }] });
    expect(isLocked(p, "drawingIds", "d1")).toBe(true);
  });
});

describe("setLocked", () => {
  it("setzt locked=true immutabel, andere Elemente bleiben unverändert", () => {
    const otherWall: Wall = { ...wall, id: "w2" };
    const p = project({ walls: [wall, otherWall] });
    const next = setLocked(p, "wallIds", "w1", true);
    expect(next).not.toBe(p);
    expect(next.walls.find((w) => w.id === "w1")?.locked).toBe(true);
    expect(next.walls.find((w) => w.id === "w2")?.locked).toBeUndefined();
    // Ursprüngliches Projekt unverändert (Immutabilität).
    expect(p.walls.find((w) => w.id === "w1")?.locked).toBeUndefined();
  });

  it("setzt locked=false zum Entsperren", () => {
    const p = project({ walls: [{ ...wall, locked: true }] });
    const next = setLocked(p, "wallIds", "w1", false);
    expect(next.walls[0].locked).toBe(false);
  });

  it("ist ein No-Op für eine unbekannte ID", () => {
    const p = project({});
    const next = setLocked(p, "wallIds", "does-not-exist", true);
    expect(next.walls).toEqual(p.walls);
  });
});

describe("setLockedForMembers", () => {
  it("sperrt mehrere Elementarten in einem Zug", () => {
    const p = project({});
    const next = setLockedForMembers(p, { wallIds: ["w1"], drawingIds: ["d1"] }, true);
    expect(isLocked(next, "wallIds", "w1")).toBe(true);
    expect(isLocked(next, "drawingIds", "d1")).toBe(true);
  });

  it("leere/fehlende Felder werden übersprungen (kein Crash)", () => {
    const p = project({});
    const next = setLockedForMembers(p, { wallIds: [] }, true);
    expect(next.walls).toEqual(p.walls);
  });
});
