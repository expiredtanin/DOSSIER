// Dach im Vertikalschnitt: appendRoofSections schneidet die Schnittebene
// analytisch mit den Dachflächen (der Rust-Extraktor kennt nur Wände/Decken).
// Geprüft werden u-Intervalle, Oberkanten-Verlauf (linear je Fläche), die
// vertikale Dicke (lotrechte Dicke / cos(Neigung)) und die Schicht-Bänder.

import { describe, it, expect } from "vitest";
import { appendRoofSections } from "./toSection";
import type { SectionOutput, SectionPlaneSpec } from "./toSection";
import type { Project, Roof } from "../model/types";

const RECT: Roof["outline"] = [
  { x: -3, y: 0 },
  { x: 3, y: 0 },
  { x: 3, y: 4 },
  { x: -3, y: 4 },
];

function roof(over: Partial<Roof> = {}): Roof {
  return {
    id: "R1",
    type: "roof",
    floorId: "eg",
    categoryCode: "35",
    outline: RECT,
    shape: "sattel",
    pitchDeg: 30,
    overhang: 0,
    ridgeAxis: "x",
    baseElevation: 5, // explizit — kein Geschoss-Lookup nötig
    thickness: 0.3,
    ...over,
  };
}

function project(r: Roof, extra: Partial<Project> = {}): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [],
    layers: [],
    walls: [],
    doors: [],
    roofs: [r],
    ...extra,
  } as unknown as Project;
}

/** Schnittebene: Blick entlang +x (Osten), Spur x=0 — Betrachter-RECHTS =
 *  Süden, u fällt also mit Modell-y (entspiegelte u-Achse). */
const PLANE: SectionPlaneSpec = { point: [0, 0, 0], normal: [1, 0, 0] };

const emptyOutput = (): SectionOutput => ({ cutPolygons: [], visibleEdges: [], hiddenEdges: [] });

describe("appendRoofSections", () => {
  it("Flachdach: EIN Rechteck-Band, Oberkante = Traufhöhe, Höhe = Dicke", () => {
    const out = emptyOutput();
    appendRoofSections(out, project(roof({ shape: "flach", pitchDeg: 0 })), PLANE);
    expect(out.cutPolygons.length).toBe(1);
    const cp = out.cutPolygons[0];
    expect(cp.component).toEqual({ kind: "roof", index: 0 });
    // u-Intervall = Tiefe 0..4 → u −4..0 (u = −Modell-y); Oberkante 5,
    // Unterkante 5 − 0.3 (cosθ = 1).
    const us = cp.pts.map((p) => p[0]).sort((a, b) => a - b);
    expect(us[0]).toBeCloseTo(-4, 6);
    expect(us[3]).toBeCloseTo(0, 6);
    const vs = cp.pts.map((p) => p[1]).sort((a, b) => a - b);
    expect(vs[3]).toBeCloseTo(5, 6);
    expect(vs[0]).toBeCloseTo(5 - 0.3, 6);
  });

  it("Satteldach quer zum First: zwei Bänder (steigend/fallend) mit Neigungs-Dicke", () => {
    const out = emptyOutput();
    appendRoofSections(out, project(roof()), PLANE);
    expect(out.cutPolygons.length).toBe(2);
    const tan30 = Math.tan((30 * Math.PI) / 180);
    const cos30 = Math.cos((30 * Math.PI) / 180);
    const ridgeZ = 5 + 2 * tan30; // First bei halber Tiefe (y=2 → u=−2)
    // Alle Oberkanten-Werte je Band: an u=0/−4 Traufe (5), an u=−2 First.
    const topAt = (cp: (typeof out.cutPolygons)[number], u: number): number =>
      Math.max(...cp.pts.filter((p) => Math.abs(p[0] - u) < 1e-6).map((p) => p[1]));
    const bands = out.cutPolygons;
    const front = bands.find((b) => b.pts.some((p) => Math.abs(p[0]) < 1e-6));
    const back = bands.find((b) => b.pts.some((p) => Math.abs(p[0] + 4) < 1e-6));
    expect(front).toBeDefined();
    expect(back).toBeDefined();
    expect(topAt(front!, 0)).toBeCloseTo(5, 5);
    expect(topAt(front!, -2)).toBeCloseTo(ridgeZ, 5);
    expect(topAt(back!, -4)).toBeCloseTo(5, 5);
    expect(topAt(back!, -2)).toBeCloseTo(ridgeZ, 5);
    // Vertikale Banddicke = lotrechte Dicke / cos(Neigung).
    const vAt = (cp: (typeof out.cutPolygons)[number], u: number): number[] =>
      cp.pts.filter((p) => Math.abs(p[0] - u) < 1e-6).map((p) => p[1]);
    const [hi, lo] = vAt(front!, 0).sort((a, b) => b - a);
    expect(hi - lo).toBeCloseTo(0.3 / cos30, 5);
  });

  it("Schnittspur ausserhalb des Dachs: keine Bänder", () => {
    const out = emptyOutput();
    // Spur x=0 — Dach komplett rechts davon (x 10..16).
    const far = roof({
      outline: [
        { x: 10, y: 0 },
        { x: 16, y: 0 },
        { x: 16, y: 4 },
        { x: 10, y: 4 },
      ],
    });
    appendRoofSections(out, project(far), PLANE);
    expect(out.cutPolygons.length).toBe(0);
  });

  it("mehrschichtiges Dach (roofTypeId): je Schicht ein Band pro Fläche, aussen oben", () => {
    const p = project(roof({ shape: "flach", pitchDeg: 0, roofTypeId: "rt1" }), {
      hatches: [
        { id: "h1", name: "H", pattern: "diagonal", scale: 1, angle: 45, color: "#111111" },
      ],
      components: [
        { id: "tile", name: "Ziegel", color: "#a03a2a", hatchId: "h1", joinPriority: 1 },
        { id: "ins", name: "Dämmung", color: "#ffffff", hatchId: "h1", joinPriority: 2 },
      ],
      roofTypes: [
        {
          id: "rt1",
          name: "Aufbau",
          layers: [
            { componentId: "tile", thickness: 0.05 },
            { componentId: "ins", thickness: 0.25 },
          ],
        },
      ],
    });
    const out = emptyOutput();
    appendRoofSections(out, p, PLANE);
    expect(out.cutPolygons.length).toBe(2); // 1 Fläche × 2 Schichten
    const tops = out.cutPolygons.map((cp) => Math.max(...cp.pts.map((q) => q[1])));
    // Eindeckung oben (OK 5), Dämmung darunter (OK 5 − 0.05).
    expect(Math.max(...tops)).toBeCloseTo(5, 6);
    expect(Math.min(...tops)).toBeCloseTo(4.95, 6);
    // Schicht-Stile sind aufgelöst (Schraffur des Bauteils).
    expect(out.cutPolygons.every((cp) => cp.hatch?.pattern === "diagonal")).toBe(true);
  });
});

describe("appendRoofSections — Nähte deckungsgleicher Teilflächen", () => {
  it("L-Walmdach, Schnitt längs durch die Süd-Schräge: deckungsgleiche Teilflächen werden ein Band", () => {
    const L: Roof["outline"] = [
      { x: 0, y: 0 }, { x: 11, y: 0 }, { x: 11, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 6 }, { x: 0, y: 6 },
    ];
    // Schnitt entlang x bei y=1: Blick +y (Norden), u = x. Süd-Schräge besteht aus zwei Teilflächen EINER Ebene.
    const plane: SectionPlaneSpec = { point: [0, 0, 1], normal: [0, 0, 1] };
    const out = emptyOutput();
    appendRoofSections(out, project(roof({ outline: L, shape: "walm" })), plane);
    // Walm-Ost, Süd-Schräge (zwei Teilflächen einer Ebene → EIN Band), Walm-West = 3 Bänder.
    const roofPolys = out.cutPolygons.filter((c) => c.component.kind === "roof");
    expect(roofPolys.length).toBe(3);
  });
});
