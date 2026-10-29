/**
 * Unit-Tests für `stairOutline` (Plan-Aussenlinie).
 *
 * Prüft:
 *  • Gerade Treppe → 4-Punkte-Rechteck (polygon, keine spiral).
 *  • L-Treppe → 6-Punkte-L-Polygon via Linien-Schnittpunkten.
 *  • Wendeltreppe → SpiralOutlineSegments (2 Bögen, 2 radiale Linien, kein polygon).
 *
 * Die genauen Koordinaten-Werte werden nur grob geprüft (Vorzeichen, Länge,
 * Schliessen); die Geometrie-Logik wird via Abstand-Invarianten verifiziert.
 */

import { describe, it, expect } from "vitest";
import { stairOutline } from "./stair";
import type { Stair, Vec2 } from "../model/types";

/** Einfache Distanz-Funktion. */
const dist = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);

/** Minimale gerade Treppe nach rechts (+X). */
const geradeStair: Stair = {
  id: "g1",
  type: "stair",
  floorId: "eg",
  categoryCode: "40",
  shape: "straight",
  start: { x: 0, y: 0 },
  dir: { x: 1, y: 0 },
  runLength: 3.0,
  width: 1.2,
  stepCount: 16,
};

/** L-Treppe: erster Lauf +X, zweiter Lauf +Y (turn = +1). */
const lStair: Stair = {
  id: "l1",
  type: "stair",
  floorId: "eg",
  categoryCode: "40",
  shape: "L",
  start: { x: 0, y: 0 },
  dir: { x: 1, y: 0 },
  runLength: 2.0,
  run2Length: 2.0,
  turn: 1,
  width: 1.2,
  stepCount: 14,
};

/** Wendeltreppe: 270° im Gegenuhrzeigersinn, Radius 1.5 m. */
const wendelStair: Stair = {
  id: "w1",
  type: "stair",
  floorId: "eg",
  categoryCode: "40",
  shape: "spiral",
  start: { x: 1.5, y: 0 },
  dir: { x: 1, y: 0 },
  runLength: 3.0, // bei Wendel: Pflichtfeld, inhaltlich nicht genutzt
  center: { x: 0, y: 0 },
  radius: 1.5,
  sweep: 270,
  width: 1.2,
  stepCount: 12,
};

describe("stairOutline — gerade Treppe", () => {
  const totalRise = 3.0;
  const result = stairOutline(geradeStair, totalRise);

  it("liefert polygon, keine spiral", () => {
    expect(result.polygon).not.toBeNull();
    expect(result.spiral).toBeNull();
  });

  it("polygon hat genau 4 Ecken", () => {
    expect(result.polygon!.length).toBe(4);
  });

  it("Lauflaenge entspricht runLength", () => {
    // Start-Kante (x=0) vs End-Kante (x=3): Abstand der gleichseitigen Kanten = 3.0 m.
    const pts = result.polygon!;
    // pts[0] und pts[1] liegen bei x≈0, pts[2] und pts[3] bei x≈runLength.
    const startX = (pts[0].x + pts[1].x) / 2;
    const endX   = (pts[2].x + pts[3].x) / 2;
    expect(Math.abs(endX - startX)).toBeCloseTo(geradeStair.runLength, 5);
  });

  it("Breite entspricht stair.width", () => {
    const pts = result.polygon!;
    // Seitenkante 0→3 und 1→2 haben die Breite = stair.width.
    const w = dist(pts[0], pts[1]);
    expect(w).toBeCloseTo(geradeStair.width, 5);
  });
});

describe("stairOutline — L-Treppe", () => {
  const totalRise = 3.0;
  const result = stairOutline(lStair, totalRise);

  it("liefert polygon, keine spiral", () => {
    expect(result.polygon).not.toBeNull();
    expect(result.spiral).toBeNull();
  });

  it("polygon hat 6 Ecken (L-Form)", () => {
    // 4 Aussen-Eck + 2 Innen-Eck via Linien-Schnittpunkten = 6 Punkte.
    expect(result.polygon!.length).toBe(6);
  });

  it("keine NaN-Koordinaten", () => {
    for (const p of result.polygon!) {
      expect(isFinite(p.x)).toBe(true);
      expect(isFinite(p.y)).toBe(true);
    }
  });
});

describe("stairOutline — Wendeltreppe", () => {
  const totalRise = 3.0;
  const result = stairOutline(wendelStair, totalRise);

  it("liefert spiral, kein polygon", () => {
    expect(result.spiral).not.toBeNull();
    expect(result.polygon).toBeNull();
  });

  it("zwei radiale Schliesslinien (Start + Ende)", () => {
    expect(result.spiral!.lines.length).toBe(2);
  });

  it("zwei Kreisboegen (Innen + Aussen)", () => {
    expect(result.spiral!.arcs.length).toBe(2);
  });

  it("Innenradius < Aussenradius", () => {
    const [arcIn, arcOut] = result.spiral!.arcs;
    expect(arcIn.r).toBeLessThan(arcOut.r);
  });

  it("Startlinie Innen-Punkt liegt auf Innenkreis", () => {
    const arcIn = result.spiral!.arcs[0];
    const [lineStart] = result.spiral!.lines;
    const [innerPt] = lineStart;
    const d = dist({ x: arcIn.cx, y: arcIn.cy }, innerPt);
    expect(d).toBeCloseTo(arcIn.r, 4);
  });
});

describe("stairOutline — Referenz links/mitte/rechts (Item 4)", () => {
  const totalRise = 3.0;
  // Gerade Treppe entlang +X, Breite 1.2 m. Perp (linke Normale) = (0, +1).
  const base: Stair = { ...geradeStair, referenz: "mitte" };
  const mitte = stairOutline(base, totalRise).polygon!;
  const links = stairOutline({ ...base, referenz: "links" }, totalRise).polygon!;
  const rechts = stairOutline({ ...base, referenz: "rechts" }, totalRise).polygon!;

  /** Mittlere Y-Höhe eines Rechteck-Polygons. */
  const midY = (pts: Vec2[]) => pts.reduce((s, p) => s + p.y, 0) / pts.length;

  it("Breite bleibt bei allen Referenzen gleich", () => {
    for (const poly of [mitte, links, rechts]) {
      expect(dist(poly[0], poly[1])).toBeCloseTo(geradeStair.width, 5);
    }
  });

  it("referenz=links: Treppe liegt RECHTS der Achse (−n) → Mitte um width/2 nach −Y", () => {
    // Achse (start/dir) = linke Kante; die Fläche versetzt sich in −n = (0,−1).
    expect(midY(links) - midY(mitte)).toBeCloseTo(-geradeStair.width / 2, 5);
  });

  it("referenz=rechts: Treppe liegt LINKS der Achse (+n) → Mitte um width/2 nach +Y", () => {
    expect(midY(rechts) - midY(mitte)).toBeCloseTo(+geradeStair.width / 2, 5);
  });

  it("bei referenz=links liegt die Achse (y=0) auf der linken Kante der Treppe", () => {
    // Linke Kante = max-Y-Kante der Fläche (n = +Y). Sie soll bei y=0 liegen.
    const maxY = Math.max(...links.map((p) => p.y));
    expect(maxY).toBeCloseTo(0, 5);
  });

  it("mitte entspricht dem Default (kein referenz-Feld gesetzt)", () => {
    const noRef = stairOutline({ ...geradeStair }, totalRise).polygon!;
    for (let i = 0; i < noRef.length; i++) {
      expect(noRef[i].x).toBeCloseTo(mitte[i].x, 6);
      expect(noRef[i].y).toBeCloseTo(mitte[i].y, 6);
    }
  });
});
