/**
 * Unit-Tests für die Dach-Darstellung im Grundriss (generatePlan → addRoof):
 * `project.roofs` wird nach Geschoss + sichtbarer Kategorie gefiltert (analog
 * Decken) und pro Dach in Grundriss-Linien übersetzt (Traufe/First/Grat/Knick,
 * aus `roofGeometry`). Reine Linien-Darstellung ohne Poché — die Form (flach/
 * sattel/walm/mansarde) entscheidet, welche der vier Linienarten auftauchen.
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Project, Roof } from "../model/types";

/** Minimalprojekt ohne Wände: nur das Geschoss + die Dach-Kategorie „35". */
function baseProject(roofs?: Roof[]): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [
      {
        id: "eg",
        name: "EG",
        kind: "floor",
        visible: true,
        locked: false,
        floorHeight: 2.6,
        cutHeight: 1.0,
        baseElevation: 0,
      },
    ],
    layers: [{ code: "35", name: "Dächer", color: "#8a4b32", lw: 0.25, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
    ...(roofs !== undefined ? { roofs } : {}),
  };
}

const rectOutline: Roof["outline"] = [
  { x: 0, y: 0 },
  { x: 6, y: 0 },
  { x: 6, y: 4 },
  { x: 0, y: 4 },
];

const roof = (id: string, shape: Roof["shape"], extra: Partial<Roof> = {}): Roof => ({
  id,
  type: "roof",
  floorId: "eg",
  categoryCode: "35",
  outline: rectOutline,
  shape,
  pitchDeg: 30,
  overhang: 0.5,
  ridgeAxis: "x",
  thickness: 0.3,
  ...extra,
});

const visible = new Set(["35"]);

/** Filtert die Grundriss-Primitive nach `kind:"line"` + gegebener Klasse. */
function linesOf(primitives: ReturnType<typeof generatePlan>["primitives"], cls: string) {
  return primitives.filter(
    (p): p is Extract<typeof p, { kind: "line" }> => p.kind === "line" && p.cls === cls,
  );
}

describe("generatePlan — Dächer (Dachaufsicht)", () => {
  it("Satteldach: Traufe + First, aber kein Grat/Knick", () => {
    const plan = generatePlan(baseProject([roof("R1", "sattel")]), "eg", visible);
    expect(linesOf(plan.primitives, "roof-eaves").length).toBeGreaterThan(0);
    expect(linesOf(plan.primitives, "roof-ridge").length).toBeGreaterThan(0);
    expect(linesOf(plan.primitives, "roof-hip").length).toBe(0);
    expect(linesOf(plan.primitives, "roof-break").length).toBe(0);
  });

  it("Walmdach: Traufe + First + Grat", () => {
    const plan = generatePlan(baseProject([roof("R2", "walm")]), "eg", visible);
    expect(linesOf(plan.primitives, "roof-eaves").length).toBeGreaterThan(0);
    expect(linesOf(plan.primitives, "roof-ridge").length).toBeGreaterThan(0);
    expect(linesOf(plan.primitives, "roof-hip").length).toBeGreaterThan(0);
  });

  it("Mansarddach: Knicklinien gestrichelt", () => {
    const plan = generatePlan(baseProject([roof("R3", "mansarde")]), "eg", visible);
    const breaks = linesOf(plan.primitives, "roof-break");
    expect(breaks.length).toBeGreaterThan(0);
    for (const b of breaks) {
      expect(b.dash).toBeTruthy();
      expect(b.dash?.length).toBeGreaterThan(0);
    }
  });

  it("Flachdach: nur Traufe, weder First noch Grat noch Knick", () => {
    const plan = generatePlan(baseProject([roof("R4", "flach")]), "eg", visible);
    expect(linesOf(plan.primitives, "roof-eaves").length).toBeGreaterThan(0);
    expect(linesOf(plan.primitives, "roof-ridge").length).toBe(0);
    expect(linesOf(plan.primitives, "roof-hip").length).toBe(0);
    expect(linesOf(plan.primitives, "roof-break").length).toBe(0);
  });

  it("First-Linie ist kräftiger als die Traufe (First > Traufe > Knick)", () => {
    const plan = generatePlan(baseProject([roof("R5", "mansarde")]), "eg", visible);
    const eaves = linesOf(plan.primitives, "roof-eaves")[0];
    const ridge = linesOf(plan.primitives, "roof-ridge")[0];
    const brk = linesOf(plan.primitives, "roof-break")[0];
    expect(ridge.weightMm).toBeGreaterThan(eaves.weightMm);
    expect(eaves.weightMm).toBeGreaterThan(brk.weightMm);
  });

  it("löst die Strichfarbe über roof.color, sonst die Kategorie-Farbe auf", () => {
    const withColor = generatePlan(
      baseProject([roof("R6", "sattel", { color: "#ff0000" })]),
      "eg",
      visible,
    );
    expect(linesOf(withColor.primitives, "roof-eaves")[0].color).toBe("#ff0000");

    const withoutColor = generatePlan(baseProject([roof("R7", "sattel")]), "eg", visible);
    expect(linesOf(withoutColor.primitives, "roof-eaves")[0].color).toBe("#8a4b32");
  });

  it("Dachaufsicht-Poché: viewHatchId der äussersten Dachtyp-Schicht schraffiert das Pick-Polygon", () => {
    const p: Project = {
      ...baseProject([roof("R9", "sattel", { roofTypeId: "rt1" })]),
      hatches: [
        { id: "diag", name: "Diagonal", pattern: "diagonal", scale: 1, angle: 45, color: "#1a1a1a" },
      ],
      components: [
        { id: "tile", name: "Ziegel", color: "#a03a2a", hatchId: "", viewHatchId: "diag", joinPriority: 1 },
      ],
      roofTypes: [{ id: "rt1", name: "Dach", layers: [{ componentId: "tile", thickness: 0.05 }] }],
    };
    const roofPolys = (proj: Project) =>
      generatePlan(proj, "eg", visible).primitives.filter(
        (pr): pr is Extract<typeof pr, { kind: "polygon" }> =>
          pr.kind === "polygon" && (pr as { roofId?: string }).roofId === "R9",
      );
    // Dach über der Schnittebene (Schnitt 1 m, Traufe 2.6 m): nicht von oben gesehen → ohne Schraffur.
    const over = roofPolys(p);
    expect(over.length).toBe(1);
    expect(over[0].hatch.pattern).toBe("none");
    // Schnitt über dem First: Dachaufsicht mit Ansichtsschraffur.
    const seen = { ...p, drawingLevels: p.drawingLevels.map((l) => (l.id === "eg" ? { ...l, cutHeight: 20 } : l)) };
    const polys = roofPolys(seen);
    expect(polys.length).toBe(1);
    expect(polys[0].hatch.pattern).toBe("diagonal");

    // Ohne Dachtyp: keine Schraffur (Pattern "none"), Pick-Polygon bleibt.
    const plain = generatePlan(baseProject([roof("R10", "sattel")]), "eg", visible).primitives.filter(
      (pr): pr is Extract<typeof pr, { kind: "polygon" }> =>
        pr.kind === "polygon" && (pr as { roofId?: string }).roofId === "R10",
    );
    expect(plain.length).toBe(1);
    expect(plain[0].hatch.pattern).toBe("none");
  });

  it("Rückwärtskompatibilität: ohne Dächer (bzw. Dach auf anderem Geschoss) bleiben die Primitive unverändert", () => {
    const planNoField = generatePlan(baseProject(undefined), "eg", visible);
    const planEmpty = generatePlan(baseProject([]), "eg", visible);
    const planOtherFloor = generatePlan(
      baseProject([roof("R8", "sattel", { floorId: "og" })]),
      "eg",
      visible,
    );

    expect(planEmpty.primitives).toEqual(planNoField.primitives);
    expect(planOtherFloor.primitives).toEqual(planNoField.primitives);
    expect(planNoField.primitives.some((p) => p.kind === "line" && p.cls.startsWith("roof-"))).toBe(
      false,
    );
  });

  it("Innenhof ([26]): Traufring des Hofs, Dachfläche mit Loch (Brückenkanten), Firstlinien des Hofs", () => {
    const court = [
      { x: 1.5, y: 1 },
      { x: 1.5, y: 3 },
      { x: 3, y: 3 },
      { x: 3, y: 1 },
    ];
    const plain = generatePlan(baseProject([roof("R9", "walm", { overhang: 0 })]), "eg", visible);
    const withCourt = generatePlan(baseProject([roof("R9", "walm", { overhang: 0, holes: [court] })]), "eg", visible);
    // Umriss 4 Kanten + Hof 4 Kanten.
    expect(linesOf(plain.primitives, "roof-eaves").length).toBe(4);
    expect(linesOf(withCourt.primitives, "roof-eaves").length).toBe(8);
    const poly = withCourt.primitives.find((p) => p.kind === "polygon" && p.roofId === "R9");
    expect(poly && poly.kind === "polygon" && poly.pts.length).toBeGreaterThan(4);
    expect(poly && poly.kind === "polygon" && (poly.noStrokeEdges ?? []).length).toBeGreaterThan(0);
  });
});
