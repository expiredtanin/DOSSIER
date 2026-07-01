/**
 * Unit-Tests für die Schraffur-Tessellierung: Linie↔Polygon-Clipping (konvex +
 * konkav + Linie außerhalb), Segment-Clipping, Muster-Aufbau (diagonal/cross/
 * insulation/solid/none) und die geometrische Dash-Auflösung.
 */

import { describe, it, expect } from 'vitest';
import {
  applyDash,
  buildHatchSegments,
  clipLineToPolygon,
  clipSegmentToPolygon,
  hatchLineFamily,
  type HatchSegment,
} from './glPlanHatch';
import type { Vec2 } from '../../model/types';
import type { HatchRender } from '../generatePlan';

/** Gesamt-Länge einer Segment-Schar. */
function totalLen(segs: HatchSegment[]): number {
  let l = 0;
  for (const s of segs) l += Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  return l;
}

/** Basis-Hatch mit Überschreibungen. */
function hatch(over: Partial<HatchRender>): HatchRender {
  return { pattern: 'diagonal', scale: 1, angle: 0, color: '#000', lineWeight: 0.13, dash: null, ...over };
}

// Einheits-Richtungen.
const RIGHT: Vec2 = { x: 1, y: 0 };

describe('clipLineToPolygon', () => {
  it('konvex: horizontale Linie durch die Mitte eines Quadrats → volle Breite', () => {
    const sq: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    const segs = clipLineToPolygon({ x: -1, y: 2 }, RIGHT, sq);
    expect(segs.length).toBe(1);
    // Innen-Intervall von x=0 bis x=4.
    const s = segs[0];
    expect(Math.min(s.a.x, s.b.x)).toBeCloseTo(0, 9);
    expect(Math.max(s.a.x, s.b.x)).toBeCloseTo(4, 9);
    expect(totalLen(segs)).toBeCloseTo(4, 9);
  });

  it('KONKAV: horizontale Linie durch beide Arme einer C-Form → ZWEI Segmente', () => {
    // C-/U-Form mit Kerbe: eine horizontale Linie auf mittlerer Höhe quert vier
    // Kanten → zwei getrennte Innen-Intervalle.
    //   (0,0)-(6,0)-(6,6)-(4,6)-(4,2)-(2,2)-(2,6)-(0,6)
    const c: Vec2[] = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 6 },
      { x: 4, y: 6 },
      { x: 4, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 6 },
      { x: 0, y: 6 },
    ];
    // Höhe y=4 liegt in den beiden Armen (x∈[0,2] und x∈[4,6]), nicht in der Kerbe.
    const segs = clipLineToPolygon({ x: -1, y: 4 }, RIGHT, c);
    expect(segs.length).toBe(2);
    const xs = segs
      .map((s) => [Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x)])
      .sort((p, q) => p[0] - q[0]);
    expect(xs[0][0]).toBeCloseTo(0, 9);
    expect(xs[0][1]).toBeCloseTo(2, 9);
    expect(xs[1][0]).toBeCloseTo(4, 9);
    expect(xs[1][1]).toBeCloseTo(6, 9);
    // Unterhalb der Kerbe (y=1) ist die Form durchgehend → EIN Segment [0,6].
    const low = clipLineToPolygon({ x: -1, y: 1 }, RIGHT, c);
    expect(low.length).toBe(1);
    expect(totalLen(low)).toBeCloseTo(6, 9);
  });

  it('Linie AUSSERHALB des Polygons → leer', () => {
    const sq: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    expect(clipLineToPolygon({ x: -1, y: 10 }, RIGHT, sq)).toEqual([]);
    expect(clipLineToPolygon({ x: -1, y: -5 }, RIGHT, sq)).toEqual([]);
  });

  it('degeneriert (<3 Ecken) → leer', () => {
    expect(clipLineToPolygon({ x: 0, y: 0 }, RIGHT, [])).toEqual([]);
    expect(clipLineToPolygon({ x: 0, y: 0 }, RIGHT, [{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual([]);
  });

  it('robuste Eckdurchquerung: Linie genau durch einen Eckpunkt zählt EINMAL', () => {
    // Diagonale Linie durch die Ecke (0,0) eines Rauten-Polygons; die halb-offene
    // Kanten-Konvention darf keinen Doppel-/Nullschnitt erzeugen.
    const diamond: Vec2[] = [
      { x: 0, y: -2 },
      { x: 2, y: 0 },
      { x: 0, y: 2 },
      { x: -2, y: 0 },
    ];
    // Horizontale Linie exakt durch die beiden Seitenecken (y=0): ein Segment.
    const segs = clipLineToPolygon({ x: -5, y: 0 }, RIGHT, diamond);
    expect(segs.length).toBe(1);
    expect(totalLen(segs)).toBeCloseTo(4, 9);
  });
});

describe('clipSegmentToPolygon', () => {
  const sq: Vec2[] = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];

  it('klemmt ein überstehendes Segment auf die Polygon-Grenzen', () => {
    const segs = clipSegmentToPolygon({ x: -3, y: 2 }, { x: 7, y: 2 }, sq);
    expect(segs.length).toBe(1);
    expect(Math.min(segs[0].a.x, segs[0].b.x)).toBeCloseTo(0, 9);
    expect(Math.max(segs[0].a.x, segs[0].b.x)).toBeCloseTo(4, 9);
  });

  it('ein komplett außenliegendes Segment → leer', () => {
    expect(clipSegmentToPolygon({ x: 5, y: 2 }, { x: 9, y: 2 }, sq)).toEqual([]);
  });

  it('behält nur den innenliegenden Teil eines halb überstehenden Segments', () => {
    const segs = clipSegmentToPolygon({ x: 2, y: 2 }, { x: 9, y: 2 }, sq);
    expect(segs.length).toBe(1);
    expect(totalLen(segs)).toBeCloseTo(2, 9); // von x=2 bis x=4
  });
});

describe('hatchLineFamily', () => {
  const sq: Vec2[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('deckt das Polygon mit parallelen Linien im gegebenen Abstand ab', () => {
    // Horizontale Scharen (Richtung entlang x), Abstand 2 m → ~5–6 Linien à 10 m.
    const segs = hatchLineFamily(sq, 0, 2, 0);
    expect(segs.length).toBeGreaterThanOrEqual(4);
    // Jede Linie überspannt die volle Breite (10 m) innerhalb des Quadrats.
    for (const s of segs) expect(Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)).toBeCloseTo(10, 6);
  });

  it('Abstand ≤ 0 oder <3 Ecken → leer', () => {
    expect(hatchLineFamily(sq, 0, 0, 0)).toEqual([]);
    expect(hatchLineFamily([{ x: 0, y: 0 }], 0, 1, 0)).toEqual([]);
  });
});

describe('buildHatchSegments', () => {
  const sq: Vec2[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];

  it('solid/none erzeugen KEINE Musterlinien (Füllung/Umriss übernimmt der Aufrufer)', () => {
    expect(buildHatchSegments(sq, hatch({ pattern: 'none' }))).toEqual([]);
    expect(buildHatchSegments(sq, hatch({ pattern: 'solid' }))).toEqual([]);
  });

  it('diagonal erzeugt eine einzelne Schar; crosshatch mehr (zwei Scharen)', () => {
    const diag = buildHatchSegments(sq, hatch({ pattern: 'diagonal' }));
    const cross = buildHatchSegments(sq, hatch({ pattern: 'crosshatch' }));
    expect(diag.length).toBeGreaterThan(0);
    // Zwei Scharen → mindestens so viele Segmente wie eine Schar, praktisch mehr.
    expect(cross.length).toBeGreaterThan(diag.length);
    // Alle Segmente liegen im Einheitsquadrat (Clipping wirkt).
    for (const s of cross) {
      for (const p of [s.a, s.b]) {
        expect(p.x).toBeGreaterThanOrEqual(-1e-6);
        expect(p.x).toBeLessThanOrEqual(1 + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(-1e-6);
        expect(p.y).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  });

  it('insulation erzeugt tessellierte Wellen-Segmente innerhalb des Polygons', () => {
    const segs = buildHatchSegments(sq, hatch({ pattern: 'insulation' }));
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      for (const p of [s.a, s.b]) {
        expect(p.x).toBeGreaterThanOrEqual(-1e-6);
        expect(p.x).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  });

  it('größerer scale → weniger Musterlinien (weitere Teilung)', () => {
    const fine = buildHatchSegments(sq, hatch({ pattern: 'diagonal', scale: 1 }));
    const coarse = buildHatchSegments(sq, hatch({ pattern: 'diagonal', scale: 4 }));
    expect(coarse.length).toBeLessThan(fine.length);
  });

  it('scale ≤ 0 wird auf 1 geklemmt (keine leere/entartete Kachel)', () => {
    const segs = buildHatchSegments(sq, hatch({ pattern: 'diagonal', scale: 0 }));
    expect(segs.length).toBeGreaterThan(0);
  });
});

describe('applyDash', () => {
  it('ohne Muster (null/leer) bleiben Segmente unverändert', () => {
    const segs: HatchSegment[] = [{ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }];
    expect(applyDash(segs, null)).toBe(segs);
    expect(applyDash(segs, [])).toBe(segs);
  });

  it('zerlegt ein Segment in Strich/Lücke (Summe der Striche < Gesamtlänge)', () => {
    const segs: HatchSegment[] = [{ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }];
    const dashed = applyDash(segs, [0.13, 0.13]); // gleich lang an/aus
    expect(dashed.length).toBeGreaterThan(1);
    // Nur die „an"-Stücke bleiben → Gesamtlänge kleiner als das Original (10).
    expect(totalLen(dashed)).toBeGreaterThan(0);
    expect(totalLen(dashed)).toBeLessThan(totalLen(segs));
  });
});
