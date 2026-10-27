/**
 * `commitTransform`/`transformPreview` mit MEHREREN gewählten 2D-Elementen
 * (`TransformSelection.drawingIds`) — Nutzer-Report: "wenn ich zwei Linien
 * anwähle, dass ich dann m usw nicht verwenden kann". Vorher trug
 * `TransformSelection` nur ein einzelnes `drawingId`, das bei einer
 * Mehrfachauswahl (2+ Elemente) `null` war → Bewegen/Kopieren/Spiegeln/
 * Drehen/Feld griffen gar nicht.
 */

import { describe, it, expect } from "vitest";
import { commitTransform, rotateGizmoShapes } from "./transform";
import type { TransformSelection } from "./transform";
import type { Ceiling, Drawing2D, ExtrudedSolid, Project, Roof, Room, Stair } from "../model/types";

function project(drawings: Drawing2D[]): Project {
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
    drawings2d: drawings,
  };
}

function line(id: string, x: number): Drawing2D {
  return {
    id,
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: { shape: "line", a: { x, y: 0 }, b: { x: x + 1, y: 0 } },
  };
}

describe("commitTransform — mirror kehrt das Bulge-Vorzeichen einer Polylinie um", () => {
  it("Spiegelung an der X-Achse negiert bulge (sonst wandert der Bogen auf die falsche Seite)", () => {
    const poly: Drawing2D = {
      id: "d-poly",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "polyline",
        pts: [{ x: 0, y: 2 }, { x: 4, y: 2 }],
        closed: false,
        bulge: [0.6],
      },
    };
    const p = project([poly]);
    const sel: TransformSelection = { wallIds: [], drawingId: "d-poly", drawingIds: ["d-poly"] };
    // Spiegelachse = X-Achse (y=0).
    const next = commitTransform(p, sel, "mirror", [{ x: 0, y: 0 }, { x: 1, y: 0 }], "move", 1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("polyline");
    if (g.shape === "polyline") {
      expect(g.pts).toEqual([{ x: 0, y: -2 }, { x: 4, y: -2 }]);
      expect(g.bulge?.[0]).toBeCloseTo(-0.6, 6);
    }
  });

  it("reine Verschiebung (move) lässt bulge unverändert (keine Orientierungsumkehr)", () => {
    const poly: Drawing2D = {
      id: "d-poly",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }], closed: false, bulge: [0.6] },
    };
    const p = project([poly]);
    const sel: TransformSelection = { wallIds: [], drawingId: "d-poly", drawingIds: ["d-poly"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 2, y: 3 }], "move", 1);
    const g = next.drawings2d[0].geom;
    if (g.shape === "polyline") expect(g.bulge?.[0]).toBeCloseTo(0.6, 6);
  });
});

describe("commitTransform — Mehrfachauswahl (drawingIds)", () => {
  it("move: verschiebt ALLE gewählten 2D-Elemente, nicht nur eines", () => {
    const p = project([line("d1", 0), line("d2", 5), line("d3", 10)]);
    const sel: TransformSelection = { wallIds: [], drawingId: null, drawingIds: ["d1", "d2"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 2, y: 3 }], "move", 1);
    const d1 = next.drawings2d.find((d) => d.id === "d1")!.geom;
    const d2 = next.drawings2d.find((d) => d.id === "d2")!.geom;
    const d3 = next.drawings2d.find((d) => d.id === "d3")!.geom;
    if (d1.shape === "line") expect(d1.a).toEqual({ x: 2, y: 3 });
    if (d2.shape === "line") expect(d2.a).toEqual({ x: 7, y: 3 }); // 5+2
    if (d3.shape === "line") expect(d3.a).toEqual({ x: 10, y: 0 }); // nicht gewählt, unverändert
  });

  it("copy: dupliziert ALLE gewählten 2D-Elemente (Original bleibt)", () => {
    const p = project([line("d1", 0), line("d2", 5)]);
    const sel: TransformSelection = { wallIds: [], drawingId: null, drawingIds: ["d1", "d2"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 1, y: 0 }], "copy", 1);
    expect(next.drawings2d.length).toBe(4); // 2 Original + 2 Kopien
  });

  it("array: dupliziert ALLE gewählten 2D-Elemente N-mal", () => {
    const p = project([line("d1", 0), line("d2", 5)]);
    const sel: TransformSelection = { wallIds: [], drawingId: null, drawingIds: ["d1", "d2"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 1, y: 0 }], "array", 3);
    expect(next.drawings2d.length).toBe(8); // 2 Original + 2×3 Kopien
  });

  it("weiterhin abwärtskompatibel: einzelnes `drawingId` (ohne drawingIds) funktioniert unverändert", () => {
    const p = project([line("d1", 0)]);
    const sel: TransformSelection = { wallIds: [], drawingId: "d1" };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 3, y: 0 }], "move", 1);
    const d1 = next.drawings2d[0].geom;
    if (d1.shape === "line") expect(d1.a).toEqual({ x: 3, y: 0 });
  });

  it("drawingId + drawingIds zusammen werden dedupliziert (kein Doppel-Verschieben)", () => {
    const p = project([line("d1", 0), line("d2", 5)]);
    const sel: TransformSelection = { wallIds: [], drawingId: "d1", drawingIds: ["d1", "d2"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 1, y: 0 }], "copy", 1);
    expect(next.drawings2d.length).toBe(4); // je EINE Kopie pro Element, nicht zwei für d1
  });
});

// ── BIM-Elemente (Decke/Dach/Treppe/Raum) ───────────────────────────────────
// Vorher liefen move/rotate/scale/mirror/array NUR auf Wand/2D/ExtrudedSolid/
// Stütze (`gatherItems`); Decke/Dach/Treppe/Raum hingen an eigenen, isolierten
// Grip-Bewegungen. Deckt die Erweiterung von `gatherItems`/`commitTransform`.

function ceiling(id: string, outline: { x: number; y: number }[]): Ceiling {
  return { id, type: "ceiling", floorId: "eg", categoryCode: "30", outline, wallTypeId: "wt1" };
}

function room(id: string, boundary: { x: number; y: number }[]): Room {
  return {
    id,
    type: "room",
    floorId: "eg",
    categoryCode: "45",
    siaCategory: "HNF",
    name: "R",
    boundary,
    color: "#ffffff",
  };
}

function roof(id: string, outline: { x: number; y: number }[]): Roof {
  return {
    id,
    type: "roof",
    floorId: "eg",
    categoryCode: "35",
    outline,
    shape: "flach",
    pitchDeg: 0,
    overhang: 0.5,
    ridgeAxis: "x",
    thickness: 0.3,
  };
}

function straightStair(id: string): Stair {
  return {
    id,
    type: "stair",
    floorId: "eg",
    categoryCode: "40",
    shape: "straight",
    start: { x: 0, y: 0 },
    dir: { x: 1, y: 0 },
    runLength: 3,
    width: 1.2,
    stepCount: 18,
  };
}

function bimProject(overrides: Partial<Project>): Project {
  return { ...project([]), ...overrides };
}

describe("commitTransform — Decke/Raum (reine Punkt-Geometrie)", () => {
  it("move verschiebt den Deckenumriss", () => {
    const p = bimProject({ ceilings: [ceiling("c1", [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }])] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, ceilingIds: ["c1"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 5, y: 1 }], "move", 1);
    expect(next.ceilings![0].outline[0]).toEqual({ x: 5, y: 1 });
  });

  it("rotate um 90° dreht Deckenumriss UND Aussparungen", () => {
    const p = bimProject({
      ceilings: [
        {
          ...ceiling("c1", [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 1 }]),
          openings: [[{ x: 1, y: 0 }]],
        },
      ],
    });
    const sel: TransformSelection = { wallIds: [], drawingId: null, ceilingIds: ["c1"] };
    // Drehpunkt Ursprung, 0°→90°.
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
    const next = commitTransform(p, sel, "rotate", pts, "move", 1);
    const c = next.ceilings![0];
    expect(c.outline[0].x).toBeCloseTo(0, 6);
    expect(c.outline[0].y).toBeCloseTo(1, 6);
    expect(c.openings![0][0].x).toBeCloseTo(0, 6);
    expect(c.openings![0][0].y).toBeCloseTo(1, 6);
  });

  it("Raum: move nimmt den Stempel-Anker mit", () => {
    const r = { ...room("r1", [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }]), stampAnchor: { x: 1.5, y: 1.5 } };
    const p = bimProject({ rooms: [r] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, roomIds: ["r1"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 2, y: 0 }], "move", 1);
    expect(next.rooms![0].stampAnchor).toEqual({ x: 3.5, y: 1.5 });
  });

  it("copy dupliziert mit neuer ID, Original bleibt", () => {
    const p = bimProject({ ceilings: [ceiling("c1", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, ceilingIds: ["c1"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 1, y: 0 }], "copy", 1);
    expect(next.ceilings!.length).toBe(2);
    expect(next.ceilings![1].id).not.toBe("c1");
    expect(next.ceilings![0].outline[0]).toEqual({ x: 0, y: 0 }); // Original unverändert
  });
});

describe("commitTransform — Dach: Rotate/Mirror ausgenommen (Achsen-Invariante)", () => {
  it("move verschiebt den Dachumriss", () => {
    const p = bimProject({ roofs: [roof("rf1", [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }])] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, roofIds: ["rf1"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 1, y: 1 }], "move", 1);
    expect(next.roofs![0].outline[0]).toEqual({ x: 1, y: 1 });
  });

  it("scale skaliert den Dachumriss", () => {
    const p = bimProject({ roofs: [roof("rf1", [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }])] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, roofIds: ["rf1"] };
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]; // Faktor 2
    const next = commitTransform(p, sel, "scale", pts, "move", 1);
    expect(next.roofs![0].outline[2]).toEqual({ x: 8, y: 8 });
  });

  it("rotate lässt das Dach UNVERÄNDERT (Umriss ist rechteckig/achsgebunden, ridgeAxis würde sonst falsch)", () => {
    const original = roof("rf1", [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]);
    const p = bimProject({ roofs: [original] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, roofIds: ["rf1"] };
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]; // 90°
    const next = commitTransform(p, sel, "rotate", pts, "move", 1);
    expect(next.roofs![0]).toEqual(original);
  });

  it("mirror lässt das Dach ebenfalls UNVERÄNDERT", () => {
    const original = roof("rf1", [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]);
    const p = bimProject({ roofs: [original] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, roofIds: ["rf1"] };
    const next = commitTransform(p, sel, "mirror", [{ x: 0, y: 0 }, { x: 0, y: 1 }], "move", 1);
    expect(next.roofs![0]).toEqual(original);
  });

  it("REGRESSION: Dach bleibt auch dann unverändert, wenn ZUSÄTZLICH eine Wand mitselektiert ist (mode:\"move\")", () => {
    // `movesOriginal` (mode:"move") liest ceiling/roof/stair/room-IDs direkt
    // aus `sel`, nicht aus dem bereits op-gefilterten `items` — ohne eigene
    // Ausnahmeprüfung würde eine gemischte Auswahl (Wand + Dach) das Dach
    // trotzdem rotieren/spiegeln, sobald IRGENDein anderes Element die
    // `items.length === 0`-Kurzschluss-Rückgabe verhindert.
    const original = roof("rf1", [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]);
    const wall: import("../model/types").Wall = {
      id: "w1",
      type: "wall",
      floorId: "eg",
      categoryCode: "20",
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 },
      wallTypeId: "wt1",
      height: 2.5,
    };
    const p = bimProject({ roofs: [original], walls: [wall] });
    const sel: TransformSelection = { wallIds: ["w1"], drawingId: null, roofIds: ["rf1"] };
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]; // 90°
    const next = commitTransform(p, sel, "rotate", pts, "move", 1);
    expect(next.roofs![0]).toEqual(original);
    expect(next.walls[0].end.y).toBeCloseTo(1, 6); // Wand hat sich sehr wohl gedreht
  });
});

describe("commitTransform — Treppe (Richtung/Umlaufsinn/Skalierung)", () => {
  it("move verschiebt Antritt, Laufrichtung bleibt", () => {
    const p = bimProject({ stairs: [straightStair("s1")] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, stairIds: ["s1"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 3, y: 4 }], "move", 1);
    const s = next.stairs![0];
    expect(s.start).toEqual({ x: 3, y: 4 });
    expect(s.dir.x).toBeCloseTo(1, 6);
    expect(s.dir.y).toBeCloseTo(0, 6);
  });

  it("rotate um 90° dreht die Laufrichtung mit", () => {
    const p = bimProject({ stairs: [straightStair("s1")] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, stairIds: ["s1"] };
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]; // 90°, Drehpunkt = Antritt
    const next = commitTransform(p, sel, "rotate", pts, "move", 1);
    const s = next.stairs![0];
    expect(s.dir.x).toBeCloseTo(0, 6);
    expect(s.dir.y).toBeCloseTo(1, 6);
  });

  it("scale zieht Lauflänge/-breite mit, stepCount (Anzahl) bleibt unberührt", () => {
    const p = bimProject({ stairs: [straightStair("s1")] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, stairIds: ["s1"] };
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]; // Faktor 2
    const next = commitTransform(p, sel, "scale", pts, "move", 1);
    const s = next.stairs![0];
    expect(s.runLength).toBeCloseTo(6, 6);
    expect(s.width).toBeCloseTo(2.4, 6);
    expect(s.stepCount).toBe(18);
  });

  it("mirror kippt `turn` (L-Treppe) — Umlaufsinn kehrt um", () => {
    const l: Stair = { ...straightStair("s1"), shape: "L", run2Length: 2, turn: 1 };
    const p = bimProject({ stairs: [l] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, stairIds: ["s1"] };
    const next = commitTransform(p, sel, "mirror", [{ x: 0, y: 0 }, { x: 0, y: 1 }], "move", 1);
    expect(next.stairs![0].turn).toBe(-1);
  });

  it("rotate lässt `turn` UNVERÄNDERT (orientierungserhaltend)", () => {
    const l: Stair = { ...straightStair("s1"), shape: "L", run2Length: 2, turn: 1 };
    const p = bimProject({ stairs: [l] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, stairIds: ["s1"] };
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
    const next = commitTransform(p, sel, "rotate", pts, "move", 1);
    expect(next.stairs![0].turn).toBe(1);
  });
});

describe("commitTransform — ExtrudedSolid mit Kreis-Profil (REGRESSION: circle.r skalierte nicht mit)", () => {
  function circleSolid(id: string): ExtrudedSolid {
    return {
      id,
      type: "extrudedSolid",
      levelId: "eg",
      points: [{ x: -1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: -1 }], // grobe Tessellierung
      height: 2,
      circle: { center: { x: 0, y: 0 }, r: 1 },
    };
  }

  it("scale zieht sowohl points als auch circle.r mit demselben Faktor", () => {
    const p = bimProject({ extrudedSolids: [circleSolid("e1")] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, extrudedSolidId: "e1" };
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }]; // Faktor 3
    const next = commitTransform(p, sel, "scale", pts, "move", 1);
    const s = next.extrudedSolids![0];
    expect(s.circle!.r).toBeCloseTo(3, 6);
    expect(s.points[2]).toEqual({ x: 3, y: 0 }); // (1,0) * 3
  });

  it("copy-Modus: dieselbe Skalierung gilt auch für die neu erzeugte Kopie", () => {
    const p = bimProject({ extrudedSolids: [circleSolid("e1")] });
    const sel: TransformSelection = { wallIds: [], drawingId: null, extrudedSolidId: "e1" };
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]; // Faktor 2
    const next = commitTransform(p, sel, "scale", pts, "copy", 1);
    expect(next.extrudedSolids!.length).toBe(2);
    expect(next.extrudedSolids![0].circle!.r).toBeCloseTo(1, 6); // Original unverändert
    expect(next.extrudedSolids![1].circle!.r).toBeCloseTo(2, 6); // Kopie skaliert
  });
});

describe("commitTransform — Blockinstanz (REGRESSION: scale skalierte nicht mit)", () => {
  function blockInstance(id: string, scale?: number): import("../model/types").Drawing2D {
    return {
      id,
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "block", blockDefId: "b1", at: { x: 0, y: 0 }, rotation: 0, ...(scale !== undefined ? { scale } : {}) },
    };
  }

  it("scale multipliziert das bestehende scale-Feld mit dem Faktor", () => {
    const p = bimProject({ drawings2d: [blockInstance("d1", 2)] });
    const sel: TransformSelection = { wallIds: [], drawingId: "d1" };
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }]; // Faktor 3
    const next = commitTransform(p, sel, "scale", pts, "move", 1);
    const g = next.drawings2d[0].geom;
    if (g.shape === "block") expect(g.scale).toBeCloseTo(6, 6); // 2 * 3
  });

  it("fehlendes scale-Feld (Default 1) wird korrekt mit dem Faktor multipliziert", () => {
    const p = bimProject({ drawings2d: [blockInstance("d1")] });
    const sel: TransformSelection = { wallIds: [], drawingId: "d1" };
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2.5, y: 0 }]; // Faktor 2.5
    const next = commitTransform(p, sel, "scale", pts, "move", 1);
    const g = next.drawings2d[0].geom;
    if (g.shape === "block") expect(g.scale).toBeCloseTo(2.5, 6);
  });
});

describe("commitTransform — Objekt-Sperre (locked) wird respektiert", () => {
  const lockedWall: import("../model/types").Wall = {
    id: "w-locked",
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
    wallTypeId: "wt1",
    height: 2.5,
    locked: true,
  };
  const freeWall: import("../model/types").Wall = { ...lockedWall, id: "w-free", locked: false };

  it("mode:\"move\" lässt eine gesperrte Wand unverändert, eine ungesperrte in derselben Auswahl bewegt sich", () => {
    const p = bimProject({ walls: [lockedWall, freeWall] });
    const sel: TransformSelection = { wallIds: ["w-locked", "w-free"], drawingId: null };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 5, y: 5 }], "move", 1);
    const w1 = next.walls.find((w) => w.id === "w-locked")!;
    const w2 = next.walls.find((w) => w.id === "w-free")!;
    expect(w1.start).toEqual({ x: 0, y: 0 }); // unverändert
    expect(w2.start).toEqual({ x: 5, y: 5 }); // bewegt
  });

  it("copy-Modus: eine gesperrte Wand wird NICHT kopiert (gatherItems filtert sie schon heraus)", () => {
    const p = bimProject({ walls: [lockedWall, freeWall] });
    const sel: TransformSelection = { wallIds: ["w-locked", "w-free"], drawingId: null };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 5, y: 5 }], "copy", 1);
    // 2 Originale (unverändert unter copy-Modus, s. movesOriginal) + 1 Kopie
    // (nur die ungesperrte Wand) = 3 Wände total.
    expect(next.walls).toHaveLength(3);
    expect(next.walls.filter((w) => w.start.x === 0 && w.start.y === 0)).toHaveLength(2); // beide Originale
    expect(next.walls.filter((w) => w.start.x === 5 && w.start.y === 5)).toHaveLength(1); // nur die Kopie der freien Wand
  });

  it("mode:\"move\" lässt einen gesperrten Raum unverändert, auch bei gemischter Auswahl mit einer Wand (REGRESSION: movesOriginal-Zweig)", () => {
    const lockedRoom: Room = { ...room("r1", [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }]), locked: true };
    const p = bimProject({ rooms: [lockedRoom], walls: [freeWall] });
    const sel: TransformSelection = { wallIds: ["w-free"], drawingId: null, roomIds: ["r1"] };
    const next = commitTransform(p, sel, "move", [{ x: 0, y: 0 }, { x: 5, y: 5 }], "move", 1);
    expect(next.rooms![0].boundary).toEqual(lockedRoom.boundary); // unverändert
    expect(next.walls[0].start).toEqual({ x: 5, y: 5 }); // Wand hat sich sehr wohl bewegt
  });
});

describe("rotateGizmoShapes — Dreh-Darstellung (Referenz-/Winkel-Strahl + Radius-Kreis)", () => {
  it("liefert Referenz-Strahl, Winkel-Strahl und einen Radius-Kreis aus einzelnen Liniensegmenten", () => {
    const shapes = rotateGizmoShapes({ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3 });
    expect(shapes[0]).toEqual({ kind: "line", a: { x: 0, y: 0 }, b: { x: 3, y: 0 } });
    expect(shapes[1]).toEqual({ kind: "line", a: { x: 0, y: 0 }, b: { x: 0, y: 3 } });
    // Kreis: ab Index 2 nur noch "line"-Segmente (KEIN "poly" — s. Dateikommentar:
    // ein geschlossenes Polygon würde im 2D-SVG-Overlay gefüllt gerendert).
    const circleSegs = shapes.slice(2);
    expect(circleSegs.length).toBeGreaterThan(16);
    for (const seg of circleSegs) {
      expect(seg.kind).toBe("line");
      if (seg.kind === "line") {
        expect(Math.hypot(seg.a.x, seg.a.y)).toBeCloseTo(3, 6);
        expect(Math.hypot(seg.b.x, seg.b.y)).toBeCloseTo(3, 6);
      }
    }
    // Der Kreis schliesst sich (letztes Segment endet wieder am ersten Punkt).
    const last = circleSegs[circleSegs.length - 1];
    const first = circleSegs[0];
    if (last.kind === "line" && first.kind === "line") {
      expect(last.b).toEqual(first.a);
    }
  });

  it("Zentrum == Referenzpunkt (Radius 0): kein Gizmo, leeres Array", () => {
    expect(rotateGizmoShapes({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 5, y: 5 })).toEqual([]);
  });
});
