// Tests für `tangentCircleCenters` (Tangente-Tangente-Radius-Konstruktion),
// getrennt von `kernel2d.parity.test.ts` (dort werden nur die bereits vor
// dieser Session bestehenden Funktionen gegen die DXF-Referenzimplementierung
// geprüft).

import { describe, it, expect } from "vitest";
import { tangentCircleCenters, type TangentTarget } from "./kernel2d";
import type { Vec2 } from "../model/types";

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Prüft, dass `center` mit Radius `r` tangential (Abstand == r) an `t` liegt. */
function isTangent(center: Vec2, r: number, t: TangentTarget): boolean {
  if (t.kind === "line") {
    const dx = t.b.x - t.a.x, dy = t.b.y - t.a.y;
    const len = Math.hypot(dx, dy);
    const cross = ((center.x - t.a.x) * dy - (center.y - t.a.y) * dx) / len;
    return Math.abs(Math.abs(cross) - r) < 1e-6;
  }
  const d = dist(center, t.center);
  // Äussere ODER innere Berührung.
  return Math.abs(d - (t.r + r)) < 1e-6 || Math.abs(d - Math.abs(t.r - r)) < 1e-6;
}

describe("tangentCircleCenters — zwei Geraden", () => {
  it("zwei senkrechte Geraden, Radius 2 → vier Kandidaten (je ein Quadrant)", () => {
    const l1: TangentTarget = { kind: "line", a: { x: -10, y: 0 }, b: { x: 10, y: 0 } }; // X-Achse
    const l2: TangentTarget = { kind: "line", a: { x: 0, y: -10 }, b: { x: 0, y: 10 } }; // Y-Achse
    const cands = tangentCircleCenters(l1, l2, 2);
    expect(cands.length).toBe(4);
    // Ein Kandidat pro Quadrant, jeweils bei (±2, ±2).
    const quadrants = [
      { x: 2, y: 2 },
      { x: 2, y: -2 },
      { x: -2, y: 2 },
      { x: -2, y: -2 },
    ];
    for (const q of quadrants) {
      expect(cands.some((c) => dist(c, q) < 1e-9)).toBe(true);
    }
    for (const c of cands) {
      expect(isTangent(c, 2, l1)).toBe(true);
      expect(isTangent(c, 2, l2)).toBe(true);
    }
  });

  it("parallele Geraden, Abstand ≠ 2*r → geometrisch unlösbar (ein Kreis tangential an beide Parallelen MUSS Durchmesser = Abstand haben), keine Kandidaten", () => {
    const l1: TangentTarget = { kind: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
    const l2: TangentTarget = { kind: "line", a: { x: 0, y: 4 }, b: { x: 10, y: 4 } };
    // Abstand 4, Zielradius 3 (Durchmesser 6 ≠ 4) → keine Lösung.
    expect(tangentCircleCenters(l1, l2, 3)).toEqual([]);
  });

  it("parallele Geraden, Abstand GENAU 2*r → degenerierter Fall (unendlich viele Lösungen entlang der Linie): bekannte Einschränkung, liefert KEINE Kandidaten statt unendlich vieler", () => {
    const l1: TangentTarget = { kind: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
    const l2: TangentTarget = { kind: "line", a: { x: 0, y: 4 }, b: { x: 10, y: 4 } };
    // Abstand 4 = 2*r bei r=2 → jede x-Position auf y=2 wäre tangential an beide;
    // `tangentCircleCenters` schneidet nur Geraden-PAARE (lineIntersect scheitert
    // an zusammenfallenden/parallelen Geraden) und liefert hier bewusst nichts,
    // statt eine beliebige der unendlich vielen Lösungen zu erraten.
    expect(tangentCircleCenters(l1, l2, 2)).toEqual([]);
  });
});

describe("tangentCircleCenters — Gerade + Kreis", () => {
  it("X-Achse + Kreis (Mittelpunkt (0,6), r=3), Zielradius 2 → Kandidaten in der Lücke, tangential an beide", () => {
    // Lücke zwischen Achse und Kreis-Unterkante (y=3) ist 3 — bei Zielradius 2
    // (Durchmesser 4 > Lücke 3) passt ein Kreis, der beide von aussen berührt.
    const line: TangentTarget = { kind: "line", a: { x: -10, y: 0 }, b: { x: 10, y: 0 } };
    const circle: TangentTarget = { kind: "circle", center: { x: 0, y: 6 }, r: 3 };
    const cands = tangentCircleCenters(line, circle, 2);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(isTangent(c, 2, line)).toBe(true);
      expect(isTangent(c, 2, circle)).toBe(true);
    }
    // Erwartet (rechnerisch): (±3, 2) — tangential an y=0 (Abstand 2) und an
    // den Kreis (Abstand zu (0,6) = sqrt(9+16) = 5 = 3+2).
    expect(cands.some((c) => Math.abs(c.x - 3) < 1e-9 && Math.abs(c.y - 2) < 1e-9)).toBe(true);
    expect(cands.some((c) => Math.abs(c.x + 3) < 1e-9 && Math.abs(c.y - 2) < 1e-9)).toBe(true);
  });
});

describe("tangentCircleCenters — zwei Kreise", () => {
  it("zwei getrennte Kreise, Zielradius verbindet beide von aussen (äussere Berührung)", () => {
    // Loci-Radien 2+8=10 je Seite, Mittelpunkt-Abstand 16 ≤ 10+10 → lösbar,
    // symmetrische Schnittpunkte bei (0, ±6) (10² = 8² + 6²).
    const c1: TangentTarget = { kind: "circle", center: { x: -8, y: 0 }, r: 2 };
    const c2: TangentTarget = { kind: "circle", center: { x: 8, y: 0 }, r: 2 };
    const cands = tangentCircleCenters(c1, c2, 8);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(isTangent(c, 8, c1)).toBe(true);
      expect(isTangent(c, 8, c2)).toBe(true);
    }
    // Symmetrische Konfiguration: je ein Kandidat oberhalb/unterhalb der X-Achse bei x≈0.
    expect(cands.some((c) => Math.abs(c.x) < 1e-6 && Math.abs(c.y - 6) < 1e-9)).toBe(true);
    expect(cands.some((c) => Math.abs(c.x) < 1e-6 && Math.abs(c.y + 6) < 1e-9)).toBe(true);
  });

  it("ein kleiner Kreis INNERHALB eines grossen → innere Berührung liefert Kandidaten", () => {
    const outer: TangentTarget = { kind: "circle", center: { x: 0, y: 0 }, r: 10 };
    const inner: TangentTarget = { kind: "circle", center: { x: 3, y: 0 }, r: 2 };
    // Zielkreis mit r=4, tangential von innen an `outer` und von aussen an `inner`.
    const cands = tangentCircleCenters(outer, inner, 4);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(isTangent(c, 4, outer)).toBe(true);
      expect(isTangent(c, 4, inner)).toBe(true);
    }
  });

  it("konzentrische Kreise gleichen Radius (innere Loci kollabieren) → keine Endlosschleife, endliches Ergebnis", () => {
    const c1: TangentTarget = { kind: "circle", center: { x: 0, y: 0 }, r: 5 };
    const c2: TangentTarget = { kind: "circle", center: { x: 0, y: 0 }, r: 5 };
    const cands = tangentCircleCenters(c1, c2, 2);
    // Konzentrisch → circleCircleIntersect liefert für die äussere Loci-Kombination
    // nichts (gleicher Mittelpunkt, `d < EPS`); Funktion muss dennoch sauber terminieren.
    expect(Array.isArray(cands)).toBe(true);
  });
});
