/**
 * `addColumnPoche` — By-Layer/By-Object-Override für Stützen (Nutzer-Wunsch:
 * "generell sollten alle BIM Teile ... die weiteren Attribute haben" — Stütze
 * hat bereits eine Poché UND nutzt dieselben Resolver wie Wand/Decke, daher
 * hier zuerst fertig verdrahtet). Regressionsschutz: die neuen
 * foreground/background/hatchId/strokeWeight(+Source)-Felder auf `Column`
 * müssen tatsächlich bis in die gerenderte Poché durchschlagen.
 */

import { describe, it, expect } from "vitest";
import { addColumnPoche } from "./structures";
import type { Column, Component, LayerCategory, Project } from "../../model/types";
import type { Primitive } from "./shared";

const comp: Component = {
  id: "beton",
  name: "Beton",
  color: "#888888",
  hatchId: "sia-concrete",
  joinPriority: 10,
};

const category: LayerCategory = {
  code: "50",
  name: "Tragwerk",
  color: "#333333",
  lw: 0.35,
  visible: true,
  locked: false,
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [
      { id: "sia-concrete", name: "Beton", pattern: "solid" },
      { id: "sia-other", name: "Sonstiges", pattern: "none" },
    ] as unknown as Project["hatches"],
    components: [comp],
    wallTypes: [],
    drawingLevels: [],
    layers: [category],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
    columns: [],
    ...overrides,
  };
}

function column(overrides: Partial<Column> = {}): Column {
  return {
    id: "col1",
    type: "column",
    floorId: "eg",
    categoryCode: "50",
    position: { x: 0, y: 0 },
    profile: { kind: "rect", width: 0.3, depth: 0.3 },
    rotation: 0,
    height: 2.6,
    componentId: "beton",
    ...overrides,
  };
}

function polygonOf(out: Primitive[]): Extract<Primitive, { kind: "polygon" }> {
  const p = out.find((x) => x.kind === "polygon");
  if (!p || p.kind !== "polygon") throw new Error("kein Poché-Polygon gefunden");
  return p;
}

describe("addColumnPoche — Attribut-Override greift", () => {
  it("ohne Override: Bauteil-Schraffur/-Farbe bestimmen die Poché (Default 'Nach Bauteil')", () => {
    const out: Primitive[] = [];
    addColumnPoche(out, project(), column(), false, 0.35, category);
    const poly = polygonOf(out);
    expect(poly.hatch.pattern).toBe("solid");
  });

  it("mit explizitem background-Override: die Poché-Füllung wird die Override-Farbe", () => {
    const out: Primitive[] = [];
    addColumnPoche(out, project(), column({ background: "#ff00ff" }), false, 0.35, category);
    expect(polygonOf(out).fill).toBe("#ff00ff");
  });

  it("mit hatchSource:'layer': die Kategorie-Schraffur wird verwendet, nicht die Bauteil-Schraffur", () => {
    const out: Primitive[] = [];
    const catWithHatch: LayerCategory = { ...category, hatch: "sia-other" };
    addColumnPoche(
      out,
      project({ layers: [catWithHatch] }),
      column({ hatchSource: "layer" }),
      false,
      0.35,
      catWithHatch,
    );
    expect(polygonOf(out).hatch.pattern).toBe("none");
  });

  it("mit explizitem hatchId-Override: gewinnt gegenüber Bauteil UND Kategorie", () => {
    const out: Primitive[] = [];
    addColumnPoche(
      out,
      project(),
      column({ hatchId: "sia-other" }),
      false,
      0.35,
      category,
    );
    expect(polygonOf(out).hatch.pattern).toBe("none");
  });

  it("ohne gesetzten Vordergrund: Schraffurfarbe bleibt die neutrale Tinte (Default unverändert)", () => {
    const out: Primitive[] = [];
    addColumnPoche(out, project(), column(), false, 0.35, category);
    expect(polygonOf(out).hatch.color).toBe("#0f0f0f");
  });

  it("mit explizitem foreground-Override: die Schraffurfarbe wird die Override-Farbe (vorher wirkungslos)", () => {
    const out: Primitive[] = [];
    addColumnPoche(out, project(), column({ foreground: "#00ff88" }), false, 0.35, category);
    expect(polygonOf(out).hatch.color).toBe("#00ff88");
  });
});
