/**
 * Unit-Tests für die Schnitt-Boolean-Dominanz (toSection): an Wand-Decken-
 * Übergängen schneidet die STÄRKERE Schicht (höhere `Component.joinPriority`)
 * die schwächere per achsparalleler Rechteck-Subtraktion weg. Gleiche Priorität
 * koexistiert (kein Schnitt).
 *
 * Getestet über den Rust-Kern (`plan_section.rs`):
 *  `subtractDominantBands` gegen den Nutzer-Testfall — ELEMENTÜBERGREIFEND:
 *     ein Decken-Beton-Band (100) schneidet ein überlappendes Wand-Putz-Band
 *     (10) weg; Beton bleibt voll; gleiche Priorität koexistiert.
 */

import { describe, it, expect } from "vitest";
import {
  subtractDominantBands,
  type Rect,
  type SectionCutPolygon,
} from "./toSection";

/** Rechteck-Kurzform. */
function r(uMin: number, uMax: number, vMin: number, vMax: number): Rect {
  return { uMin, uMax, vMin, vMax };
}

/** Ein achsparalleles Cut-Band mit joinPriority. */
function band(
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
  joinPriority: number,
  tag = "",
): SectionCutPolygon {
  return {
    component: { kind: "wall", index: 0 },
    color: [0.5, 0.5, 0.5],
    pts: [
      [uMin, vMax],
      [uMax, vMax],
      [uMax, vMin],
      [uMin, vMin],
    ],
    fill: tag || "#fff",
    joinPriority,
  };
}

/** Ein achsparalleles Cut-Band mit joinPriority UND Komponenten-Identität (für die MERGE-Regel). */
function cband(
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
  joinPriority: number,
  componentId: string,
  tag = "",
): SectionCutPolygon {
  return { ...band(uMin, uMax, vMin, vMax, joinPriority, tag), componentId };
}

/** Bounding-Box eines Bands als Rect. */
function boxOf(b: SectionCutPolygon): Rect {
  const us = b.pts.map((p) => p[0]);
  const vs = b.pts.map((p) => p[1]);
  return { uMin: Math.min(...us), uMax: Math.max(...us), vMin: Math.min(...vs), vMax: Math.max(...vs) };
}

/** Gesamtfläche einer Band-/Rect-Menge. */
function area(items: Array<Rect | SectionCutPolygon>): number {
  return items.reduce((s, it) => {
    const b = "pts" in it ? boxOf(it) : it;
    return s + (b.uMax - b.uMin) * (b.vMax - b.vMin);
  }, 0);
}

describe("subtractDominantBands: stärkere Schicht schneidet schwächere", () => {
  it("Nutzer-Testfall ELEMENTÜBERGREIFEND: Decken-Beton(100) schneidet Wand-Putz(10) weg", () => {
    // Wand-Putz-Band (Element B): schwach, joinPriority 10, u∈[0,2], v∈[0,3].
    const putz = band(0, 2, 0, 3, 10, "putz");
    // Decken-Beton-Band (Element A): stark, joinPriority 100, überlappt den
    // oberen Teil des Putzes: u∈[0,2], v∈[2,4].
    const beton = band(0, 2, 2, 4, 100, "beton");

    const out = subtractDominantBands([putz, beton]);
    // Beton bleibt voll erhalten (kein stärkeres Band).
    const betonOut = out.filter((b) => b.fill === "beton");
    expect(betonOut).toHaveLength(1);
    expect(boxOf(betonOut[0])).toEqual(boxOf(beton));

    // Putz ist im Überlappungsbereich v∈[2,3] weggeschnitten → Rest nur v∈[0,2].
    const putzOut = out.filter((b) => b.fill === "putz");
    expect(putzOut).toHaveLength(1);
    expect(boxOf(putzOut[0])).toEqual(r(0, 2, 0, 2));
    // In der Überlappungsregion existiert KEIN Putz mehr.
    expect(putzOut[0].pts.every((p) => p[1] <= 2 + 1e-9)).toBe(true);
  });

  it("gestaffelte Kette Beton100 > Backstein50 > Dämmung20 > Putz10", () => {
    // Alle vier Bänder überlappen in derselben Region u∈[0,1], gestapelt in v.
    // Jedes schwächere wird von JEDEM stärkeren geschnitten, wo sie überlappen.
    const beton = band(0, 1, 3, 4, 100, "beton");
    const backstein = band(0, 1, 2.5, 3.5, 50, "backstein"); // überlappt Beton in v∈[3,3.5]
    const daemmung = band(0, 1, 2, 3, 20, "daemmung"); // überlappt Backstein in v∈[2.5,3]
    const putz = band(0, 1, 0, 3.2, 10, "putz"); // überlappt alle darüber

    const out = subtractDominantBands([beton, backstein, daemmung, putz]);

    // Beton unangetastet.
    expect(area(out.filter((b) => b.fill === "beton"))).toBeCloseTo(1, 9);
    // Backstein: [2.5,3.5] minus Beton-Overlap [3,3.5] = [2.5,3] → Fläche 0.5.
    expect(area(out.filter((b) => b.fill === "backstein"))).toBeCloseTo(0.5, 9);
    // Dämmung: [2,3] minus Backstein-Overlap [2.5,3] = [2,2.5] → Fläche 0.5.
    // (Beton [3,4] überlappt Dämmung nicht.)
    expect(area(out.filter((b) => b.fill === "daemmung"))).toBeCloseTo(0.5, 9);
    // Putz: [0,3.2] minus Overlap mit ALLEN stärkeren.
    // Beton[3,4]→[3,3.2], Backstein[2.5,3.5]→[2.5,3.2], Dämmung[2,3]→[2,3] überdecken
    // zusammen v∈[2,3.2]; Rest = v∈[0,2] → Fläche 2.
    expect(area(out.filter((b) => b.fill === "putz"))).toBeCloseTo(2, 9);
  });

  it("gleiche Priorität koexistiert: Betonwand + Betondecke schneiden sich NICHT", () => {
    const betonWand = band(0, 1, 0, 3, 100, "wand");
    const betonDecke = band(0, 1, 2, 4, 100, "decke"); // überlappt in v∈[2,3]
    const out = subtractDominantBands([betonWand, betonDecke]);
    // Beide voll erhalten (durchgehende Betonfläche).
    expect(area(out.filter((b) => b.fill === "wand"))).toBeCloseTo(3, 9);
    expect(area(out.filter((b) => b.fill === "decke"))).toBeCloseTo(2, 9);
  });

  it("Band ohne joinPriority nimmt an keiner Subtraktion teil", () => {
    const stark = band(0, 2, 0, 2, 100, "stark");
    const ohne: SectionCutPolygon = { ...band(0, 2, 0, 2, 0, "ohne"), joinPriority: undefined };
    const out = subtractDominantBands([stark, ohne]);
    // Beide unverändert durchgereicht.
    expect(area(out.filter((b) => b.fill === "stark"))).toBeCloseTo(4, 9);
    expect(area(out.filter((b) => b.fill === "ohne"))).toBeCloseTo(4, 9);
  });

  it("vollständig überdecktes schwächeres Band verschwindet", () => {
    const stark = band(0, 3, 0, 3, 100, "stark");
    const schwach = band(1, 2, 1, 2, 10, "schwach"); // ganz im starken enthalten
    const out = subtractDominantBands([stark, schwach]);
    expect(out.filter((b) => b.fill === "schwach")).toHaveLength(0);
    expect(area(out.filter((b) => b.fill === "stark"))).toBeCloseTo(9, 9);
  });
});

describe("subtractDominantBands: MERGE-Regel (gleiche Komponente + Priorität)", () => {
  it("(a) zwei berührende Bänder gleicher Komponente+Priorität → EIN Körper, keine Innenkante", () => {
    // Beton-Wand (vertikal) trifft Beton-Decke (deren Schnittband hier u-deckungs-
    // gleich): gleiche componentId "beton", gleiche joinPriority, Überlappung v∈[2,3].
    const betonWand = cband(0, 1, 0, 3, 100, "beton", "wand");
    const betonDecke = cband(0, 1, 2, 4, 100, "beton", "decke"); // überlappt in v∈[2,3]
    const out = subtractDominantBands([betonWand, betonDecke]);
    // Zu EINEM Rechteck u∈[0,1], v∈[0,4] verschmolzen → keine innere Trennlinie.
    expect(out).toHaveLength(1);
    expect(boxOf(out[0])).toEqual(r(0, 1, 0, 4));
    expect(out[0].componentId).toBe("beton");
    expect(area(out)).toBeCloseTo(4, 9);
  });

  it("(a2) exakt bündig aneinander (Kantenberührung, kein Überlapp) → verschmilzt", () => {
    // Zwei Backstein-Kerne, die sich nur an v=3 berühren: die Innenkante muss weg.
    const unten = cband(0, 1, 0, 3, 100, "backstein", "u");
    const oben = cband(0, 1, 3, 5, 100, "backstein", "o");
    const out = subtractDominantBands([unten, oben]);
    expect(out).toHaveLength(1);
    expect(boxOf(out[0])).toEqual(r(0, 1, 0, 5));
  });

  it("(b) gleiche Priorität, VERSCHIEDENE Komponenten → bleiben getrennt (coexist)", () => {
    // Selbe Geometrie wie (a), aber unterschiedliche componentId → kein Merge.
    const wand = cband(0, 1, 0, 3, 100, "beton-wand", "wand");
    const decke = cband(0, 1, 2, 4, 100, "beton-decke", "decke");
    const out = subtractDominantBands([wand, decke]);
    expect(out).toHaveLength(2);
    expect(area(out.filter((b) => b.fill === "wand"))).toBeCloseTo(3, 9);
    expect(area(out.filter((b) => b.fill === "decke"))).toBeCloseTo(2, 9);
  });

  it("(c) Bänder ohne componentId verschmelzen nie (Dominanz-Tests bit-identisch)", () => {
    // Wie der bestehende Koexistenz-Test, ohne componentId → weiterhin 2 Bänder.
    const a = band(0, 1, 0, 3, 100, "a");
    const b = band(0, 1, 2, 4, 100, "b");
    const out = subtractDominantBands([a, b]);
    expect(out).toHaveLength(2);
    expect(area(out.filter((x) => x.fill === "a"))).toBeCloseTo(3, 9);
    expect(area(out.filter((x) => x.fill === "b"))).toBeCloseTo(2, 9);
  });

  it("Merge respektiert die Dominanz: stärkeres Fremd-Band schneidet erst, dann verschmelzen die Reste", () => {
    // Zwei gleichartige Putz-Bänder (Prio 10) u-deckungsgleich, dazwischen greift
    // KEIN stärkeres Band -> sie verschmelzen; ein separates starkes Beton-Band
    // (Prio 100) schneidet vorher ein Stück aus dem oberen Putz.
    const putzUnten = cband(0, 1, 0, 2, 10, "putz", "pu");
    const putzOben = cband(0, 1, 2, 4, 10, "putz", "po");
    const beton = cband(0, 1, 3, 5, 100, "beton", "beton"); // schneidet Putz-Oben v∈[3,4] weg
    const out = subtractDominantBands([putzUnten, putzOben, beton]);
    // Putz: unten[0,2] + oben-Rest[2,3] verschmelzen zu [0,3] → EIN Band, Fläche 3.
    const putz = out.filter((b) => b.componentId === "putz");
    expect(putz).toHaveLength(1);
    expect(boxOf(putz[0])).toEqual(r(0, 1, 0, 3));
    // Beton unangetastet.
    expect(area(out.filter((b) => b.componentId === "beton"))).toBeCloseTo(2, 9);
  });

  it("Teil-/Eck-Überlappung gleicher Komponente verschmilzt NICHT (Union wäre L-förmig)", () => {
    // Nicht achs-deckungsgleich, nur Eck-Überlapp → Bounding-Box würde leere
    // Fläche abdecken, darum bleiben beide getrennt.
    const a = cband(0, 2, 0, 2, 100, "x", "a");
    const b = cband(1, 3, 1, 3, 100, "x", "b");
    const out = subtractDominantBands([a, b]);
    expect(out).toHaveLength(2);
  });
});
