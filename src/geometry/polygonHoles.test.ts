/**
 * Unit-Tests für {@link mergeHoles} (Brücken-Trick: Aussparungen → EIN
 * einfacher Polygonring). Geprüft werden die drei Kern-Eigenschaften:
 *  • der Ergebnis-Ring ist selbstüberschneidungsfrei (echte Kanten-Kreuzungen
 *    ausgeschlossen, benachbarte Kanten teilen sich naturgemäss einen Punkt),
 *  • die Shoelace-Fläche entspricht Aussenfläche − Lochfläche(n),
 *  • `bridgeEdges` benennt genau die künstlichen Brückenkanten (2 je Loch).
 */
import { describe, it, expect } from "vitest";
import type { Vec2 } from "../model/types";
import { mergeHoles } from "./polygonHoles";

function signedArea(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Ob sich zwei Strecken ECHT (im Inneren beider) schneiden — Test-Kopie der
 * Produktionslogik (bewusst unabhängig, damit der Test die Implementierung
 * nicht einfach "durchreicht"). */
function properlyCross(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const dax = a2.x - a1.x, day = a2.y - a1.y;
  const dbx = b2.x - b1.x, dby = b2.y - b1.y;
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-12) return false;
  const ex = b1.x - a1.x, ey = b1.y - a1.y;
  const t = (ex * dby - ey * dbx) / denom;
  const s = (ex * day - ey * dax) / denom;
  const eps = 1e-9;
  return t > eps && t < 1 - eps && s > eps && s < 1 - eps;
}

/** Prüft, dass KEIN Paar nicht-benachbarter Kanten sich echt schneidet. */
function isSimpleRing(ring: Vec2[]): boolean {
  const n = ring.length;
  const edges: [Vec2, Vec2][] = [];
  for (let i = 0; i < n; i++) edges.push([ring[i], ring[(i + 1) % n]]);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Benachbarte Kanten (teilen einen Endpunkt) sind erlaubt.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (properlyCross(edges[i][0], edges[i][1], edges[j][0], edges[j][1])) return false;
    }
  }
  return true;
}

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

describe("mergeHoles", () => {
  it("Rechteck 6x4 mit 1x1-Loch mittig -> einfacher Ring, Fläche = Aussen - Loch, 2 Brückenkanten", () => {
    const outline = rect(0, 0, 6, 4); // Fläche 24
    const hole = rect(2.5, 1.5, 3.5, 2.5); // Fläche 1
    const { ring, bridgeEdges } = mergeHoles(outline, [hole]);

    expect(ring.length).toBe(outline.length + hole.length + 2);
    expect(isSimpleRing(ring)).toBe(true);
    expect(Math.abs(signedArea(ring))).toBeCloseTo(24 - 1, 2);
    expect(bridgeEdges.length).toBe(2);

    // Die Brückenkanten sind kurz (Aussenring↔Loch-Rand), nicht Teil des
    // eigentlichen Loch- oder Aussenumrisses.
    for (const e of bridgeEdges) {
      const a = ring[e];
      const b = ring[(e + 1) % ring.length];
      const len = Math.hypot(a.x - b.x, a.y - b.y);
      expect(len).toBeGreaterThan(0);
      expect(len).toBeLessThan(3); // deutlich kürzer als Aussen-/Lochkanten (>=1)
    }
  });

  it("ohne Löcher -> Ring identisch zur Outline, keine Brückenkanten (Regression)", () => {
    const outline = rect(0, 0, 6, 4);
    const { ring, bridgeEdges } = mergeHoles(outline, []);
    expect(ring).toEqual(outline);
    expect(bridgeEdges).toEqual([]);
  });

  it("Loch ausserhalb der Outline wird übersprungen", () => {
    const outline = rect(0, 0, 6, 4);
    const outsideHole = rect(10, 10, 11, 11);
    const { ring, bridgeEdges } = mergeHoles(outline, [outsideHole]);
    expect(ring).toEqual(outline);
    expect(bridgeEdges).toEqual([]);
  });

  it("degeneriertes Loch (< 3 Punkte) wird übersprungen", () => {
    const outline = rect(0, 0, 6, 4);
    const { ring, bridgeEdges } = mergeHoles(outline, [[{ x: 1, y: 1 }, { x: 2, y: 2 }]]);
    expect(ring).toEqual(outline);
    expect(bridgeEdges).toEqual([]);
  });

  it("zwei Löcher -> beide eingefügt, Ring einfach, Fläche = Aussen - Loch1 - Loch2, 4 Brückenkanten", () => {
    const outline = rect(0, 0, 10, 4);
    const holeA = rect(1, 1, 2, 2); // Fläche 1
    const holeB = rect(7, 1, 9, 3); // Fläche 4
    const { ring, bridgeEdges } = mergeHoles(outline, [holeA, holeB]);
    expect(isSimpleRing(ring)).toBe(true);
    expect(Math.abs(signedArea(ring))).toBeCloseTo(40 - 1 - 4, 2);
    expect(bridgeEdges.length).toBe(4);
  });

  it("Loch mit CCW-Orientierung (gleich wie Aussenring) wird korrekt gegenläufig eingefügt", () => {
    // rect() liefert CCW; die Fläche muss trotzdem korrekt subtrahiert werden,
    // unabhängig von der gespeicherten Loch-Wicklung.
    const outline = rect(0, 0, 6, 4);
    const hole = rect(2.5, 1.5, 3.5, 2.5).reverse(); // CW
    const { ring } = mergeHoles(outline, [hole]);
    expect(Math.abs(signedArea(ring))).toBeCloseTo(24 - 1, 2);
  });
});
