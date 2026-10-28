/**
 * Eckpunkt-Griffe einer Textspalte (`Drawing2DGeom["text"]` mit `width`
 * gesetzt) — Nutzer-Wunsch: "nicht nur ein Griff unten links bei der ersten
 * Glyphe" (vorher: `drawingVertices` lieferte für Text IMMER nur `[at]`,
 * unabhängig von `width`). Vier Rahmen-Ecken als Griffe (s.
 * `text/textFrame.ts` `textFrameCorners`); Ziehen ändert NUR die Spaltenbreite
 * (`width`) — InDesign-Textrahmen-Verhalten (Nutzer-Entscheidung), nicht die
 * Schriftgrösse. Einzeiliger Text OHNE `width` bleibt beim bisherigen
 * Einzel-Anker-Griff (kein Regressions-Risiko für den Alltagsfall).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import { drawingVertices } from "./projectSlice";
import { textFrameCorners } from "../text/textFrame";
import type { Drawing2D } from "../model/types";

const plainText: Drawing2D = {
  id: "d-text-plain",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: { shape: "text", at: { x: 1, y: 1 }, text: "Hallo", height: 0.2, angle: 0 },
};

const textBox: Drawing2D = {
  id: "d-text-box",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: {
    shape: "text",
    at: { x: 0, y: 0 },
    text: "Ein langer Textspalten-Inhalt, der umbricht",
    height: 0.2,
    angle: 0,
    width: 1.5,
  },
};

const rotatedTextBox: Drawing2D = {
  id: "d-text-box-rot",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: {
    shape: "text",
    at: { x: 5, y: 5 },
    text: "Ein langer Textspalten-Inhalt, der umbricht",
    height: 0.2,
    angle: Math.PI / 2,
    width: 1.5,
  },
};

beforeEach(() => {
  setState({
    project: {
      ...sampleProject,
      drawings2d: [plainText, textBox, rotatedTextBox],
    },
    undoDepth: 0,
    redoDepth: 0,
    canUndo: false,
    canRedo: false,
  });
});

describe("drawingVertices — Text", () => {
  it("einzeiliger Text OHNE width liefert weiterhin nur den Anker-Griff (kein Regressions-Risiko)", () => {
    expect(drawingVertices(plainText)).toEqual([{ x: 1, y: 1 }]);
  });

  it("Textspalte MIT width liefert vier Rahmen-Eck-Griffe (deckt sich mit textFrameCorners)", () => {
    const v = drawingVertices(textBox);
    expect(v).toHaveLength(4);
    const g = textBox.geom as Extract<Drawing2D["geom"], { shape: "text" }>;
    const expected = textFrameCorners({
      at: g.at,
      text: g.text,
      heightM: g.height,
      angle: g.angle,
      wrapWidth: g.width,
    });
    expect(v).toEqual(expected);
  });
});

describe("moveGripOf — Textspalten-Eckpunkte (nur Breite, keine Schriftgrösse)", () => {
  it("rechte Ecke ziehen ändert NUR width — `at` bleibt fest", () => {
    // Index 1 = oben-rechts (s. textFrameCorners-Reihenfolge). Rahmenbreite
    // war 1.5 m ab at.x=0 → Ziehen auf x=2.5 macht daraus 2.5 m.
    const v = drawingVertices(textBox);
    getState().moveGripOf("d-text-box", null, 1, { x: 2.5, y: v[1].y });
    const g = getState().project.drawings2d.find((d) => d.id === "d-text-box")!.geom;
    expect(g.shape).toBe("text");
    if (g.shape === "text") {
      expect(g.width).toBeCloseTo(2.5, 6);
      expect(g.at).toEqual({ x: 0, y: 0 });
    }
  });

  it("linke Ecke ziehen verschiebt `at.x` UND ändert width — die RECHTE Kante bleibt fest", () => {
    // Index 0 = oben-links. Rechte Kante liegt bei at.x+width = 0+1.5 = 1.5.
    // Linke Ecke von x=0 auf x=-0.5 gezogen → neue Breite 2.0, at.x=-0.5.
    const v = drawingVertices(textBox);
    getState().moveGripOf("d-text-box", null, 0, { x: -0.5, y: v[0].y });
    const g = getState().project.drawings2d.find((d) => d.id === "d-text-box")!.geom;
    expect(g.shape).toBe("text");
    if (g.shape === "text") {
      expect(g.at.x).toBeCloseTo(-0.5, 6);
      expect(g.width).toBeCloseTo(2.0, 6);
      // Rechte Kante unverändert bei 1.5.
      expect(g.at.x + (g.width ?? 0)).toBeCloseTo(1.5, 6);
    }
  });

  it("Breite kann nicht unter die Mindestbreite schrumpfen (kein invertiertes/negatives width)", () => {
    const v = drawingVertices(textBox);
    getState().moveGripOf("d-text-box", null, 1, { x: -10, y: v[1].y }); // weit über die linke Kante hinaus
    const g = getState().project.drawings2d.find((d) => d.id === "d-text-box")!.geom;
    expect(g.shape).toBe("text");
    if (g.shape === "text") {
      expect(g.width).toBeGreaterThan(0);
    }
  });

  it("Y-Komponente des Zugs wird ignoriert — nur die lokale Breiten-Richtung zählt (auch bei 90° Rotation)", () => {
    // Bei angle=90° zeigt die "Breiten-Richtung" (lokale x-Achse) im
    // Modell nach +y. Ziehen der rechten Ecke rein in y-Richtung muss die
    // Breite ändern, at aber unverändert lassen.
    getState().moveGripOf("d-text-box-rot", null, 1, { x: 5, y: 7.5 }); // 2.5 m "weiter" in lokaler Breiten-Richtung
    const g = getState().project.drawings2d.find((d) => d.id === "d-text-box-rot")!.geom;
    expect(g.shape).toBe("text");
    if (g.shape === "text") {
      expect(g.width).toBeCloseTo(2.5, 6);
      expect(g.at).toEqual({ x: 5, y: 5 });
    }
  });
});
