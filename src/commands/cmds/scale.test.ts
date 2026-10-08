/**
 * Scale-Befehl. Schwerpunkt ist die Stelle, an der eine naive Umsetzung falsch
 * wäre: `mvGeom` bildet nur PUNKTE ab — Radius, Schrifthöhe und der
 * Bemassungs-Abstand müssen beim Skalieren mitziehen, sonst bliebe ein Kreis
 * unter 2× gleich gross.
 */

import { describe, expect, it } from "vitest";
import { scaleCommand } from "./scale";
import { sampleProject } from "../../model/sampleProject";
import type { Drawing2DGeom } from "../../model/types";
import type { CommandContext, CommandSelection, CommandState, Project, Vec2 } from "../types";

function projectWith(geom: Drawing2DGeom): Project {
  return {
    ...sampleProject,
    drawings2d: [
      {
        id: "el",
        type: "drawing2d",
        levelId: sampleProject.drawingLevels[0].id,
        categoryCode: sampleProject.layers[0].code,
        geom,
      },
    ],
  };
}

const SEL: CommandSelection = { wallIds: [], drawingId: "el" };

function run(
  geom: Drawing2DGeom,
  inputs: ({ pt: Vec2 } | { num: number })[],
  selection: CommandSelection = SEL,
): Drawing2DGeom {
  let state: CommandState = scaleCommand.init();
  let project = projectWith(geom);
  for (const step of inputs) {
    const input =
      "pt" in step
        ? ({ kind: "point", point: step.pt } as const)
        : ({ kind: "number", value: step.num } as const);
    const ctx = {
      project,
      selection,
      level: project.drawingLevels[0],
      defaultCategoryCode: project.layers[0].code,
    } as CommandContext;
    const [next, res] = scaleCommand.onInput(state, input, ctx);
    state = next;
    if (res.commit) project = res.commit(project);
  }
  return project.drawings2d[0].geom;
}

describe("scale — getippter Faktor", () => {
  it("skaliert Punkte um den Basispunkt", () => {
    const g = run({ shape: "line", a: { x: 1, y: 0 }, b: { x: 3, y: 0 } }, [
      { pt: { x: 1, y: 0 } },
      { num: 2 },
    ]);
    if (g.shape !== "line") throw new Error();
    expect(g.a.x).toBeCloseTo(1, 9); // Basispunkt bleibt fix
    expect(g.b.x).toBeCloseTo(5, 9); // Abstand 2 → 4
  });

  it("KREIS: der Radius zieht mit (sonst bliebe er gleich gross)", () => {
    const g = run({ shape: "circle", center: { x: 2, y: 0 }, r: 1 }, [
      { pt: { x: 0, y: 0 } },
      { num: 3 },
    ]);
    if (g.shape !== "circle") throw new Error();
    expect(g.center.x).toBeCloseTo(6, 9);
    expect(g.r).toBeCloseTo(3, 9);
  });

  it("ELLIPSE: beide Halbachsen ziehen mit", () => {
    const g = run({ shape: "ellipse", center: { x: 0, y: 0 }, rx: 2, ry: 1, rotation: 0 }, [
      { pt: { x: 0, y: 0 } },
      { num: 0.5 },
    ]);
    if (g.shape !== "ellipse") throw new Error();
    expect(g.rx).toBeCloseTo(1, 9);
    expect(g.ry).toBeCloseTo(0.5, 9);
  });

  it("TEXT: die Schrifthöhe zieht mit", () => {
    const g = run({ shape: "text", at: { x: 0, y: 0 }, text: "A", height: 0.2, angle: 0 }, [
      { pt: { x: 0, y: 0 } },
      { num: 2 },
    ]);
    if (g.shape !== "text") throw new Error();
    expect(g.height).toBeCloseTo(0.4, 9);
  });

  it("BEMASSUNG: der Masslinien-Abstand zieht mit, die Punkte ebenfalls", () => {
    const g = run(
      { shape: "dimension", pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }], offset: 1 },
      [{ pt: { x: 0, y: 0 } }, { num: 2 }],
    );
    if (g.shape !== "dimension") throw new Error();
    expect(g.offset).toBeCloseTo(2, 9);
    expect(g.pts[1].x).toBeCloseTo(4, 9);
  });

  it("POLYLINIE mit Bogen: `bulge` bleibt unverändert (Formverhältnis, skaleninvariant)", () => {
    const g = run(
      { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }], closed: false, bulge: [0.5] },
      [{ pt: { x: 0, y: 0 } }, { num: 3 }],
    );
    if (g.shape !== "polyline") throw new Error();
    expect(g.bulge?.[0]).toBeCloseTo(0.5, 12);
    expect(g.pts[1].x).toBeCloseTo(6, 9);
  });

  it("Faktor 0 oder negativ wird ignoriert (keine sinnvolle Skalierung)", () => {
    const before: Drawing2DGeom = { shape: "circle", center: { x: 1, y: 0 }, r: 1 };
    expect(run(before, [{ pt: { x: 0, y: 0 } }, { num: 0 }])).toEqual(before);
    expect(run(before, [{ pt: { x: 0, y: 0 } }, { num: -2 }])).toEqual(before);
  });
});

describe("scale — Referenzlänge", () => {
  it("Faktor ergibt sich aus neue Länge ÷ Referenzlänge", () => {
    // Referenz 2 Einheiten, Ziel 6 ⇒ Faktor 3.
    const g = run({ shape: "circle", center: { x: 1, y: 0 }, r: 1 }, [
      { pt: { x: 0, y: 0 } },
      { pt: { x: 2, y: 0 } },
      { pt: { x: 6, y: 0 } },
    ]);
    if (g.shape !== "circle") throw new Error();
    expect(g.r).toBeCloseTo(3, 9);
    expect(g.center.x).toBeCloseTo(3, 9);
  });

  it("nur die LÄNGE zählt, nicht die Richtung der Referenz", () => {
    const a = run({ shape: "circle", center: { x: 0, y: 0 }, r: 1 }, [
      { pt: { x: 0, y: 0 } },
      { pt: { x: 2, y: 0 } },
      { pt: { x: 0, y: 4 } },
    ]);
    if (a.shape !== "circle") throw new Error();
    expect(a.r).toBeCloseTo(2, 9);
  });

  it("ohne Auswahl passiert nichts", () => {
    const before: Drawing2DGeom = { shape: "circle", center: { x: 1, y: 0 }, r: 1 };
    expect(run(before, [{ pt: { x: 0, y: 0 } }, { num: 5 }], { wallIds: [], drawingId: null })).toEqual(
      before,
    );
  });
});
