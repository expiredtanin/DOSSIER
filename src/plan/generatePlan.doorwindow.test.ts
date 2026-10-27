/**
 * Unit-Tests für die Tür-/Fenstertyp-Rahmenparameter im Grundriss
 * (generatePlan): Rahmenband (Zarge/Blockrahmen), Schichteinzug (insetFromFace/
 * insetFace), Oberlicht (transomHeight). `mullionRows` bleibt bewusst ungetestet
 * — Kämpfer-Zeilen sind im Grundriss-Schnitt unsichtbar (3D-Sache).
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { DoorType, Opening, Project, Wall, WindowType } from "../model/types";

/** Minimalprojekt: eine Wand (Dicke 0.3 m, Achse mittig) + Öffnungen und
 *  optionale Tür-/Fenstertyp-Bibliotheken, konfigurierbar je Test. */
function project(
  openings: Opening[],
  opts: { doorTypes?: DoorType[]; windowTypes?: WindowType[] } = {},
): Project {
  const wall: Wall = {
    id: "W1",
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start: { x: 0, y: 0 },
    end: { x: 4, y: 0 },
    wallTypeId: "aw",
    height: 2.6,
  };
  return {
    id: "t",
    name: "T",
    lineStyles: [{ id: "thin", name: "d", weight: 0.13, color: "#111", dash: null }],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [{ id: "a", name: "A", color: "#d8d2c7", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "a", thickness: 0.3 }] }],
    doorTypes: opts.doorTypes,
    windowTypes: opts.windowTypes,
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
    layers: [
      { code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false },
      { code: "21", name: "Öffnungen", color: "#0a0a0a", lw: 0.3, visible: true, locked: false },
    ],
    walls: [wall],
    openings,
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

const visible = new Set(["20", "21"]);

/** Basis-Fenster, jenseits der Tür auf derselben Wandachse. */
const baseWindow: Opening = {
  id: "F1",
  type: "opening",
  hostWallId: "W1",
  categoryCode: "21",
  kind: "window",
  position: 2.0,
  width: 1.2,
  height: 1.2,
  sillHeight: 0,
};

/** Basis-Tür. */
const baseDoor: Opening = {
  id: "T1",
  type: "opening",
  hostWallId: "W1",
  categoryCode: "21",
  kind: "door",
  position: 0.2,
  width: 0.9,
  height: 2.0,
  sillHeight: 0,
  swing: "left",
  hinge: "start",
};

/** Fenstertyp mit Rahmen, Schichteinzug (aussen) und Oberlicht. */
const windowType: WindowType = {
  id: "wt1",
  name: "Fenstertyp Test",
  kind: "dreh",
  wingCount: 1,
  glazing: "zweifach",
  frameThickness: 0.06,
  frameWidth: 0.05,
  insetFromFace: 0.05,
  insetFace: "aussen",
  transomHeight: 0.3,
  defaultSillHeight: 0.8,
  defaultWidth: 1.2,
  defaultHeight: 1.2,
};

/** Türtyp mit Blockrahmen, Schichteinzug (innen) und Oberlicht. */
const doorType: DoorType = {
  id: "dt1",
  name: "Türtyp Test",
  kind: "dreh",
  leafCount: 1,
  leafStyle: "glatt",
  frameThickness: 0.06,
  frameKind: "blockrahmen",
  frameWidth: 0.06,
  insetFromFace: 0.04,
  insetFace: "innen",
  transomHeight: 0.4,
  defaultWidth: 0.9,
  defaultHeight: 2.0,
};

type LinePrim = Extract<ReturnType<typeof generatePlan>["primitives"][number], { kind: "line" }>;

function linesOfClass(p: Project, cls: string, openingId?: string): LinePrim[] {
  return generatePlan(p, "eg", visible, undefined, "mittel").primitives.filter(
    (pr): pr is LinePrim =>
      pr.kind === "line" && pr.cls === cls && (!openingId || pr.openingId === openingId),
  );
}

describe("generatePlan — Tür-/Fenstertyp-Rahmenband (opening-frame)", () => {
  it("erzeugt das Rahmenband NUR für die Tür (Fenster: windowSymbol zeichnet den Rahmen)", () => {
    const p = project(
      [
        { ...baseWindow, typeId: "wt1" },
        { ...baseDoor, typeId: "dt1" },
      ],
      { doorTypes: [doorType], windowTypes: [windowType] },
    );
    // Tür: ein geschlossenes Rechteck aus 4 Kanten. Fenster: KEIN Band (sonst
    // doppeltes, verschachteltes Rechteck über dem windowSymbol-Rahmen).
    expect(linesOfClass(p, "opening-frame", "T1").length).toBe(4);
    expect(linesOfClass(p, "opening-frame", "F1").length).toBe(0);
  });

  it("Blockrahmen-Tür zeichnet eine kräftigere Linie als eine Zargen-Tür", () => {
    const zargeDoor: DoorType = { ...doorType, id: "dt-zarge", frameKind: "zarge" };
    const p = project(
      [
        { ...baseDoor, id: "T1", typeId: "dt1" },
        { ...baseDoor, id: "T2", position: 3.0, typeId: "dt-zarge" },
      ],
      { doorTypes: [doorType, zargeDoor] },
    );
    const blockWeight = linesOfClass(p, "opening-frame", "T1")[0].weightMm;
    const zargeWeight = linesOfClass(p, "opening-frame", "T2")[0].weightMm;
    expect(blockWeight).toBeGreaterThan(zargeWeight);
  });
});

describe("generatePlan — zweiflügelige Tür (leafCount)", () => {
  it("leafCount 2 -> zwei Türblätter + zwei Schwenkbögen; leafCount 1 -> je eines", () => {
    const oneLeaf = project([{ ...baseDoor, typeId: "dt1" }], { doorTypes: [doorType] });
    expect(linesOfClass(oneLeaf, "door-leaf", "T1").length).toBe(1);

    const twoLeafType: DoorType = { ...doorType, id: "dt2", leafCount: 2 };
    const twoLeaf = project([{ ...baseDoor, typeId: "dt2" }], { doorTypes: [twoLeafType] });
    expect(linesOfClass(twoLeaf, "door-leaf", "T1").length).toBe(2);
    // Zwei Schwenkbögen (arc-Primitive) bei mittel/fein.
    const arcs = generatePlan(twoLeaf, "eg", visible, undefined, "mittel").primitives.filter(
      (pr) => pr.kind === "arc" && (pr as { cls?: string }).cls === "door-swing",
    );
    expect(arcs.length).toBe(2);
    // Die beiden Blätter sind je halb so breit (Radius) wie das einflügelige.
    const oneRadius = (
      generatePlan(oneLeaf, "eg", visible, undefined, "mittel").primitives.find(
        (pr) => pr.kind === "arc" && (pr as { cls?: string }).cls === "door-swing",
      ) as { r: number }
    ).r;
    const twoRadius = (arcs[0] as { r: number }).r;
    expect(twoRadius).toBeCloseTo(oneRadius / 2, 6);
  });
});

describe("generatePlan — Oberlicht (opening-transom, entfernt)", () => {
  it("erscheint NICHT mehr im Grundriss, unabhängig von transomHeight (Nutzer-Report: falsch auf Wandachse, Kämpfer ist ein Höhen- kein Grundriss-Merkmal)", () => {
    const withTransom = project([{ ...baseWindow, typeId: "wt1" }], { windowTypes: [windowType] });
    expect(linesOfClass(withTransom, "opening-transom", "F1").length).toBe(0);

    const noTransomType: WindowType = { ...windowType, id: "wt2", transomHeight: 0 };
    const withoutTransom = project([{ ...baseWindow, typeId: "wt2" }], { windowTypes: [noTransomType] });
    expect(linesOfClass(withoutTransom, "opening-transom", "F1").length).toBe(0);
  });
});

describe("generatePlan — Schichteinzug (insetFromFace/insetFace)", () => {
  it("verschiebt die Rahmen-Nahfläche um den Einzugsbetrag, die Gegenfläche bleibt unverändert", () => {
    // Am Tür-Zargenband geprüft (das Fenster nutzt jetzt windowSymbol statt Band).
    const insetDoor: DoorType = {
      ...doorType,
      id: "dt-inset",
      frameKind: "zarge",
      insetFromFace: 0.05,
      insetFace: "aussen",
    };
    const flushDoor: DoorType = { ...insetDoor, id: "dt-flush", insetFromFace: 0 };
    const inset = project([{ ...baseDoor, typeId: "dt-inset" }], { doorTypes: [insetDoor] });
    const flush = project([{ ...baseDoor, typeId: "dt-flush" }], { doorTypes: [flushDoor] });

    // Die Wandachse ist horizontal (u=(1,0)) ⇒ Wandnormale n=(0,1); die
    // y-Koordinate der Rahmenband-Punkte entspricht direkt dem Offset quer zur
    // Wand. Die "aussen"-Fläche liegt bei −n (erste Wandtyp-Schicht, s.
    // addWallPoche/addOpeningFrameBand) — ihr Rahmenrand muss um genau
    // `insetFromFace` (0.05 m) nach innen (RICHTUNG WANDMITTE, also grösseres/
    // weniger negatives y) rücken; die gegenüberliegende ("innen"-)Fläche bleibt
    // unverändert.
    const insetYs = linesOfClass(inset, "opening-frame", "T1").flatMap((l) => [l.a.y, l.b.y]);
    const flushYs = linesOfClass(flush, "opening-frame", "T1").flatMap((l) => [l.a.y, l.b.y]);

    expect(Math.min(...insetYs) - Math.min(...flushYs)).toBeCloseTo(0.05, 9);
    expect(Math.max(...insetYs)).toBeCloseTo(Math.max(...flushYs), 9);
  });
});

describe("generatePlan — Rückwärtskompatibilität (Öffnung ohne typeId)", () => {
  it("liefert exakt dieselben Primitive, ob Typ-Bibliotheken im Projekt existieren oder nicht", () => {
    const withResources = project([{ ...baseWindow }, { ...baseDoor }], {
      doorTypes: [doorType],
      windowTypes: [windowType],
    });
    const withoutResources = project([{ ...baseWindow }, { ...baseDoor }]);

    const a = generatePlan(withResources, "eg", visible, undefined, "mittel").primitives;
    const b = generatePlan(withoutResources, "eg", visible, undefined, "mittel").primitives;
    expect(a).toEqual(b);
    expect(a.some((pr) => pr.kind === "line" && pr.cls === "opening-frame")).toBe(false);
    expect(a.some((pr) => pr.kind === "line" && pr.cls === "opening-transom")).toBe(false);
  });
});
