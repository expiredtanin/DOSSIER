/**
 * `generatePlan` — Rendering des Detail-/Schnitt-Verweis-Symbols
 * (`shape:"detailref"`): Kreis + waagrechte Trennlinie + Bezeichner oben +
 * Blattname unten (aufgelöst über `sheetLayoutId`, sonst manueller
 * `sheetLabel`-Platzhalter, s. `drawing2d.ts`).
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Drawing2D, Layout, Project } from "../model/types";

function detailRefDrawing(
  id: string,
  extra: Partial<Extract<Drawing2D["geom"], { shape: "detailref" }>> = {},
): Drawing2D {
  return {
    id,
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: { shape: "detailref", at: { x: 2, y: 1 }, label: "A", ...extra },
  };
}

function project(drawings: Drawing2D[], layouts: Layout[] = []): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: drawings,
    context: [],
    layouts,
  } as unknown as Project;
}

const visible = new Set(["20"]);

describe("generatePlan — Drawing2D detailref", () => {
  it("erzeugt einen Kreis + eine Trennlinie + einen Label-Text (ohne Blattbezug)", () => {
    const p = project([detailRefDrawing("d1")]);
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const circles = plan.primitives.filter((pr) => pr.kind === "drawingCircle");
    const lines = plan.primitives.filter((pr) => pr.kind === "line" && pr.drawingId === "d1");
    const texts = plan.primitives.filter((pr) => pr.kind === "drawingText" && pr.drawingId === "d1");
    expect(circles.length).toBe(1);
    expect(lines.length).toBe(1); // nur die Trennlinie
    expect(texts.length).toBe(1); // nur das Label, kein leerer Blattname
    expect(texts[0].kind === "drawingText" && texts[0].text).toBe("A");
  });

  it("Kreis-Zentrum entspricht 'at'", () => {
    const p = project([detailRefDrawing("d1")]);
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const circle = plan.primitives.find((pr) => pr.kind === "drawingCircle");
    expect(circle && circle.kind === "drawingCircle" && circle.center).toEqual({ x: 2, y: 1 });
  });

  it("mit manuellem sheetLabel (keine Blattverknüpfung): zweiter Text zeigt den manuellen Platzhalter", () => {
    const p = project([detailRefDrawing("d1", { sheetLabel: "A-102" })]);
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const texts = plan.primitives.filter((pr) => pr.kind === "drawingText" && pr.drawingId === "d1");
    expect(texts.length).toBe(2);
    const bodies = texts.map((t) => t.kind === "drawingText" && t.text);
    expect(bodies).toContain("A");
    expect(bodies).toContain("A-102");
  });

  it("mit gültiger sheetLayoutId: zeigt den ECHTEN Blattnamen, nicht den manuellen sheetLabel", () => {
    const layout: Layout = {
      id: "L1",
      name: "02 Grundriss OG",
      paper: "a3",
      orientation: "landscape",
      viewports: [],
    };
    const p = project(
      [detailRefDrawing("d1", { sheetLayoutId: "L1", sheetLabel: "veralteter Platzhalter" })],
      [layout],
    );
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const texts = plan.primitives.filter((pr) => pr.kind === "drawingText" && pr.drawingId === "d1");
    const bodies = texts.map((t) => t.kind === "drawingText" && t.text);
    expect(bodies).toContain("02 Grundriss OG");
    expect(bodies).not.toContain("veralteter Platzhalter");
  });

  it("gelöschtes/unbekanntes verknüpftes Blatt fällt auf den manuellen sheetLabel zurück", () => {
    const p = project([detailRefDrawing("d1", { sheetLayoutId: "does-not-exist", sheetLabel: "Fallback" })]);
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const texts = plan.primitives.filter((pr) => pr.kind === "drawingText" && pr.drawingId === "d1");
    const bodies = texts.map((t) => t.kind === "drawingText" && t.text);
    expect(bodies).toContain("Fallback");
  });
});
