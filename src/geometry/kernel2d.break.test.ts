/**
 * `nearestOnPolyline`/`breakCurve` — Grundlage des BREAK-Befehls (entfernt
 * den Abschnitt ZWISCHEN zwei Positionen auf einer offenen Punktfolge).
 */
import { describe, it, expect } from "vitest";
import { breakCurve, nearestOnPolyline } from "./kernel2d";
import type { Vec2 } from "../model/types";

describe("nearestOnPolyline", () => {
  it("findet die nächste Position auf einer geraden Linie", () => {
    const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const hit = nearestOnPolyline(pts, false, { x: 3, y: 1 });
    expect(hit).not.toBeNull();
    expect(hit!.edgeIndex).toBe(0);
    expect(hit!.t).toBeCloseTo(0.3, 6);
  });

  it("wählt die richtige Kante bei mehreren Segmenten", () => {
    const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }];
    const hit = nearestOnPolyline(pts, false, { x: 5, y: 3 });
    expect(hit).not.toBeNull();
    expect(hit!.edgeIndex).toBe(1);
    expect(hit!.t).toBeCloseTo(0.6, 6);
  });

  it("klemmt t auf [0,1] (Klick jenseits eines Endpunkts)", () => {
    const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const hit = nearestOnPolyline(pts, false, { x: 20, y: 0 });
    expect(hit!.t).toBe(1);
  });

  it("liefert null bei < 2 Punkten", () => {
    expect(nearestOnPolyline([{ x: 0, y: 0 }], false, { x: 0, y: 0 })).toBeNull();
  });
});

describe("breakCurve", () => {
  const line: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];

  it("entfernt den Abschnitt zwischen zwei Punkten auf einer geraden Linie", () => {
    const hit1 = nearestOnPolyline(line, false, { x: 3, y: 0 })!;
    const hit2 = nearestOnPolyline(line, false, { x: 7, y: 0 })!;
    const pieces = breakCurve(line, hit1, hit2);
    expect(pieces.length).toBe(2);
    expect(pieces[0]).toEqual([{ x: 0, y: 0 }, { x: 3, y: 0 }]);
    expect(pieces[1]).toEqual([{ x: 7, y: 0 }, { x: 10, y: 0 }]);
  });

  it("Klick-Reihenfolge ist irrelevant (Positionen werden intern sortiert)", () => {
    const hit1 = nearestOnPolyline(line, false, { x: 7, y: 0 })!; // zuerst der SPÄTERE Punkt geklickt
    const hit2 = nearestOnPolyline(line, false, { x: 3, y: 0 })!;
    const pieces = breakCurve(line, hit1, hit2);
    expect(pieces[0]).toEqual([{ x: 0, y: 0 }, { x: 3, y: 0 }]);
    expect(pieces[1]).toEqual([{ x: 7, y: 0 }, { x: 10, y: 0 }]);
  });

  it("Bruch nahe einem Endpunkt liefert nur EIN Reststück (das andere fällt zu kurz aus)", () => {
    const hit1 = nearestOnPolyline(line, false, { x: 0, y: 0 })!;
    const hit2 = nearestOnPolyline(line, false, { x: 6, y: 0 })!;
    const pieces = breakCurve(line, hit1, hit2);
    expect(pieces.length).toBe(1);
    expect(pieces[0]).toEqual([{ x: 6, y: 0 }, { x: 10, y: 0 }]);
  });

  it("funktioniert über mehrere Segmente einer offenen Polylinie hinweg", () => {
    const poly: Vec2[] = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 5 }];
    const hit1 = nearestOnPolyline(poly, false, { x: 2, y: 0 })!; // auf Segment 0
    const hit2 = nearestOnPolyline(poly, false, { x: 8, y: 5 })!; // auf Segment 2
    const pieces = breakCurve(poly, hit1, hit2);
    expect(pieces.length).toBe(2);
    expect(pieces[0]).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }]);
    expect(pieces[1]).toEqual([{ x: 8, y: 5 }, { x: 10, y: 5 }]);
  });

  it("beide Punkte auf derselben Kante trennen sauber, ohne die übrigen Punkte zu verlieren", () => {
    const poly: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const hit1 = nearestOnPolyline(poly, false, { x: 4, y: 0 })!;
    const hit2 = nearestOnPolyline(poly, false, { x: 6, y: 0 })!;
    const pieces = breakCurve(poly, hit1, hit2);
    expect(pieces.length).toBe(2);
    expect(pieces[0]).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
    expect(pieces[1]).toEqual([{ x: 6, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });
});
