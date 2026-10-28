// Schnittlinien-Befehl: der reine Datenpfad (commitLine/nextLevelName) — setzt
// die Grundriss-Schnittlinie auf die richtige Ziel-Ebene bzw. legt eine neue an.

import { describe, it, expect } from "vitest";
import { _test } from "./sectionline";
import type { DrawingLevel, Project, Vec2 } from "../../model/types";
import { applyOps } from "../../core/ops";

const { lineOps, nextLevelName } = _test;
const commitLine = (p: Project, a: Vec2, b: Vec2, kind: "section" | "elevation") => applyOps(p, lineOps(p, a, b, kind));

function projectWith(levels: DrawingLevel[]): Project {
  return {
    id: "p",
    name: "T",
    layers: [],
    drawingLevels: levels,
    walls: [],
    drawings2d: [],
  } as unknown as Project;
}

const a = { x: 0, y: 0 };
const b = { x: 5, y: 0 };

describe("sectionline — commitLine", () => {
  it("belegt die EINE Platzhalter-Schnittebene ohne Linie", () => {
    const p = projectWith([
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false },
      { id: "s1", name: "Schnitt A", kind: "section", visible: true, locked: false },
    ]);
    const out = commitLine(p, a, b, "section");
    const s = out.drawingLevels.find((z) => z.id === "s1")!;
    expect(s.linePoints).toEqual([a, b]);
    expect(s.directionSign).toBe(1);
    // Keine neue Ebene angelegt.
    expect(out.drawingLevels).toHaveLength(2);
  });

  it("legt eine NEUE Schnittebene an, wenn keine Platzhalter-Ebene existiert", () => {
    const p = projectWith([
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false },
      {
        id: "s1",
        name: "Schnitt A",
        kind: "section",
        visible: true,
        locked: false,
        linePoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
      },
    ]);
    const out = commitLine(p, a, b, "section");
    expect(out.drawingLevels).toHaveLength(3);
    const created = out.drawingLevels[out.drawingLevels.length - 1];
    expect(created.kind).toBe("section");
    expect(created.linePoints).toEqual([a, b]);
    // Zweite Ebene → Buchstabe B.
    expect(created.name).toContain("B");
  });

  it("legt bei ZWEI Platzhaltern (mehrdeutig) eine neue Ebene an", () => {
    const p = projectWith([
      { id: "s1", name: "Schnitt A", kind: "section", visible: true, locked: false },
      { id: "s2", name: "Schnitt B", kind: "section", visible: true, locked: false },
    ]);
    const out = commitLine(p, a, b, "section");
    expect(out.drawingLevels).toHaveLength(3);
    // Die bestehenden Platzhalter bleiben unangetastet.
    expect(out.drawingLevels[0].linePoints).toBeUndefined();
    expect(out.drawingLevels[1].linePoints).toBeUndefined();
  });

  it("verwirft entartete (zu kurze) Linien", () => {
    const p = projectWith([
      { id: "s1", name: "Schnitt A", kind: "section", visible: true, locked: false },
    ]);
    const out = commitLine(p, a, { x: 0.02, y: 0 }, "section");
    expect(out).toBe(p);
  });

  it("trennt Schnitt- und Ansichts-Ebenen (kind)", () => {
    const p = projectWith([
      { id: "s1", name: "Schnitt A", kind: "section", visible: true, locked: false },
    ]);
    // Ansichtslinie darf die Schnitt-Platzhalter-Ebene NICHT belegen.
    const out = commitLine(p, a, b, "elevation");
    expect(out.drawingLevels).toHaveLength(2);
    expect(out.drawingLevels[0].linePoints).toBeUndefined();
    expect(out.drawingLevels[1].kind).toBe("elevation");
  });
});

describe("sectionline — nextLevelName", () => {
  it("zählt Buchstaben je Art hoch (A, B, C …)", () => {
    const p0 = projectWith([]);
    expect(nextLevelName(p0, "section")).toContain("A");
    const p1 = projectWith([
      { id: "s1", name: "Schnitt A", kind: "section", visible: true, locked: false },
    ]);
    expect(nextLevelName(p1, "section")).toContain("B");
  });
});
