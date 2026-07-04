/**
 * Unit-Tests für {@link selectionHighlightLines} (Umriss-Linien der 3D-
 * Auswahl, s. Datei-Kommentar in toWalls3d.ts): korrekte Vertexanzahl je
 * Bauteilart (Wand-Quader = 12 Kanten, Slab-Prisma = 3·n Kanten) sowie die
 * Leerfälle (keine Auswahl / unbekannte Id).
 */

import { describe, it, expect } from "vitest";
import type { Project } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import { selectionHighlightLines, projectToWalls3d, projectToModel3d } from "./toWalls3d";

const RGB: [number, number, number] = [1, 0.5, 0.1];
const FLOATS_PER_VERTEX = 6; // [px,py,pz, r,g,b]
const VERTICES_PER_EDGE = 2;

describe("selectionHighlightLines", () => {
  it("leere Auswahl -> leeres Array", () => {
    const lines = selectionHighlightLines(sampleProject, [], [], RGB);
    expect(lines.length).toBe(0);
  });

  it("unbekannte Ids -> leeres Array (keine Übereinstimmung in der Geometrie)", () => {
    const lines = selectionHighlightLines(sampleProject, ["does-not-exist"], [], RGB);
    expect(lines.length).toBe(0);
  });

  it("eine Wand ohne Öffnungen -> je Materiallage ein Quader (4·12 Kanten)", () => {
    // W2 (EG, Ost) trägt keine Tür/kein Fenster im Sample-Projekt (nur W1/W3
    // haben Öffnungen, s. sampleProject.ts) -> ein Achsen-Teilquader. Wandtyp
    // "aw" hat 4 Schichten (render-ext/insulation/brick/render-int), die
    // TS-seitig je als eigene Box gestapelt werden (Option B) -> 4 Quader =
    // 4·12 Kanten. (Früher: 1 Vollkörper = 12 Kanten.)
    const lines = selectionHighlightLines(sampleProject, ["W2"], [], RGB);
    expect(lines.length).toBe(4 * 12 * VERTICES_PER_EDGE * FLOATS_PER_VERTEX);
  });

  it("eine Wand mit Farbwerten in jedem Vertex", () => {
    const lines = selectionHighlightLines(sampleProject, ["W2"], [], RGB);
    // Erstes Vertex: Position (3) + Farbe (3) = [px,py,pz,r,g,b].
    expect(lines[3]).toBeCloseTo(RGB[0], 6);
    expect(lines[4]).toBeCloseTo(RGB[1], 6);
    expect(lines[5]).toBeCloseTo(RGB[2], 6);
  });

  it("eine Decke (Slab) -> 3·n Kanten (n = Umriss-Eckenzahl)", () => {
    // C1 hat einen 4-eckigen Umriss (5x4m Rechteck) -> 3*4 = 12 Kanten.
    const lines = selectionHighlightLines(sampleProject, [], ["C1"], RGB);
    const n = 4;
    expect(lines.length).toBe(3 * n * VERTICES_PER_EDGE * FLOATS_PER_VERTEX);
  });

  it("Mehrfachauswahl (Wand + Decke) -> Summe der Einzelgeometrien", () => {
    const wallOnly = selectionHighlightLines(sampleProject, ["W2"], [], RGB);
    const ceilingOnly = selectionHighlightLines(sampleProject, [], ["C1"], RGB);
    const both = selectionHighlightLines(sampleProject, ["W2"], ["C1"], RGB);
    expect(both.length).toBe(wallOnly.length + ceilingOnly.length);
  });

  it("mehrere gewählte Wände -> Kantenzahl skaliert linear", () => {
    const one = selectionHighlightLines(sampleProject, ["W2"], [], RGB);
    const two = selectionHighlightLines(sampleProject, ["W2", "W4"], [], RGB);
    expect(two.length).toBe(one.length * 2);
  });

  it("eine Wand MIT Öffnungen -> EIN Körper je Schicht-Band mit Löchern (kein Segment-Vielfaches mehr)", () => {
    // NEUES Verhalten (3D-Pfad, layered=true): W1 (Tür D1 + Fenster O1) wird
    // NICHT mehr in Pfeiler/Brüstung/Sturz zerlegt, sondern als EIN Körper pro
    // Schicht-Band mit echten Löchern emittiert. Das Highlight umrandet daher
    // genau die Schicht-Bänder (Wandtyp "aw" = 4 Schichten) — exakt so viele
    // Kanten wie eine öffnungslose Wand desselben Typs (W2), NICHT ein Vielfaches
    // durch Segmente. (Die Löcher selbst fügen im Highlight keine Kanten hinzu.)
    const w1 = selectionHighlightLines(sampleProject, ["W1"], [], RGB);
    const w2 = selectionHighlightLines(sampleProject, ["W2"], [], RGB);
    expect(w1.length).toBe(4 * 12 * VERTICES_PER_EDGE * FLOATS_PER_VERTEX);
    expect(w1.length).toBe(w2.length);
  });
});

describe("Öffnungen als echte Löcher in EINEM Körper (3D-Pfad, layeredWalls:true)", () => {
  // Wand W1 (EG, Wandtyp "aw" = 4 Schichten) mit ZWEI Fenstern, deren Achsen-
  // Intervalle sich ÜBERLAPPEN, aber auf UNTERSCHIEDLICHER Höhe liegen:
  //   Fenster A: u=[1.0,2.0] (position 1.0, width 1.0), z=[0.9,2.1] (sill 0.9, h 1.2)
  //   Fenster B: u=[1.5,2.5] (position 1.5, width 1.0), z=[0.3,0.7] (sill 0.3, h 0.4)
  // Die alte Segment-Zerlegung kann diesen versetzt-überlappenden Fall nicht
  // abbilden; als Löcher in EINEM Körper müssen beide sauber als `holes`
  // erscheinen. W1: start (0,0)->(5,0), floor "eg" (baseElevation 0).
  const twoOffsetWindows: Project = {
    ...sampleProject,
    doors: [],
    openings: [
      {
        id: "WA",
        type: "opening",
        hostWallId: "W1",
        categoryCode: "21",
        kind: "window",
        position: 1.0,
        width: 1.0,
        height: 1.2,
        sillHeight: 0.9,
      },
      {
        id: "WB",
        type: "opening",
        hostWallId: "W1",
        categoryCode: "21",
        kind: "window",
        position: 1.5,
        width: 1.0,
        height: 0.4,
        sillHeight: 0.3,
      },
    ],
  };

  it("layered=true: 1 RWall je Schicht-Band mit BEIDEN Fenstern als holes", () => {
    const w1 = projectToWalls3d(twoOffsetWindows, true).filter((w) => w.wallId === "W1");
    // Genau ein Körper je Schicht-Band (aw = 4 Schichten), KEINE Segment-Boxen.
    expect(w1.length).toBe(4);
    for (const body of w1) {
      // Jeder Band-Körper trägt BEIDE Löcher (in EINEM Körper).
      expect(body.holes).toBeDefined();
      expect(body.holes!.length).toBe(2);
      const byFrom = [...body.holes!].sort((a, b) => a.from - b.from);
      // Fenster A: u=[1,2], z=[0.9,2.1].
      expect(byFrom[0].from).toBeCloseTo(1.0, 6);
      expect(byFrom[0].to).toBeCloseTo(2.0, 6);
      expect(byFrom[0].zBottom).toBeCloseTo(0.9, 6);
      expect(byFrom[0].zTop).toBeCloseTo(2.1, 6);
      // Fenster B: u=[1.5,2.5], z=[0.3,0.7] — überlappt A in u, liegt tiefer.
      expect(byFrom[1].from).toBeCloseTo(1.5, 6);
      expect(byFrom[1].to).toBeCloseTo(2.5, 6);
      expect(byFrom[1].zBottom).toBeCloseTo(0.3, 6);
      expect(byFrom[1].zTop).toBeCloseTo(0.7, 6);
    }
  });

  it("layered=false (Schnitt-Pfad): unverändert segmentiert, KEINE holes", () => {
    const w1 = projectToWalls3d(twoOffsetWindows, false).filter((w) => w.wallId === "W1");
    // Der Schnitt-Pfad zerlegt weiter in Pfeiler/Brüstung/Sturz-Segmente (mehr
    // Boxen als die 4 Schicht-Bänder des 3D-Pfads) und setzt NIE `holes`.
    expect(w1.length).toBeGreaterThan(4);
    for (const seg of w1) expect(seg.holes).toBeUndefined();
  });

  it("Tür = Loch bis zur Wand-UK (zBottom == baseElevation)", () => {
    // Eine Tür (D1 auf W1) muss im 3D-Pfad als Loch bis zum Boden erscheinen:
    // zBottom des Lochs == Wand-UK (0), NICHT ab einer Brüstung.
    const p: Project = { ...sampleProject, openings: [] };
    const w1 = projectToWalls3d(p, true).filter((w) => w.wallId === "W1");
    expect(w1.length).toBe(4);
    const door = w1[0].holes?.find((h) => h.zBottom < 1e-6);
    expect(door).toBeDefined();
    expect(door!.zBottom).toBeCloseTo(0, 6); // Loch bis zur Wand-UK.
  });
});

describe("Bauteil-/Materialfarbe statt Einheits-Grau (Wände + Decken)", () => {
  it("Wand -> je Materiallage eine Box in ihrer Component-Farbe (Option B)", () => {
    // Wandtyp "aw" (s. sampleProject) hat 4 Schichten mit eigenen Farben:
    //   render-ext 0.02 #d8d2c7, insulation 0.16 #ffffff,
    //   brick 0.15 #8c5544, render-int 0.015 #efece6  (Σ = 0.345 m).
    // W2 ist öffnungslos -> genau ein Achsen-Teilquader, also 4 Schicht-Boxen.
    const walls = projectToWalls3d(sampleProject);
    const w2 = walls.filter((w) => w.wallId === "W2");
    expect(w2.length).toBe(4);

    // Alle Schicht-Boxen tragen die gemeinsame wallId (Klick selektiert ganze Wand)
    // und sind Vollkörper (layers leer -> render3d zeichnet in `color`).
    for (const seg of w2) {
      expect(seg.wallId).toBe("W2");
      expect(seg.layers.length).toBe(0);
    }

    // Die vier Materialfarben kommen genau einmal vor.
    const hex = (c: [number, number, number]) =>
      c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    const colors = w2.map((s) => hex(s.color)).sort();
    expect(colors).toEqual(["8c5544", "d8d2c7", "efece6", "ffffff"]);

    // Die Schichtdicken summieren zur Gesamt-Wanddicke (keine Lücken/Overlaps).
    const totalT = w2.reduce((s, seg) => s + seg.thickness, 0);
    expect(totalT).toBeCloseTo(0.345, 6);
  });

  it("Schicht-Offsets kacheln die Wanddicke lückenlos um die Achse", () => {
    // W2-Achse (5,0)->(5,4): u=(0,1), Normale n=(1,0) -> der Schicht-Versatz
    // wirkt rein auf x (Box-Start.x = 5 + offset). Sortiert man die Boxen nach
    // Versatz, müssen sich benachbarte Flächen exakt berühren und der Stapel
    // symmetrisch um die Achse liegen: min = -T/2, max = +T/2.
    const w2 = projectToWalls3d(sampleProject).filter((w) => w.wallId === "W2");
    const bands = w2
      .map((s) => ({ offset: s.start[0] - 5, t: s.thickness }))
      .sort((a, b) => a.offset - b.offset);
    const T = bands.reduce((s, b) => s + b.t, 0);
    expect(bands[0].offset - bands[0].t / 2).toBeCloseTo(-T / 2, 6);
    expect(bands[bands.length - 1].offset + bands[bands.length - 1].t / 2).toBeCloseTo(T / 2, 6);
    for (let i = 1; i < bands.length; i++) {
      // Oberkante der Vorlage == Unterkante der nächsten (keine Lücke/Overlap).
      expect(bands[i - 1].offset + bands[i - 1].t / 2).toBeCloseTo(bands[i].offset - bands[i].t / 2, 6);
    }
  });

});

describe("Fenster-Glasscheiben (emitOpeningGlass)", () => {
  it("1 Fenster + 1 Tür -> genau 1 Glas-Mesh mit korrekter vertikaler Ausdehnung", () => {
    // Sample-Projekt auf EINE Öffnung (Fenster O1) + EINE Tür (D1) reduzieren,
    // beide auf W1 (EG, baseElevation 0). Kontext ist leer -> `meshes` enthält
    // ausschliesslich die Glasscheiben.
    const p: Project = {
      ...sampleProject,
      openings: (sampleProject.openings ?? []).filter((o) => o.id === "O1"),
      doors: sampleProject.doors,
      context: [],
    };
    const { meshes } = projectToModel3d(p);
    // Genau EINE Scheibe: das Fenster O1; die Tür D1 bleibt offen (keine Scheibe).
    expect(meshes.length).toBe(1);
    const glass = meshes[0];
    // Quader: 8 Ecken (24 Floats) + 12 Dreiecke (36 Indizes), leicht bläuliches Glas.
    expect(glass.positions.length).toBe(24);
    expect(glass.indices.length).toBe(36);
    expect(glass.color).toEqual([0.62, 0.76, 0.85]);

    // Vertikale Ausdehnung (z = 3. Komponente jeder Ecke, MODELL-Höhe):
    // O1 sillHeight 0.9, height 1.2, Wand-UK 0 -> UK 0.9 .. OK 2.1.
    const zs: number[] = [];
    for (let i = 2; i < glass.positions.length; i += 3) zs.push(glass.positions[i]);
    expect(Math.min(...zs)).toBeCloseTo(0.9, 6);
    expect(Math.max(...zs)).toBeCloseTo(2.1, 6);
  });

  it("Türen bekommen keine Scheibe; je Fenster genau eine", () => {
    // Volles Sample-Projekt: 2 Fenster (O1, O2) + 1 Tür (D1), Kontext leer.
    const { meshes } = projectToModel3d(sampleProject);
    expect(meshes.length).toBe(2);
  });
});

describe("Prioritäts-Trim Wand/Decke (Z-Fighting-Fix, s. trimWallTopForCeilings)", () => {
  // Sample-Projekt: W1-W4 (EG, Wandtyp "aw", dominante Schicht "brick"
  // joinPriority 50) tragen exakt Wandhöhe 2.6 m = Geschosshöhe -> zTop 2.6.
  // Decke C1 (EG, Deckentyp "dg-massiv", dominante Schicht "concrete"
  // joinPriority 100) hat OK bündig mit dem Wandkopf (zTop 2.6) und
  // Gesamtdicke 0.3 m (screed .06 + insulation .04 + concrete .2) -> zBottom
  // 2.3. Vor dem Trim überlappten sich Wand- und Deckenvolumen exakt über
  // [2.3..2.6] im ganzen Wand-Footprint (Z-Fighting). Nach dem Trim endet die
  // Wand an der Deckenunterkante, weil die Decke die höhere joinPriority hat.
  it("Decke mit höherer joinPriority kappt die Wand an ihrer Unterkante", () => {
    const w2 = projectToWalls3d(sampleProject).filter((w) => w.wallId === "W2");
    expect(w2.length).toBeGreaterThan(0);
    for (const seg of w2) {
      expect(seg.baseElevation + seg.height).toBeCloseTo(2.3, 6);
    }
  });

  it("kein Trim, wenn die Wand-Priorität >= Decken-Priorität ist", () => {
    // Deckentyp-Priorität (concrete) auf 40 senken -> unter der Wand-Priorität
    // (brick 50) -> die Decke gewinnt nicht mehr, die Wand bleibt unverändert
    // auf voller Höhe (2.6 m, wie ohne Trim-Logik).
    const p: Project = {
      ...sampleProject,
      components: sampleProject.components.map((c) =>
        c.id === "concrete" ? { ...c, joinPriority: 40 } : c,
      ),
    };
    const w2 = projectToWalls3d(p).filter((w) => w.wallId === "W2");
    expect(w2.length).toBeGreaterThan(0);
    for (const seg of w2) {
      expect(seg.baseElevation + seg.height).toBeCloseTo(2.6, 6);
    }
  });

  it("kein Trim, wenn keine Decke im selben Geschoss überlappt (z.B. OG-Wände ohne Dach-Decke)", () => {
    // W6 (OG) hat keine überlappende Decke im Sample-Projekt (C1 ist EG) ->
    // unverändertes Verhalten (volle wall.height).
    const w6 = projectToWalls3d(sampleProject).filter((w) => w.wallId === "W6");
    expect(w6.length).toBeGreaterThan(0);
    for (const seg of w6) {
      expect(seg.height).toBeCloseTo(2.6, 6);
    }
  });
});

describe("Bauteil-/Materialfarbe Decke", () => {
  it("Decke -> Farbe der dicksten Schicht (dg-massiv: concrete 0.2 m, #9aa0a6)", () => {
    // Deckentyp "dg-massiv": screed 0.06, insulation 0.04, concrete 0.2 ->
    // dickste Schicht = concrete (#9aa0a6).
    const { slabs } = projectToModel3d(sampleProject);
    const c1 = slabs.find((s) => s.ceilingId === "C1");
    expect(c1).toBeDefined();
    expect(c1!.color[0]).toBeCloseTo(0x9a / 255, 6);
    expect(c1!.color[1]).toBeCloseTo(0xa0 / 255, 6);
    expect(c1!.color[2]).toBeCloseTo(0xa6 / 255, 6);
  });
});
