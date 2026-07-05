// Tests für den DXF-Import der Kurven-Entities ARC / CIRCLE / ELLIPSE:
// belegt Tessellierung, Winkeleinheit (Radiant), Schließung und Z-Höhe.

import { describe, it, expect } from "vitest";
import { parseDxf } from "./dxfParser";
import type { Contour, Vec2 } from "../model/types";

/** Minimales DXF aus Gruppencode/Wert-Paaren; nur eine ENTITIES-Sektion. */
function dxf(...entities: string[][]): string {
  const lines = ["0", "SECTION", "2", "ENTITIES"];
  for (const pairs of entities) lines.push(...pairs);
  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\n");
}

/** Ein CIRCLE-Entity: Zentrum (cx,cy,cz), Radius r. */
function circle(cx: number, cy: number, cz: number, r: number): string[] {
  return ["0", "CIRCLE", "8", "0", "10", `${cx}`, "20", `${cy}`, "30", `${cz}`, "40", `${r}`];
}

/** Ein ARC-Entity: Zentrum, Radius, Start/End in GRAD (DXF-Konvention). */
function arc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string[] {
  return [
    "0", "ARC", "8", "0",
    "10", `${cx}`, "20", `${cy}`, "30", "0",
    "40", `${r}`, "50", `${startDeg}`, "51", `${endDeg}`,
  ];
}

/** Ein ELLIPSE-Entity: Zentrum, Hauptachsen-Endpunkt (rel.), Verhältnis, Start/End (Radiant). */
function ellipse(
  cx: number, cy: number, majX: number, majY: number, ratio: number, start: number, end: number,
): string[] {
  return [
    "0", "ELLIPSE", "8", "0",
    "10", `${cx}`, "20", `${cy}`, "30", "0",
    "11", `${majX}`, "21", `${majY}`, "31", "0",
    "40", `${ratio}`, "41", `${start}`, "42", `${end}`,
  ];
}

const dist = (p: Vec2, cx: number, cy: number) => Math.hypot(p.x - cx, p.y - cy);

/** Einzige Kontur des Imports (Test-Bequemlichkeit). */
function onlyContour(text: string): Contour {
  const res = parseDxf(text);
  expect(res.contours).toHaveLength(1);
  expect(res.contours[0].contours).toHaveLength(1);
  return res.contours[0].contours[0];
}

describe("parseDxf — CIRCLE", () => {
  it("erzeugt einen geschlossenen, tessellierten Ring auf konstantem Radius", () => {
    const c = onlyContour(dxf(circle(10, 20, 5, 4)));
    expect(c.closed).toBe(true);
    expect(c.z).toBe(5);
    // Voller Kreis ohne Schluss-Duplikat: 2π / (π/32) = 64 Segmente → 64 Punkte.
    expect(c.pts).toHaveLength(64);
    for (const p of c.pts) expect(dist(p, 10, 20)).toBeCloseTo(4, 9);
    // Erster Punkt bei Winkel 0: (cx+r, cy).
    expect(c.pts[0].x).toBeCloseTo(14, 9);
    expect(c.pts[0].y).toBeCloseTo(20, 9);
    // Kein Duplikat des Startpunkts am Ende.
    expect(dist(c.pts[c.pts.length - 1], 14, 20)).toBeGreaterThan(0.01);
  });
});

describe("parseDxf — ARC", () => {
  it("tesselliert einen Viertelbogen 0°→90° CCW (offen)", () => {
    const c = onlyContour(dxf(arc(0, 0, 10, 0, 90)));
    expect(c.closed).toBe(false);
    // Spanne π/2 → 16 Segmente → 17 Punkte.
    expect(c.pts).toHaveLength(17);
    expect(c.pts[0].x).toBeCloseTo(10, 9);
    expect(c.pts[0].y).toBeCloseTo(0, 9);
    const end = c.pts[c.pts.length - 1];
    expect(end.x).toBeCloseTo(0, 9);
    expect(end.y).toBeCloseTo(10, 9);
    for (const p of c.pts) expect(dist(p, 0, 0)).toBeCloseTo(10, 9);
  });

  it("ergänzt eine umlaufende Spanne (270°→90°) um 2π statt negativ", () => {
    const c = onlyContour(dxf(arc(0, 0, 5, 270, 90)));
    // Spanne 180° = π → 32 Segmente → 33 Punkte, CCW von unten (−y) nach oben (+y).
    expect(c.pts).toHaveLength(33);
    expect(c.pts[0].y).toBeCloseTo(-5, 9);
    expect(c.pts[c.pts.length - 1].y).toBeCloseTo(5, 9);
    // Mittelpunkt der Spanne (bei 0°) liegt bei (+r, 0), nicht (−r, 0).
    expect(c.pts[16].x).toBeCloseTo(5, 6);
  });
});

describe("parseDxf — ELLIPSE", () => {
  it("tesselliert einen vollen Umlauf (geschlossen) mit korrekten Halbachsen", () => {
    const c = onlyContour(ellipse2Dxf());
    expect(c.closed).toBe(true);
    // Voller Umlauf → Schluss-Duplikat weggelassen.
    expect(dist(c.pts[c.pts.length - 1], c.pts[0].x, c.pts[0].y)).toBeGreaterThan(0.01);
    // Hauptachse 10 entlang x, Nebenachse 5 entlang y (ratio 0.5).
    const maxX = Math.max(...c.pts.map((p) => p.x));
    const maxY = Math.max(...c.pts.map((p) => p.y));
    expect(maxX).toBeCloseTo(10, 6);
    expect(maxY).toBeCloseTo(5, 6);
    // Parameter t=0 → Center + Hauptachse = (10, 0).
    expect(c.pts[0].x).toBeCloseTo(10, 9);
    expect(c.pts[0].y).toBeCloseTo(0, 9);
  });
});

/** Volle Ellipse: Center (0,0), Hauptachse (10,0), ratio 0.5, 0..2π. */
function ellipse2Dxf(): string {
  return dxf(ellipse(0, 0, 10, 0, 0.5, 0, Math.PI * 2));
}

describe("parseDxf — gemischt", () => {
  it("liest mehrere Kurven-Entities in EINEN Konturensatz", () => {
    const res = parseDxf(dxf(circle(0, 0, 0, 1), arc(0, 0, 2, 0, 90)));
    expect(res.contours).toHaveLength(1);
    expect(res.contours[0].contours).toHaveLength(2);
  });
});
