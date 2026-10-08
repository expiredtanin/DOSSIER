/**
 * Rotate-Befehl: beide Eingabewege (getippter Winkel bzw. Referenz + neue
 * Richtung) und der No-op bei leerer Auswahl.
 */

import { describe, expect, it } from "vitest";
import { rotateCommand } from "./rotate";
import { sampleProject } from "../../model/sampleProject";
import type { CommandContext, CommandSelection, CommandState, Project, Vec2 } from "../types";

/** Eine Linie von (0,0) nach (2,0) als Testobjekt. */
function projectWithLine(): Project {
  return {
    ...sampleProject,
    drawings2d: [
      {
        id: "ln",
        type: "drawing2d",
        levelId: sampleProject.drawingLevels[0].id,
        categoryCode: sampleProject.layers[0].code,
        geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 2, y: 0 } },
      },
    ],
  };
}

const EMPTY_SEL: CommandSelection = { wallIds: [], drawingId: null };
const LINE_SEL: CommandSelection = { wallIds: [], drawingId: "ln" };

function ctxFor(project: Project, selection: CommandSelection): CommandContext {
  return {
    project,
    selection,
    level: project.drawingLevels[0],
    defaultCategoryCode: project.layers[0].code,
  } as CommandContext;
}

/** Spielt Eingaben ab und liefert das (ggf. committete) Projekt. */
function run(
  inputs: ({ pt: Vec2 } | { num: number })[],
  selection: CommandSelection = LINE_SEL,
): Project {
  let state: CommandState = rotateCommand.init();
  let project = projectWithLine();
  for (const step of inputs) {
    const input = "pt" in step ? ({ kind: "point", point: step.pt } as const) : ({ kind: "number", value: step.num } as const);
    const [next, res] = rotateCommand.onInput(state, input, ctxFor(project, selection));
    state = next;
    if (res.commit) project = res.commit(project);
  }
  return project;
}

const line = (p: Project) => {
  const g = p.drawings2d[0].geom;
  if (g.shape !== "line") throw new Error("keine Linie");
  return g;
};

describe("rotate — getippter Winkel", () => {
  it("dreht um den gewählten Drehpunkt (90° um den Ursprung)", () => {
    const g = line(run([{ pt: { x: 0, y: 0 } }, { num: 90 }]));
    expect(g.a.x).toBeCloseTo(0, 9);
    expect(g.a.y).toBeCloseTo(0, 9);
    // (2,0) → (0,2)
    expect(g.b.x).toBeCloseTo(0, 9);
    expect(g.b.y).toBeCloseTo(2, 9);
  });

  it("der Drehpunkt bleibt fix — auch abseits des Objekts", () => {
    const g = line(run([{ pt: { x: 2, y: 0 } }, { num: 180 }]));
    // Drehpunkt (2,0): (0,0) → (4,0), (2,0) bleibt.
    expect(g.a.x).toBeCloseTo(4, 9);
    expect(g.b.x).toBeCloseTo(2, 9);
  });

  it("negative Winkel drehen im Uhrzeigersinn", () => {
    const g = line(run([{ pt: { x: 0, y: 0 } }, { num: -90 }]));
    expect(g.b.y).toBeCloseTo(-2, 9);
  });
});

describe("rotate — Referenz + neue Richtung", () => {
  it("dreht um den Winkel ZWISCHEN den beiden Richtungen", () => {
    // Referenz zeigt nach +X, Ziel nach +Y ⇒ 90°.
    const g = line(run([{ pt: { x: 0, y: 0 } }, { pt: { x: 1, y: 0 } }, { pt: { x: 0, y: 5 } }]));
    expect(g.b.x).toBeCloseTo(0, 9);
    expect(g.b.y).toBeCloseTo(2, 9);
  });

  it("die LÄNGE der Referenz ist egal — nur die Richtung zählt", () => {
    const near = line(run([{ pt: { x: 0, y: 0 } }, { pt: { x: 1, y: 1 } }, { pt: { x: -1, y: 1 } }]));
    const far = line(run([{ pt: { x: 0, y: 0 } }, { pt: { x: 9, y: 9 } }, { pt: { x: -3, y: 3 } }]));
    expect(near.b.x).toBeCloseTo(far.b.x, 9);
    expect(near.b.y).toBeCloseTo(far.b.y, 9);
  });
});

describe("rotate — Randfälle", () => {
  it("ohne Auswahl passiert nichts (No-op, Befehl beendet)", () => {
    const before = projectWithLine();
    const after = run([{ pt: { x: 0, y: 0 } }, { num: 90 }], EMPTY_SEL);
    expect(after.drawings2d).toEqual(before.drawings2d);
  });

  it("ein Referenzpunkt AUF dem Drehpunkt wird ignoriert (keine Richtung)", () => {
    // Zweiter Klick = Drehpunkt selbst → bleibt im Winkel-Schritt, nichts committet.
    const g = line(run([{ pt: { x: 1, y: 1 } }, { pt: { x: 1, y: 1 } }]));
    expect(g.b.x).toBeCloseTo(2, 9);
    expect(g.b.y).toBeCloseTo(0, 9);
  });
});
