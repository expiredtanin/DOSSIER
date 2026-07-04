/**
 * Unit-Tests für {@link selectionHighlightLines} (Umriss-Linien der 3D-
 * Auswahl, s. Datei-Kommentar in toWalls3d.ts): korrekte Vertexanzahl je
 * Bauteilart (Wand-Quader = 12 Kanten, Slab-Prisma = 3·n Kanten) sowie die
 * Leerfälle (keine Auswahl / unbekannte Id).
 */

import { describe, it, expect } from "vitest";
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

  it("eine Wand MIT Öffnungen -> mehrere Teilquader (mehr als 12 Kanten)", () => {
    // W1 trägt Tür D1 + Fenster O1 -> Pfeiler/Brüstung/Sturz-Segmente, also
    // ein Vielfaches von 12 Kanten (mehr als ein einzelner Quader).
    const lines = selectionHighlightLines(sampleProject, ["W1"], [], RGB);
    expect(lines.length).toBeGreaterThan(12 * VERTICES_PER_EDGE * FLOATS_PER_VERTEX);
    expect(lines.length % (12 * VERTICES_PER_EDGE * FLOATS_PER_VERTEX)).toBe(0);
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
