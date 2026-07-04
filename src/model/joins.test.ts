/**
 * Unit-Tests für die Wand-Gehrung (computeJoins / miterLine):
 *  • Rechtwinklige L-Ecke: die Gehrung liegt auf der 45°-Diagonalen und trifft
 *    die korrekten Fläche×Fläche-Apexe.
 *  • SPITZE L-Ecke (Öffnungswinkel < 90°): die Gehrung muss weiterhin Außen mit
 *    Außen und Innen mit Innen paaren. Die frühere Distanz-Heuristik kippte hier
 *    und lieferte eine um 90° verdrehte Gehrung (Kreuz-Overlap der Poché-Bänder);
 *    dieser Test fängt den Regress.
 *  • T-Knoten (drei Wandenden am selben Punkt): das abzweigende Ende bekommt
 *    einen Schnitt auf der zugewandten Fläche der Durchgangswand, die beiden
 *    kollinearen Enden bleiben ungeschnitten.
 *  • Mittelspannen-T-Stoß: ein freies Ende, das mitten auf die Seite einer
 *    anderen Wand trifft, bekommt einen Schnitt auf deren Fläche; ohne Treffer
 *    bleibt es rechtwinklig (null).
 */

import { describe, it, expect } from "vitest";
import { computeJoins, resolveJoinPriority } from "./joins";
import { cross, len, sub } from "./geometry";
import type { Line } from "./geometry";
import type { Component, Project, Vec2, Wall } from "./types";

/** Abstand eines Punktes P von der unendlichen Geraden `line`. */
function distToLine(line: Line, p: Vec2): number {
  return Math.abs(cross(line.dir, sub(p, line.point))) / len(line.dir);
}

/** Minimalprojekt aus zwei Wänden mit einem Wandtyp gegebener Gesamtdicke. */
function twoWallProject(w1: Wall, w2: Wall, thickness: number): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [
      { id: "aw", name: "AW", layers: [{ componentId: "c", thickness }] },
    ],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [w1, w2],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

/** Minimalprojekt aus drei Wänden mit einem Wandtyp gegebener Gesamtdicke. */
function threeWallProject(
  w1: Wall,
  w2: Wall,
  w3: Wall,
  thickness: number,
): Project {
  const proj = twoWallProject(w1, w2, thickness);
  proj.walls = [w1, w2, w3];
  return proj;
}

function wall(id: string, start: Vec2, end: Vec2): Wall {
  return {
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start,
    end,
    wallTypeId: "aw",
    height: 2.6,
  };
}

describe("computeJoins — Gehrung an der L-Ecke", () => {
  it("legt die rechtwinklige Gehrung auf die 45°-Diagonale (Fläche×Fläche-Apexe)", () => {
    // W1 (0,0)→(5,0), W2 (5,0)→(5,4); Knoten (5,0). T=0.4, half=0.2.
    const proj = twoWallProject(
      wall("W1", { x: 0, y: 0 }, { x: 5, y: 0 }),
      wall("W2", { x: 5, y: 0 }, { x: 5, y: 4 }),
      0.4,
    );
    const joins = computeJoins(proj, proj.walls);
    const cut = joins.get("W1")!.endCut;
    expect(cut).not.toBeNull();
    // Außen-Apex (5.2,−0.2) und Innen-Apex (4.8,0.2) liegen auf der Gehrung;
    // Richtung ist die 45°-Diagonale.
    expect(distToLine(cut!, { x: 5.2, y: -0.2 })).toBeCloseTo(0, 6);
    expect(distToLine(cut!, { x: 4.8, y: 0.2 })).toBeCloseTo(0, 6);
    expect(Math.abs(cut!.dir.x)).toBeCloseTo(Math.abs(cut!.dir.y), 6);
  });

  it("paart bei SPITZEM Winkel Außen-mit-Außen und Innen-mit-Innen (kein Kreuz-Overlap)", () => {
    // Symmetrische V-Ecke, Knoten (0,0), Öffnungswinkel 60° (spitz), nach oben.
    // Beide Wandkörper laufen unter ±30° zur +y-Achse aus:
    //   gA = (−sin30, cos30) = (−0.5, √3/2), gB = (+0.5, √3/2).
    // W_A: end im Knoten (start = gA·2), W_B: start im Knoten (end = gB·2).
    const s3 = Math.sqrt(3) / 2;
    const proj = twoWallProject(
      wall("WA", { x: -1, y: 2 * s3 }, { x: 0, y: 0 }),
      wall("WB", { x: 0, y: 0 }, { x: 1, y: 2 * s3 }),
      0.4,
    );
    const joins = computeJoins(proj, proj.walls);
    // Beide Wände teilen dieselbe Gehrung; WA endet im Knoten, WB startet dort.
    const cut = joins.get("WA")!.endCut ?? joins.get("WB")!.startCut;
    expect(cut).not.toBeNull();

    // Korrekt: Außen-Apex (0,−0.4) und Innen-Apex (0,0.4) → vertikale Gehrung
    // (Richtung parallel zur y-Achse). Die buggy Distanz-Heuristik lieferte
    // stattdessen eine HORIZONTALE Gehrung (Apexe (±0.23,0)) → hier rot.
    expect(distToLine(cut!, { x: 0, y: -0.4 })).toBeCloseTo(0, 6);
    expect(distToLine(cut!, { x: 0, y: 0.4 })).toBeCloseTo(0, 6);
    // Gehrung vertikal: dir.x ≈ 0 (die falsche, horizontale Gehrung hätte dir.y ≈ 0).
    const dir = cut!.dir;
    expect(Math.abs(dir.x) / len(dir)).toBeCloseTo(0, 6);
  });
});

describe("computeJoins — T-Knoten (drei Wandenden am selben Punkt)", () => {
  it("schneidet nur das abzweigende Ende, auf der zugewandten Fläche der Durchgangswand", () => {
    // Durchgangswand in zwei Hälften WA1 (0,0)→(5,0) und WA2 (5,0)→(10,0),
    // Abzweig WB (5,0)→(5,3) nach oben. T=0.4 → halbe Dicke 0.2.
    const proj = threeWallProject(
      wall("WA1", { x: 0, y: 0 }, { x: 5, y: 0 }),
      wall("WA2", { x: 5, y: 0 }, { x: 10, y: 0 }),
      wall("WB", { x: 5, y: 0 }, { x: 5, y: 3 }),
      0.4,
    );
    const joins = computeJoins(proj, proj.walls);

    // Die kollinearen Hälften der Durchgangswand bleiben ungeschnitten.
    expect(joins.get("WA1")!.endCut).toBeNull();
    expect(joins.get("WA2")!.startCut).toBeNull();

    // Der Abzweig bekommt einen Schnitt auf der ihm zugewandten (oberen)
    // Fläche der Durchgangswand: die horizontale Gerade y = 0.2.
    const cut = joins.get("WB")!.startCut;
    expect(cut).not.toBeNull();
    expect(distToLine(cut!, { x: 5, y: 0.2 })).toBeCloseTo(0, 6);
    expect(distToLine(cut!, { x: 0, y: 0.2 })).toBeCloseTo(0, 6);
    // Gehrungsgerade horizontal (parallel zur Durchgangsachse).
    expect(Math.abs(cut!.dir.y) / len(cut!.dir)).toBeCloseTo(0, 6);
  });
});

describe("computeJoins — Mittelspannen-T-Stoß (Ende trifft Wandseite)", () => {
  it("schneidet ein freies Ende, das auf die Seite einer anderen Wand trifft, entlang deren Fläche", () => {
    // Durchgangswand W (0,0)→(10,0), T=0.4 → halbe Dicke 0.2. Abzweig WB2
    // trifft mit seinem freien Ende (4, 0.2) genau auf die obere Fläche.
    const proj = threeWallProject(
      wall("W", { x: 0, y: 0 }, { x: 10, y: 0 }),
      wall("WB2", { x: 4, y: 3 }, { x: 4, y: 0.2 }),
      wall("Filler", { x: 100, y: 100 }, { x: 100, y: 103 }), // unbeteiligt
      0.4,
    );
    const joins = computeJoins(proj, proj.walls);

    const cut = joins.get("WB2")!.endCut;
    expect(cut).not.toBeNull();
    expect(distToLine(cut!, { x: 0, y: 0.2 })).toBeCloseTo(0, 6);
    expect(distToLine(cut!, { x: 5, y: 0.2 })).toBeCloseTo(0, 6);
    expect(Math.abs(cut!.dir.y) / len(cut!.dir)).toBeCloseTo(0, 6);

    // Die Wand W selbst bleibt an ihren (freien) Enden ungeschnitten.
    expect(joins.get("W")!.startCut).toBeNull();
    expect(joins.get("W")!.endCut).toBeNull();
    // Das obere, unbeteiligte Ende von WB2 bleibt ebenfalls ungeschnitten.
    expect(joins.get("WB2")!.startCut).toBeNull();
  });

  it("lässt ein freies Ende rechtwinklig (null), wenn keine Wand nah genug getroffen wird", () => {
    // Gleiche Anordnung, aber Abzweig-Ende bei y=0.5 — außerhalb der
    // Wandfläche (Dicke/2 + Toleranz = 0.201).
    const proj = twoWallProject(
      wall("W", { x: 0, y: 0 }, { x: 10, y: 0 }),
      wall("WB3", { x: 4, y: 3 }, { x: 4, y: 0.5 }),
      0.4,
    );
    const joins = computeJoins(proj, proj.walls);
    expect(joins.get("WB3")!.endCut).toBeNull();
  });
});

describe("resolveJoinPriority — Ordnungslogik zweier Bauteile am Stoss", () => {
  const brick: Component = { id: "brick", name: "Backstein", color: "#8c5544", hatchId: "none", joinPriority: 50 };
  const brick2: Component = { id: "brick", name: "Backstein (Kopie)", color: "#000", hatchId: "none", joinPriority: 50 };
  const render: Component = { id: "render", name: "Putz", color: "#efece6", hatchId: "none", joinPriority: 10 };
  const insulation: Component = { id: "insulation", name: "Dämmung", color: "#fff", hatchId: "none", joinPriority: 20 };
  const concrete: Component = { id: "concrete", name: "Beton", color: "#9aa0a6", hatchId: "none", joinPriority: 100 };

  it("verschmilzt bei gleicher Priorität UND gleicher Komponente", () => {
    expect(resolveJoinPriority(brick, brick2)).toBe("merge");
  });

  it("koexistiert bei gleicher Priorität, aber verschiedener Komponente", () => {
    // Zwei fiktive Komponenten mit zufällig gleicher Priorität, aber
    // unterschiedlicher Identität — keine eindeutige Rangfolge.
    const other: Component = { id: "other-30", name: "X", color: "#123", hatchId: "none", joinPriority: 20 };
    expect(resolveJoinPriority(insulation, other)).toBe("coexist");
  });

  it("lässt die höhere Priorität gewinnen (die niedrigere wird getrimmt)", () => {
    expect(resolveJoinPriority(render, brick)).toBe("trim-a"); // a=Putz verliert
    expect(resolveJoinPriority(brick, render)).toBe("trim-b"); // b=Putz verliert
    expect(resolveJoinPriority(concrete, brick)).toBe("trim-b");
    expect(resolveJoinPriority(brick, concrete)).toBe("trim-a");
  });
});

/**
 * Minimalprojekt mit einem mehrschichtigen, W9-artigen Wandtyp
 * (Innenputz/Backstein-Kern/Innenputz, wie `sampleProject`s "iw") — für die
 * materialbewusste T-Stoss-Erweiterung (layerCuts).
 */
function layeredWallProject(w1: Wall, w2: Wall, w3: Wall): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [
      { id: "render-int", name: "Innenputz", color: "#efece6", hatchId: "none", joinPriority: 10 },
      { id: "brick", name: "Backstein", color: "#8c5544", hatchId: "none", joinPriority: 50 },
    ],
    wallTypes: [
      {
        id: "iw",
        name: "Innenwand",
        layers: [
          { componentId: "render-int", thickness: 0.015 },
          { componentId: "brick", thickness: 0.12 },
          { componentId: "render-int", thickness: 0.015 },
        ],
      },
    ],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [w1, w2, w3],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

function iwWall(id: string, start: Vec2, end: Vec2): Wall {
  return {
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start,
    end,
    wallTypeId: "iw",
    height: 2.6,
  };
}

describe("computeJoins — materialbewusster T-Stoss (layerCuts)", () => {
  it("W9-artiger T-Knoten: Backstein-Kern des Abzweigs sticht bis zur Rückgrat-Nahfläche durch, Putz wird getrimmt — materialgleicher Nah-Putz ⇒ KEINE L-Trennnaht", () => {
    // Durchgangswand WA1 (0,0)→(5,0) / WA2 (5,0)→(10,0), Abzweig WB (5,0)→(5,3),
    // alle vom selben Wandtyp "iw" (Innenputz/Backstein/Innenputz, T=0.15).
    const proj = layeredWallProject(
      iwWall("WA1", { x: 0, y: 0 }, { x: 5, y: 0 }),
      iwWall("WA2", { x: 5, y: 0 }, { x: 10, y: 0 }),
      iwWall("WB", { x: 5, y: 0 }, { x: 5, y: 3 }),
    );
    const joins = computeJoins(proj, proj.walls);
    const cuts = joins.get("WB")!;

    // Aggregat-Cut bleibt unverändert (bit-identisch zum bisherigen Verhalten).
    expect(cuts.startCut).not.toBeNull();
    expect(distToLine(cuts.startCut!, { x: 5, y: 0.075 })).toBeCloseTo(0, 6);

    // layerCuts ist gesetzt (mindestens eine Schicht verschmilzt).
    expect(cuts.layerCuts).toBeDefined();
    const lc = cuts.layerCuts!;
    expect(lc.start.length).toBe(3);

    // Schicht 1 (Backstein-Kern, Index 1) verschmilzt: Cut an der Nahfläche des
    // Durchgangs-Rückgrats — NICHT null (Achse) und NICHT die Aggregat-Nahfläche
    // (0.075). Durchgangswand-Halbdicke 0.075 minus Nah-Putz 0.015 → y = 0.06.
    expect(lc.start[1]).not.toBeNull();
    expect(distToLine(lc.start[1]!, { x: 5, y: 0.06 })).toBeCloseTo(0, 6);
    expect(distToLine(lc.start[1]!, { x: 0, y: 0.06 })).toBeCloseTo(0, 6);
    // Der Kern läuft NICHT bis zur Achse (y=0) durch.
    expect(distToLine(lc.start[1]!, { x: 5, y: 0 })).not.toBeCloseTo(0, 6);
    expect(lc.startSide[1]).toBeNull();

    // Schichten 0 und 2 (Innenputz) werden getrimmt: derselbe Nahflächen-Cut
    // wie das Aggregat...
    expect(lc.start[0]).not.toBeNull();
    expect(lc.start[2]).not.toBeNull();
    expect(distToLine(lc.start[0]!, { x: 5, y: 0.075 })).toBeCloseTo(0, 6);
    expect(distToLine(lc.start[2]!, { x: 5, y: 0.075 })).toBeCloseTo(0, 6);
    // ... aber KEINE L-Seitenlinie: der Nah-Putz der Durchgangswand ist
    // materialgleicher Innenputz und füllt den getrimmten Abzweig-Putz an den
    // Flanken durchgehend (der spanCutout schneidet nur die Kernbreite aus).
    // Es entsteht ein durchgehendes Putz-L ohne Trennnaht. Nur bei material-
    // FREMDEM Nah-Putz stünde hier eine L-Linie.
    expect(lc.startSide[0]).toBeNull();
    expect(lc.startSide[2]).toBeNull();

    // Die kollinearen Hälften der Durchgangswand bleiben bei den layerCuts
    // unangetastet (keine Pro-Schicht-Cuts für sie).
    expect(joins.get("WA1")!.layerCuts).toBeUndefined();
    expect(joins.get("WA2")!.layerCuts).toBeUndefined();

    // Die als Durchgang gewählte Wandhälfte bekommt eine Durchgangswand-Aussparung
    // (Phase 1c): über die Backstein-Kernbreite (0.12) im Nah-Putz-Bereich
    // (Offset 0.06…0.075). Welche Hälfte den Durchgang bildet, hängt von der
    // Knoten-Reihenfolge ab — wir prüfen die, die den Cutout trägt.
    const throughCuts = joins.get("WA1")!.spanCutouts ?? joins.get("WA2")!.spanCutouts;
    expect(throughCuts).toBeDefined();
    expect(throughCuts!.length).toBe(1);
    const sc = throughCuts![0];
    // Achsen-Intervall: Kernbreite 0.12, zentriert am Knoten (x=5 → [4.94,5.06]).
    expect(sc.to - sc.from).toBeCloseTo(0.12, 6);
    // offA = Nahfläche (0.075), offB = Rückgrat-Nahfläche (0.06).
    expect(sc.offA).toBeCloseTo(0.075, 6);
    expect(sc.offB).toBeCloseTo(0.06, 6);
    // Der Abzweig selbst trägt keine Aussparung (die gehört der Durchgangswand).
    expect(joins.get("WB")!.spanCutouts).toBeUndefined();
    // L-Ecke bzw. Wände ohne T bleiben cutout-frei (die kollineare Nicht-Durchgangs-
    // Hälfte hat keinen Cutout).
    expect(
      joins.get("WA1")!.spanCutouts === undefined ||
        joins.get("WA2")!.spanCutouts === undefined,
    ).toBe(true);
  });

  it("Mittelspannen-T-Stoss: die Durchgangswand bekommt einen spanCutout mit korrekter Kernbreite und Nah-Putz-Offsetzone", () => {
    // Realer W9-Fall: Durchgangswand als EINE Wand W (0,0)→(10,0), Abzweig WB
    // trifft mit seinem freien Ende (4,0) mittig auf ihre Seite. Beide iw.
    const proj = layeredWallProject(
      iwWall("W", { x: 0, y: 0 }, { x: 10, y: 0 }),
      iwWall("WB", { x: 4, y: 3 }, { x: 4, y: 0 }),
      iwWall("Filler", { x: 100, y: 100 }, { x: 100, y: 103 }), // unbeteiligt
    );
    const joins = computeJoins(proj, proj.walls);

    const wCuts = joins.get("W")!;
    expect(wCuts.spanCutouts).toBeDefined();
    expect(wCuts.spanCutouts!.length).toBe(1);
    const sc = wCuts.spanCutouts![0];
    // Intervall um x=4, Breite = Kernbreite 0.12 → [3.94, 4.06].
    expect(sc.from).toBeCloseTo(3.94, 6);
    expect(sc.to).toBeCloseTo(4.06, 6);
    expect(sc.offA).toBeCloseTo(0.075, 6);
    expect(sc.offB).toBeCloseTo(0.06, 6);
    // Der Abzweig und die unbeteiligte Wand tragen keine Aussparung.
    expect(joins.get("WB")!.spanCutouts).toBeUndefined();
    expect(joins.get("Filler")!.spanCutouts).toBeUndefined();
  });

  it("L-Ecke und einfacher (nicht materialbewusster) Stoss bekommen KEINEN spanCutout", () => {
    // Reine L-Ecke zweier Wände: keine Durchgangswand, kein Durchstoss.
    const proj = twoWallProject(
      wall("L1", { x: 0, y: 0 }, { x: 5, y: 0 }),
      wall("L2", { x: 5, y: 0 }, { x: 5, y: 4 }),
      0.4,
    );
    const joins = computeJoins(proj, proj.walls);
    expect(joins.get("L1")!.spanCutouts).toBeUndefined();
    expect(joins.get("L2")!.spanCutouts).toBeUndefined();
  });

  it("setzt layerCuts NICHT, wenn kein Bauteil des Abzweigs mit dem Rückgrat der Durchgangswand übereinstimmt", () => {
    // Gleiche Anordnung, aber der Abzweig ist eine reine Einschicht-Wand ohne
    // Materialübereinstimmung zum Backstein-Rückgrat → Default-Verhalten.
    const proj = layeredWallProject(
      iwWall("WA1", { x: 0, y: 0 }, { x: 5, y: 0 }),
      iwWall("WA2", { x: 5, y: 0 }, { x: 10, y: 0 }),
      iwWall("WB", { x: 5, y: 0 }, { x: 5, y: 3 }),
    );
    proj.wallTypes.push({
      id: "solo",
      name: "Solo",
      layers: [{ componentId: "render-int", thickness: 0.1 }],
    });
    proj.walls[2] = { ...proj.walls[2], wallTypeId: "solo" };
    const joins = computeJoins(proj, proj.walls);
    expect(joins.get("WB")!.layerCuts).toBeUndefined();
    expect(joins.get("WB")!.startCut).not.toBeNull(); // Aggregat-Cut bleibt normal
  });
});
