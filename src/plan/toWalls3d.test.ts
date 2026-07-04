/**
 * Unit-Tests für {@link selectionHighlightLines} (Umriss-Linien der 3D-
 * Auswahl, s. Datei-Kommentar in toWalls3d.ts): korrekte Vertexanzahl je
 * Bauteilart (Wand-Quader = 12 Kanten, Slab-Prisma = 3·n Kanten) sowie die
 * Leerfälle (keine Auswahl / unbekannte Id).
 */

import { describe, it, expect } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { selectionHighlightLines } from "./toWalls3d";

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

  it("eine Wand ohne Öffnungen -> genau 12 Kanten (ein Quader)", () => {
    // W2 (EG, Ost) trägt keine Tür/kein Fenster im Sample-Projekt (nur W1/W3
    // haben Öffnungen, s. sampleProject.ts) -> ein einziger Teilquader, also
    // exakt 12 Kanten.
    const lines = selectionHighlightLines(sampleProject, ["W2"], [], RGB);
    expect(lines.length).toBe(12 * VERTICES_PER_EDGE * FLOATS_PER_VERTEX);
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
