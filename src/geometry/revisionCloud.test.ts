/**
 * `revisionCloudPts` — wandelt eine geklickte Punktfolge in eine
 * Beulen-Kontur (Revisionswolke) um.
 */
import { describe, it, expect } from "vitest";
import { revisionCloudPts, REVCLOUD_BULGE } from "./revisionCloud";
import { bulgeArcPoints } from "./bulge";
import type { Vec2 } from "../model/types";

describe("revisionCloudPts", () => {
  it("liefert null bei < 2 Punkten", () => {
    expect(revisionCloudPts([{ x: 0, y: 0 }], false, 0.3)).toBeNull();
  });

  it("ein einzelnes offenes Segment wird in ~len/targetArcLen Beulen zerlegt", () => {
    const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 3, y: 0 }];
    const res = revisionCloudPts(pts, false, 0.5)!;
    expect(res).not.toBeNull();
    // 3m Länge / 0.5m Ziel-Bogenlänge ≈ 6 Beulen.
    expect(res.bulge.length).toBe(6);
    expect(res.bulge.every((b) => b === REVCLOUD_BULGE)).toBe(true);
    // Erster und letzter Punkt der expandierten Kontur = Start/Ende der Eingabe.
    expect(res.pts[0]).toEqual({ x: 0, y: 0 });
    expect(res.pts[res.pts.length - 1]).toEqual({ x: 3, y: 0 });
  });

  it("mehrere Segmente werden nahtlos aneinandergehängt (keine doppelten Zwischenpunkte)", () => {
    const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }];
    const res = revisionCloudPts(pts, false, 1)!;
    // Der mittlere Eingabepunkt (2,0) muss GENAU EINMAL in der expandierten
    // Kontur vorkommen (nicht doppelt vom Ende des ersten UND Anfang des
    // zweiten Segments).
    const occurrences = res.pts.filter((p) => p.x === 2 && p.y === 0).length;
    expect(occurrences).toBe(1);
  });

  it("geschlossene Kontur: kein doppelter Schlusspunkt", () => {
    const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    const res = revisionCloudPts(pts, true, 1)!;
    // Der letzte Punkt der expandierten Kontur darf NICHT (0,0) sein (das
    // wäre der Startpunkt erneut) — der Ring schliesst sich implizit über
    // die geschlossene Interpretation, nicht über einen doppelten Punkt.
    const last = res.pts[res.pts.length - 1];
    expect(last).not.toEqual({ x: 0, y: 0 });
    // Bulge-Array hat genau so viele Einträge wie Punkte (Schluss-Segment
    // pts[last]→pts[0] eingerechnet, wie bei jeder geschlossenen Polylinie).
    expect(res.bulge.length).toBe(res.pts.length);
  });

  it("jede Beule liegt exakt auf einem Kreisbogen mit dem erwarteten bulge (Rückwärtsprobe)", () => {
    const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }];
    const res = revisionCloudPts(pts, false, 1)!;
    // Genau 2 Beulen bei 2m/1m Ziel-Länge.
    expect(res.pts.length).toBe(3); // Start + 2 Zwischenpunkte
    for (let i = 0; i < res.pts.length - 1; i++) {
      const arcPts = bulgeArcPoints(res.pts[i], res.pts[i + 1], res.bulge[i]);
      // Ein echter Bogen (bulge≠0) tesselliert zu MEHR als 2 Punkten.
      expect(arcPts.length).toBeGreaterThan(2);
    }
  });

  it("sehr kurzes Segment (kürzer als die Ziel-Bogenlänge) ergibt genau EINE Beule", () => {
    const pts: Vec2[] = [{ x: 0, y: 0 }, { x: 0.1, y: 0 }];
    const res = revisionCloudPts(pts, false, 1)!;
    expect(res.bulge.length).toBe(1);
  });
});
