/**
 * Unit-Tests für die GPU-Tessellierung: Ear-Clipping (konvex + konkav) und
 * Bildschirm-Raum-Abbildung.
 */

import { describe, it, expect } from 'vitest';
import { triangulate } from './glPlanCompile';
import { computeOrthoMatrix } from './glPlanRender';
import type { Vec2 } from '../../model/types';

/** Summierte Dreiecksfläche (Betrag) aus Indizes über pts. */
function triArea(pts: Vec2[], idx: number[]): number {
  let area = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = pts[idx[i]];
    const b = pts[idx[i + 1]];
    const c = pts[idx[i + 2]];
    area += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }
  return area;
}

/** Polygon-Fläche (Shoelace, Betrag). */
function polyArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return Math.abs(a) / 2;
}

describe('triangulate', () => {
  it('trianguliert ein Quadrat (2 Dreiecke, volle Fläche)', () => {
    const sq: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    const idx = triangulate(sq);
    expect(idx.length).toBe(6); // 2 Dreiecke
    expect(triArea(sq, idx)).toBeCloseTo(polyArea(sq), 6);
  });

  it('trianguliert ein KONKAVES L-Polygon flächentreu (Fan wäre falsch)', () => {
    // L-Form: konkave Ecke bei (2,2).
    const L: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 4 },
      { x: 0, y: 4 },
    ];
    const idx = triangulate(L);
    // 6 Ecken → 4 Dreiecke.
    expect(idx.length).toBe(12);
    // Flächentreu: Summe der Dreiecke == Polygonfläche (12). Ein Fan über die
    // konkave Ecke würde deutlich mehr Fläche (außerhalb des L) erzeugen.
    expect(triArea(L, idx)).toBeCloseTo(polyArea(L), 6);
    expect(triArea(L, idx)).toBeCloseTo(12, 6);
  });

  it('liefert [] bei <3 Ecken', () => {
    expect(triangulate([])).toEqual([]);
    expect(triangulate([{ x: 0, y: 0 }])).toEqual([]);
    expect(triangulate([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual([]);
  });

  it('behandelt beide Wicklungsrichtungen (CW + CCW) gleich', () => {
    const cw: Vec2[] = [
      { x: 0, y: 0 },
      { x: 0, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 0 },
    ];
    const idx = triangulate(cw);
    expect(idx.length).toBe(6);
    expect(triArea(cw, idx)).toBeCloseTo(polyArea(cw), 6);
  });
});

describe('computeOrthoMatrix', () => {
  it('liefert eine 4×4-Matrix', () => {
    const m = computeOrthoMatrix({ x: 0, y: 0, w: 100, h: 100 }, 100, 100);
    expect(m).toBeInstanceOf(Float32Array);
    expect(m.length).toBe(16);
  });

  it('bildet die viewBox-Ecken bei passendem Aspekt auf Clip [-1,1] ab', () => {
    // Quadratischer viewBox + quadratisches Canvas → keine Aspekt-Dehnung.
    const m = computeOrthoMatrix({ x: 0, y: 0, w: 100, h: 100 }, 100, 100);
    // Bildschirm-Punkt (0,0) = obere-linke Ecke → Clip (-1, +1).
    const clip = (x: number, y: number) => ({
      x: m[0] * x + m[4] * y + m[12],
      y: m[1] * x + m[5] * y + m[13],
    });
    const tl = clip(0, 0);
    expect(tl.x).toBeCloseTo(-1, 5);
    expect(tl.y).toBeCloseTo(1, 5);
    const br = clip(100, 100);
    expect(br.x).toBeCloseTo(1, 5);
    expect(br.y).toBeCloseTo(-1, 5);
  });

  it('verschiedene viewBoxes → verschiedene Matrizen', () => {
    const a = computeOrthoMatrix({ x: 0, y: 0, w: 100, h: 100 }, 100, 100);
    const b = computeOrthoMatrix({ x: 50, y: 50, w: 200, h: 200 }, 100, 100);
    expect([...a].every((v, i) => v === b[i])).toBe(false);
  });
});
