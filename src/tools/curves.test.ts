import { describe, it, expect } from "vitest";
import { ellipsePts, sampleBezierChain, sampleCatmullRom, sampleUniformBSpline } from "./curves";

describe("ellipsePts", () => {
  it("liegt auf der Ellipse (rotation 0): Ost/Nord-Punkte bei rx/ry", () => {
    const pts = ellipsePts({ x: 0, y: 0 }, 4, 2, 0, 4);
    // t=0 → Ost (rx,0); t=π/2 → Nord (0,ry)
    expect(pts[0].x).toBeCloseTo(4, 6);
    expect(pts[0].y).toBeCloseTo(0, 6);
    expect(pts[1].x).toBeCloseTo(0, 6);
    expect(pts[1].y).toBeCloseTo(2, 6);
  });

  it("Drehung um 90° vertauscht die Achsen", () => {
    const pts = ellipsePts({ x: 0, y: 0 }, 4, 2, Math.PI / 2, 4);
    // Der ehemalige Ost-Punkt (rx,0) liegt jetzt bei (0, rx).
    expect(pts[0].x).toBeCloseTo(0, 6);
    expect(pts[0].y).toBeCloseTo(4, 6);
  });

  it("Mittelpunkt-Verschiebung wird respektiert", () => {
    const pts = ellipsePts({ x: 10, y: 5 }, 3, 3, 0, 8);
    for (const p of pts) {
      expect(Math.hypot(p.x - 10, p.y - 5)).toBeCloseTo(3, 6);
    }
  });
});

describe("sampleBezierChain", () => {
  it("weniger als 4 Punkte: Rohpunkte unverändert (Gummiband-Vorschau)", () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(sampleBezierChain(pts)).toEqual(pts);
  });

  it("ein Segment: startet bei P0, endet bei P3", () => {
    const p0 = { x: 0, y: 0 }, p1 = { x: 1, y: 3 }, p2 = { x: 3, y: 3 }, p3 = { x: 4, y: 0 };
    const out = sampleBezierChain([p0, p1, p2, p3], 10);
    expect(out[0]).toEqual(p0);
    const last = out[out.length - 1];
    expect(last.x).toBeCloseTo(p3.x, 6);
    expect(last.y).toBeCloseTo(p3.y, 6);
  });

  it("t=0.5 folgt der De-Casteljau-Formel (symmetrischer Fall)", () => {
    const p0 = { x: 0, y: 0 }, p1 = { x: 0, y: 4 }, p2 = { x: 4, y: 4 }, p3 = { x: 4, y: 0 };
    const out = sampleBezierChain([p0, p1, p2, p3], 2); // t = 0.5 genau bei Index 1
    // Symmetrische Kontrollpunkte → Kurvenmitte liegt exakt bei (2, 3).
    expect(out[1].x).toBeCloseTo(2, 6);
    expect(out[1].y).toBeCloseTo(3, 6);
  });

  it("zwei Segmente: verbindet am gemeinsamen Anker P3=P4", () => {
    const pts = [
      { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 0 },
      { x: 4, y: -1 }, { x: 5, y: -1 }, { x: 6, y: 0 },
    ];
    const out = sampleBezierChain(pts, 5);
    expect(out[0]).toEqual(pts[0]);
    const last = out[out.length - 1];
    expect(last.x).toBeCloseTo(6, 6);
    expect(last.y).toBeCloseTo(0, 6);
  });
});

describe("sampleCatmullRom", () => {
  it("weniger als 3 Punkte: Rohpunkte unverändert", () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(sampleCatmullRom(pts, false)).toEqual(pts);
  });

  it("offen: läuft durch den ersten und letzten Wegpunkt", () => {
    const pts = [{ x: 0, y: 0 }, { x: 2, y: 3 }, { x: 5, y: 1 }, { x: 8, y: 4 }];
    const out = sampleCatmullRom(pts, false, 8);
    expect(out[0]).toEqual(pts[0]);
    const last = out[out.length - 1];
    expect(last.x).toBeCloseTo(8, 6);
    expect(last.y).toBeCloseTo(4, 6);
  });

  it("Kollineare Punkte ergeben eine Gerade (kein Überschwingen)", () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
    const out = sampleCatmullRom(pts, false, 4);
    for (const p of out) expect(p.y).toBeCloseTo(0, 6);
  });

  it("geschlossen: liefert keinen doppelten Schlusspunkt (Aufrufer schliesst selbst)", () => {
    const pts = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    const out = sampleCatmullRom(pts, true, 6);
    expect(out.length).toBe(pts.length * 6);
  });
});

describe("sampleUniformBSpline (Kontrollpunkt-/CV-Modus)", () => {
  it("weniger als 3 Punkte: Rohpunkte unverändert (Gummiband-Vorschau, wie sampleCatmullRom)", () => {
    const pts = [{ x: 0, y: 0 }, { x: 3, y: 4 }];
    expect(sampleUniformBSpline(pts, false, 8)).toEqual(pts);
  });

  it("offen, geklemmt: berührt exakt Start- und Endpunkt", () => {
    const pts = [{ x: 0, y: 0 }, { x: 2, y: 5 }, { x: 6, y: 5 }, { x: 8, y: 0 }];
    const out = sampleUniformBSpline(pts, false, 10);
    expect(out[0]).toEqual(pts[0]);
    const last = out[out.length - 1];
    expect(last.x).toBeCloseTo(8, 9);
    expect(last.y).toBeCloseTo(0, 9);
  });

  it("offen, geklemmt: berührt die INNEREN Kontrollpunkte NICHT (Gegensatz zu Catmull-Rom, das interpoliert)", () => {
    // Zwei Kontrollpunkte weit ausserhalb der Verbindungslinie Start-Ende —
    // eine interpolierende Kurve (Catmull-Rom) würde exakt durch sie
    // verlaufen; die B-Spline-Kurve wird nur "angezogen".
    const pts = [{ x: 0, y: 0 }, { x: 2, y: 10 }, { x: 6, y: 10 }, { x: 8, y: 0 }];
    const out = sampleUniformBSpline(pts, false, 20);
    const touchesInner = out.some(
      (p) => Math.hypot(p.x - 2, p.y - 10) < 1e-6 || Math.hypot(p.x - 6, p.y - 10) < 1e-6,
    );
    expect(touchesInner).toBe(false);
    // Bleibt aber innerhalb der konvexen Hülle der Kontrollpunkte (y ≤ 10).
    for (const p of out) expect(p.y).toBeLessThanOrEqual(10 + 1e-9);
  });

  it("zwei effektive Kontrollpunkte (Start/Ende mehrfach dupliziert) ergeben eine echte Gerade", () => {
    // Mit 3 kollinearen Punkten bleibt die Kurve (als Kombination kollinearer
    // Kontrollpunkte) exakt auf der Verbindungsgeraden.
    const pts = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 6, y: 0 }];
    const out = sampleUniformBSpline(pts, false, 8);
    for (const p of out) expect(p.y).toBeCloseTo(0, 9);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[2]);
  });

  it("geschlossen (periodisch): liefert keinen doppelten Schlusspunkt UND berührt keinen der Kontrollpunkte", () => {
    const pts = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    const out = sampleUniformBSpline(pts, true, 6);
    expect(out.length).toBe(pts.length * 6);
    for (const cp of pts) {
      expect(out.some((p) => Math.hypot(p.x - cp.x, p.y - cp.y) < 1e-6)).toBe(false);
    }
  });
});
