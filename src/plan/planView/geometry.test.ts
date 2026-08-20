/**
 * `marqueeHitDrawings` — Rahmenauswahl von 2D-Zeichenelementen. Vorher fehlten
 * drawingCircle/drawingArc/drawingText/drawingImage komplett (nur line/polygon
 * abgedeckt) — Regressionsschutz für den Nachzieh-Fix (2D-Vervollständigung,
 * Fund A).
 */

import { describe, it, expect } from "vitest";
import { marqueeHitDrawings, type ModelRect } from "./geometry";
import type { Primitive } from "../generatePlan";

const encloseRect: ModelRect = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
const missRect: ModelRect = { minX: 20, minY: 20, maxX: 30, maxY: 30 };

describe("marqueeHitDrawings — Kreis/Bogen/Text/Bild", () => {
  it("Kreis vollständig im Rechteck → window-Treffer", () => {
    const prims: Primitive[] = [
      {
        kind: "drawingCircle",
        center: { x: 0, y: 0 },
        r: 2,
        fill: "none",
        stroke: "#000",
        weightMm: 0.25,
        drawingId: "c1",
      },
    ];
    expect(marqueeHitDrawings(prims, encloseRect, false)).toEqual(["c1"]);
    expect(marqueeHitDrawings(prims, missRect, false)).toEqual([]);
  });

  it("Bogen wird nur auf seiner Winkel-Spanne abgetastet (nicht als Vollkreis)", () => {
    // Viertelbogen 0..PI/2 bei r=2 um den Ursprung: liegt komplett im 1. Quadranten.
    const prims: Primitive[] = [
      {
        kind: "drawingArc",
        center: { x: 0, y: 0 },
        r: 2,
        a0: 0,
        a1: Math.PI / 2,
        stroke: "#000",
        weightMm: 0.25,
        drawingId: "a1",
      },
    ];
    // Rechteck deckt NUR den 1. Quadranten ab — ein Vollkreis-Sampling würde
    // hier fälschlich als "nicht enclosed" durchfallen (Punkte im 3. Quadranten
    // wären ausserhalb), der Viertelbogen muss aber als vollständig erfasst gelten.
    const q1Rect: ModelRect = { minX: -0.1, minY: -0.1, maxX: 2.1, maxY: 2.1 };
    expect(marqueeHitDrawings(prims, q1Rect, false)).toEqual(["a1"]);
  });

  it("Text-Bbox wird erfasst (vorher: gar nicht per Marquee erfassbar)", () => {
    const prims: Primitive[] = [
      {
        kind: "drawingText",
        at: { x: 1, y: 1 },
        text: "Hallo",
        heightM: 0.3,
        angle: 0,
        color: "#000",
        drawingId: "t1",
      },
    ];
    expect(marqueeHitDrawings(prims, encloseRect, false)).toEqual(["t1"]);
    expect(marqueeHitDrawings(prims, missRect, false)).toEqual([]);
  });

  it("Bild-Bbox wird erfasst (vorher: gar nicht per Marquee erfassbar)", () => {
    const prims: Primitive[] = [
      {
        kind: "drawingImage",
        min: { x: -1, y: -1 },
        max: { x: 1, y: 1 },
        src: "data:image/png;base64,",
        opacity: 1,
        drawingId: "i1",
      },
    ];
    expect(marqueeHitDrawings(prims, encloseRect, false)).toEqual(["i1"]);
    expect(marqueeHitDrawings(prims, missRect, false)).toEqual([]);
  });

  it("crossing-Modus: Kreis, der das Rechteck nur teilweise überlappt, zählt bereits; window-Modus nicht", () => {
    // Zentrum ausserhalb, Radius reicht bei Winkel 0 klar ins Rechteck hinein
    // (x=15+6=21, innerhalb [10,20]) — aber nicht der ganze Ring liegt drin.
    const prims: Primitive[] = [
      {
        kind: "drawingCircle",
        center: { x: 15, y: 0 },
        r: 6,
        fill: "none",
        stroke: "#000",
        weightMm: 0.25,
        drawingId: "c2",
      },
    ];
    const rightRect: ModelRect = { minX: 10, minY: -10, maxX: 20, maxY: 10 };
    expect(marqueeHitDrawings(prims, rightRect, true)).toEqual(["c2"]);
    expect(marqueeHitDrawings(prims, rightRect, false)).toEqual([]);
  });
});
