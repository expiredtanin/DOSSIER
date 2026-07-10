/**
 * Unit-Tests für die Aussen/Innen-Orientierung der mehrschichtigen Wand-Bänder
 * im SCHNITT (toSection): die Schicht-Bänder müssen der GRUNDRISS-Konvention
 * folgen (layers[0] = Aussenseite auf der `−leftNormal`-Weltseite der Achse), so
 * dass die Dämmung aussen und der Backstein innen liegt und zwei gegenüber-
 * liegende Wände im Schnitt SPIEGELVERKEHRT erscheinen (nicht identisch).
 *
 * Getestet ohne WASM: die Orientierungs-Hilfsfunktionen (`sectionUAxisModel`,
 * `wallLayersReversedInU`) und `splitWallLayers` mit einem synthetischen
 * Schnittrechteck gegen den echten „aw"-Wandtyp des Sample-Projekts.
 */

import { describe, it, expect } from "vitest";
import {
  sectionPlaneFromLevel,
  sectionUAxisModel,
  wallLayersReversedInU,
  splitWallLayers,
  type SectionCutPolygon,
} from "./toSection";
import { sampleProject } from "../model/sampleProject";
import { getWallType } from "../model/types";
import type { Wall } from "../model/types";

/** Wand aus dem Sample-Projekt per ID. */
function wall(id: string): Wall {
  const w = sampleProject.walls.find((x) => x.id === id);
  if (!w) throw new Error(`Wand ${id} fehlt im Sample-Projekt`);
  return w;
}

/** Achsparalleles Schnittrechteck (u, v): uMin..uMax × 0..2.6 m. */
function rect(uMin: number, uMax: number): SectionCutPolygon {
  return {
    component: { kind: "wall", index: 0 },
    color: [0.5, 0.5, 0.5],
    pts: [
      [uMin, 2.6],
      [uMax, 2.6],
      [uMax, 0],
      [uMin, 0],
    ],
  };
}

/** Bänder nach uLeft (linke Kante) aufsteigend, mit ihrer u-Breite. */
function bandsByU(polys: SectionCutPolygon[]): Array<{ uLeft: number; width: number }> {
  return polys
    .map((p) => {
      const us = p.pts.map((pt) => pt[0]);
      // Auf mm runden — glättet die Float-Akkumulation für stabile Vergleiche.
      const width = Math.round((Math.max(...us) - Math.min(...us)) * 1e6) / 1e6;
      return { uLeft: Math.min(...us), width };
    })
    .sort((a, b) => a.uLeft - b.uLeft);
}

// Schnitt A: horizontale Linie y=2 (x −1…6), quer durch W2 (x=5) und W4 (x=0).
const planeA = sectionPlaneFromLevel(
  sampleProject.drawingLevels.find((l) => l.id === "schnitt-a")!,
)!;

// „aw" = [render-ext(0.02) · insulation(0.16) · brick(0.15) · render-int(0.015)].
const aw = getWallType(sampleProject, wall("W2"));
const RENDER_EXT_T = 0.02; // Aussenputz — layers[0], die Aussenseite
const RENDER_INT_T = 0.015; // Innenputz — letzte Schicht, die Innenseite

describe("Schnitt-u-Weltachse", () => {
  it("entspricht der WASM-Konvention u = cross(normal, up) → Grundriss (−Nz, Nx)", () => {
    // Schnitt A: Ebenennormale world = (0,0,1) → uWorld model = (−1, 0).
    expect(planeA.normal[0]).toBeCloseTo(0, 9);
    expect(planeA.normal[1]).toBeCloseTo(0, 9);
    expect(planeA.normal[2]).toBeCloseTo(1, 9);
    const u = sectionUAxisModel(planeA);
    expect(u.x).toBeCloseTo(-1, 9);
    expect(u.y).toBeCloseTo(0, 9);
  });
});

describe("Wand-Aufbaurichtung vs. Schnitt-u-Achse", () => {
  const uWorld = sectionUAxisModel(planeA);

  it("W2 (Aussenseite +x) nicht gespiegelt, W4 (Aussenseite −x) gespiegelt", () => {
    // Beide Wände gehören zum CCW-Umriss; die linke Normale zeigt nach innen.
    // Gegenüberliegende Wände ⇒ genau eine der beiden wird gespiegelt.
    expect(wallLayersReversedInU(wall("W2"), uWorld)).toBe(false);
    expect(wallLayersReversedInU(wall("W4"), uWorld)).toBe(true);
  });

  it("degenerierte Wand (Länge 0) bleibt unverändert (kein Spiegeln)", () => {
    const dot: Wall = { ...wall("W2"), end: { ...wall("W2").start } };
    expect(wallLayersReversedInU(dot, uWorld)).toBe(false);
  });
});

describe("splitWallLayers: Aussenputz auf der Aussenseite, Wände spiegelverkehrt", () => {
  const uWorld = sectionUAxisModel(planeA);
  const cp = rect(0, 0.345); // volle Wanddicke, Skala 1:1

  it("W2: Aussenputz (layers[0]) an uMin, Innenputz an uMax", () => {
    const bands = bandsByU(splitWallLayers(cp, sampleProject, aw, wall("W2"), uWorld));
    expect(bands).toHaveLength(4);
    // uMin-Band = Aussenputz (Breite 0.02), uMax-Band = Innenputz (0.015).
    expect(bands[0].width).toBeCloseTo(RENDER_EXT_T, 6);
    expect(bands[3].width).toBeCloseTo(RENDER_INT_T, 6);
  });

  it("W4: gespiegelt — Aussenputz an uMax, Innenputz an uMin", () => {
    const bands = bandsByU(splitWallLayers(cp, sampleProject, aw, wall("W4"), uWorld));
    expect(bands).toHaveLength(4);
    expect(bands[0].width).toBeCloseTo(RENDER_INT_T, 6);
    expect(bands[3].width).toBeCloseTo(RENDER_EXT_T, 6);
  });

  it("propagiert sourceId (Quell-Element) auf ALLE Schicht-Bänder", () => {
    const cpWithId: SectionCutPolygon = { ...cp, sourceId: "W2" };
    const bands = splitWallLayers(cpWithId, sampleProject, aw, wall("W2"), uWorld);
    expect(bands.length).toBeGreaterThan(1);
    expect(bands.every((b) => b.sourceId === "W2")).toBe(true);
  });

  it("W2 und W4 liegen spiegelverkehrt (nicht identisch)", () => {
    const b2 = bandsByU(splitWallLayers(cp, sampleProject, aw, wall("W2"), uWorld));
    const b4 = bandsByU(splitWallLayers(cp, sampleProject, aw, wall("W4"), uWorld));
    // Reihenfolge der Bandbreiten von uMin→uMax ist exakt umgekehrt.
    const w2 = b2.map((b) => b.width);
    const w4 = b4.map((b) => b.width);
    expect(w2).not.toEqual(w4);
    expect(w2).toEqual([...w4].reverse());
  });
});
