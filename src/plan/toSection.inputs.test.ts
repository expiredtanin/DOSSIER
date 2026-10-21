import { describe, expect, it } from "vitest";
import type { DrawingLevel, Project } from "../model/types";
import { sameSectionInputs, sameSectionLine } from "./toSection";

const project = { walls: [], drawings2d: [], ceilings: [] } as unknown as Project;

describe("sameSectionInputs", () => {
  it("2D-Zeichnungen (z. B. Linien im Schnitt) lösen keine Neuberechnung aus", () => {
    expect(sameSectionInputs(project, { ...project, drawings2d: [] })).toBe(true);
  });
  it("Bauteil-Änderungen schon", () => {
    expect(sameSectionInputs(project, { ...project, walls: [] })).toBe(false);
  });
});

describe("sameSectionLine", () => {
  const lv: DrawingLevel = {
    id: "s",
    name: "S",
    kind: "section",
    visible: true,
    locked: false,
    linePoints: [{ x: 0, y: 0 }, { x: 5, y: 0 }],
  };
  it("Name/Unterlage egal, Linie/Richtung/Tiefe nicht", () => {
    expect(sameSectionLine(lv, { ...lv, name: "X", planUnderlayId: "eg", hiddenLines: true })).toBe(true);
    expect(sameSectionLine(lv, { ...lv, linePoints: [{ x: 0, y: 0 }, { x: 5, y: 1 }] })).toBe(false);
    expect(sameSectionLine(lv, { ...lv, directionSign: -1 })).toBe(false);
    expect(sameSectionLine(lv, { ...lv, depth: 3 })).toBe(false);
  });
});
