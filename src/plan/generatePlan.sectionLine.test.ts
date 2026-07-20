/**
 * Schnittführungs-Symbol im Grundriss (generatePlan → addSectionLines): jede
 * Schnitt-/Ansichtsebene MIT `linePoints` erzeugt eine Strichpunkt-Linie
 * (cls "section-line"), Endmarken + ein unsichtbares Pick-Band (Polygon mit
 * `sectionLineId`). Ebenen OHNE Linie erzeugen nichts.
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { DrawingLevel, Project } from "../model/types";

const visible = new Set(["20", "35"]);

function baseProject(levels: DrawingLevel[]): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: levels,
    layers: [{ code: "20", name: "Wände", color: "#333", lw: 0.18, visible: true, locked: false }],
    walls: [],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  } as unknown as Project;
}

const floor: DrawingLevel = {
  id: "eg",
  name: "EG",
  kind: "floor",
  visible: true,
  locked: false,
  floorHeight: 2.6,
  cutHeight: 1.0,
  baseElevation: 0,
};

describe("generatePlan — Schnittführungs-Symbol", () => {
  it("zeichnet Linie + Pick-Band für eine Schnittebene mit linePoints", () => {
    const p = baseProject([
      floor,
      {
        id: "s-a",
        name: "Schnitt A",
        kind: "section",
        visible: true,
        locked: false,
        linePoints: [{ x: 0, y: 2 }, { x: 6, y: 2 }],
        directionSign: 1,
      },
    ]);
    const prims = generatePlan(p, "eg", visible).primitives;
    // Strichpunkt-Hauptlinie vorhanden.
    const lines = prims.filter((pr) => pr.kind === "line" && pr.cls === "section-line");
    expect(lines.length).toBeGreaterThan(0);
    // Pick-Band trägt die Level-Id.
    const band = prims.find((pr) => pr.kind === "polygon" && pr.sectionLineId === "s-a");
    expect(band).toBeTruthy();
    // Label-Text (Kurz-Tag „A") an den Enden.
    const labels = prims.filter((pr) => pr.kind === "drawingText" && pr.text === "A");
    expect(labels.length).toBe(2);
  });

  it("zeichnet NICHTS für eine Schnittebene ohne linePoints", () => {
    const p = baseProject([
      floor,
      { id: "s-b", name: "Schnitt B", kind: "section", visible: true, locked: false },
    ]);
    const prims = generatePlan(p, "eg", visible).primitives;
    expect(prims.some((pr) => pr.kind === "polygon" && pr.sectionLineId != null)).toBe(false);
    expect(prims.some((pr) => pr.kind === "line" && pr.cls === "section-line")).toBe(false);
  });

  it("zeichnet NICHTS für eine unsichtbare Schnittebene (visible=false)", () => {
    const p = baseProject([
      floor,
      {
        id: "s-hidden",
        name: "Schnitt C",
        kind: "section",
        visible: false,
        locked: false,
        linePoints: [{ x: 0, y: 2 }, { x: 6, y: 2 }],
        directionSign: 1,
      },
    ]);
    const prims = generatePlan(p, "eg", visible).primitives;
    expect(prims.some((pr) => pr.kind === "polygon" && pr.sectionLineId === "s-hidden")).toBe(false);
    expect(prims.some((pr) => pr.kind === "line" && pr.cls === "section-line")).toBe(false);
  });

  it("behandelt Ansichtsebenen (elevation) gleich", () => {
    const p = baseProject([
      floor,
      {
        id: "e-a",
        name: "Ansicht Süd",
        kind: "elevation",
        visible: true,
        locked: false,
        linePoints: [{ x: 0, y: 0 }, { x: 4, y: 0 }],
        directionSign: -1,
      },
    ]);
    const prims = generatePlan(p, "eg", visible).primitives;
    expect(prims.some((pr) => pr.kind === "polygon" && pr.sectionLineId === "e-a")).toBe(true);
  });
});
