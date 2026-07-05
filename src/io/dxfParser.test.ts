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

// ── SPLINE ────────────────────────────────────────────────────────────────────

/** LINE-Entity (10/20/30 Start, 11/21/31 Ende). */
function line(x1: number, y1: number, x2: number, y2: number): string[] {
  return ["0", "LINE", "8", "0", "10", `${x1}`, "20", `${y1}`, "30", "0", "11", `${x2}`, "21", `${y2}`, "31", "0"];
}

/** SPLINE mit Kontrollpunkten + Knoten (71 Grad, 40 Knoten, 10/20/30 CPs). */
function spline(degree: number, knots: number[], cps: Array<[number, number]>): string[] {
  const g = ["0", "SPLINE", "8", "0", "71", `${degree}`];
  for (const k of knots) g.push("40", `${k}`);
  for (const [x, y] of cps) g.push("10", `${x}`, "20", `${y}`, "30", "0");
  return g;
}

/** SPLINE nur mit Stützpunkten (11/21/31 fitPoints), ohne gültige Knoten. */
function splineFit(fps: Array<[number, number]>): string[] {
  const g = ["0", "SPLINE", "8", "0", "71", "3"];
  for (const [x, y] of fps) g.push("11", `${x}`, "21", `${y}`, "31", "0");
  return g;
}

describe("parseDxf — SPLINE", () => {
  it("Grad-1-Spline zeichnet exakt das Kontrollpolygon nach", () => {
    // Clamped-Knoten für 2 CPs, Grad 1: |U| = 2+1+1 = 4, Domain [0,1].
    const c = onlyContour(dxf(spline(1, [0, 0, 1, 1], [[0, 0], [10, 0]])));
    expect(c.closed).toBe(false);
    expect(c.pts[0].x).toBeCloseTo(0, 9);
    expect(c.pts[0].y).toBeCloseTo(0, 9);
    const last = c.pts[c.pts.length - 1];
    expect(last.x).toBeCloseTo(10, 9);
    expect(last.y).toBeCloseTo(0, 9);
    // Linear: alle Punkte auf y=0, x monoton steigend.
    for (let i = 1; i < c.pts.length; i++) {
      expect(c.pts[i].y).toBeCloseTo(0, 9);
      expect(c.pts[i].x).toBeGreaterThanOrEqual(c.pts[i - 1].x - 1e-9);
    }
  });

  it("Grad-2-Spline bleibt in der konvexen Hülle und endet auf den Rand-CPs", () => {
    // 3 CPs, Grad 2, clamped: |U| = 3+2+1 = 6 → [0,0,0,1,1,1], Domain [0,1].
    const c = onlyContour(
      dxf(spline(2, [0, 0, 0, 1, 1, 1], [[0, 0], [5, 10], [10, 0]])),
    );
    // Endpunkte = erster/letzter Kontrollpunkt (clamped).
    expect(c.pts[0].x).toBeCloseTo(0, 9);
    expect(c.pts[0].y).toBeCloseTo(0, 9);
    const last = c.pts[c.pts.length - 1];
    expect(last.x).toBeCloseTo(10, 9);
    expect(last.y).toBeCloseTo(0, 9);
    // Konvexe Hülle: y nie über 10, x in [0,10]; Scheitel bei x≈5 unter 10.
    for (const p of c.pts) {
      expect(p.y).toBeLessThanOrEqual(10 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x).toBeLessThanOrEqual(10 + 1e-9);
    }
    // Mittelpunkt (t=0.5) einer quadratischen Bézier: 0.25·P0+0.5·P1+0.25·P2 = (5,5).
    const mid = c.pts[Math.floor(c.pts.length / 2)];
    expect(mid.x).toBeCloseTo(5, 6);
    expect(mid.y).toBeCloseTo(5, 6);
  });

  it("fällt ohne gültige Knoten auf die Stützpunkte zurück", () => {
    const c = onlyContour(dxf(splineFit([[0, 0], [1, 2], [3, 4]])));
    expect(c.pts).toHaveLength(3);
    expect(c.pts[1].x).toBeCloseTo(1, 9);
    expect(c.pts[1].y).toBeCloseTo(2, 9);
  });
});

// ── INSERT (Block-Referenzen) ─────────────────────────────────────────────────

/** BLOCK-Definition: Name, Basispunkt, enthaltene Entities. */
function block(name: string, bx: number, by: number, ...ents: string[][]): string[] {
  const g = ["0", "BLOCK", "8", "0", "2", name, "10", `${bx}`, "20", `${by}`, "30", "0", "70", "0"];
  for (const e of ents) g.push(...e);
  g.push("0", "ENDBLK");
  return g;
}

interface InsOpts {
  rot?: number; sx?: number; sy?: number; nc?: number; nr?: number; dc?: number; dr?: number;
}
/** INSERT-Referenz auf einen Block. */
function insert(name: string, x: number, y: number, o: InsOpts = {}): string[] {
  const g = ["0", "INSERT", "2", name, "10", `${x}`, "20", `${y}`, "30", "0"];
  if (o.sx !== undefined) g.push("41", `${o.sx}`);
  if (o.sy !== undefined) g.push("42", `${o.sy}`);
  if (o.rot !== undefined) g.push("50", `${o.rot}`);
  if (o.nc !== undefined) g.push("70", `${o.nc}`);
  if (o.nr !== undefined) g.push("71", `${o.nr}`);
  if (o.dc !== undefined) g.push("44", `${o.dc}`);
  if (o.dr !== undefined) g.push("45", `${o.dr}`);
  return g;
}

/** DXF mit BLOCKS- und ENTITIES-Sektion. */
function dxfFull(blocks: string[][], entities: string[][]): string {
  const lines: string[] = [];
  if (blocks.length) {
    lines.push("0", "SECTION", "2", "BLOCKS");
    for (const b of blocks) lines.push(...b);
    lines.push("0", "ENDSEC");
  }
  lines.push("0", "SECTION", "2", "ENTITIES");
  for (const e of entities) lines.push(...e);
  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\n");
}

describe("parseDxf — INSERT", () => {
  it("verschiebt eine Block-Linie an den Einfügepunkt", () => {
    const c = onlyContour(
      dxfFull([block("seg", 0, 0, line(0, 0, 1, 0))], [insert("seg", 5, 5)]),
    );
    expect(c.pts[0].x).toBeCloseTo(5, 9);
    expect(c.pts[0].y).toBeCloseTo(5, 9);
    expect(c.pts[1].x).toBeCloseTo(6, 9);
    expect(c.pts[1].y).toBeCloseTo(5, 9);
  });

  it("rotiert um 90° und skaliert", () => {
    const rot = onlyContour(
      dxfFull([block("seg", 0, 0, line(0, 0, 1, 0))], [insert("seg", 0, 0, { rot: 90 })]),
    );
    // (1,0) um 90° CCW → (0,1).
    expect(rot.pts[1].x).toBeCloseTo(0, 6);
    expect(rot.pts[1].y).toBeCloseTo(1, 6);

    const scl = onlyContour(
      dxfFull([block("seg", 0, 0, line(0, 0, 1, 0))], [insert("seg", 0, 0, { sx: 2, sy: 3 })]),
    );
    expect(scl.pts[1].x).toBeCloseTo(2, 9);
    expect(scl.pts[1].y).toBeCloseTo(0, 9);
  });

  it("expandiert ein 2×1-Array zu zwei Konturen", () => {
    const res = parseDxf(
      dxfFull([block("seg", 0, 0, line(0, 0, 1, 0))], [insert("seg", 0, 0, { nc: 2, dc: 10 })]),
    );
    const cs = res.contours[0].contours;
    expect(cs).toHaveLength(2);
    // Zweite Spalte um columnSpacing 10 versetzt.
    const xs = cs.map((c) => c.pts[0].x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0, 9);
    expect(xs[1]).toBeCloseTo(10, 9);
  });

  it("löst verschachtelte Blockreferenzen auf (Transform-Komposition)", () => {
    const c = onlyContour(
      dxfFull(
        [
          block("inner", 0, 0, line(0, 0, 1, 0)),
          block("outer", 0, 0, insert("inner", 2, 0)),
        ],
        [insert("outer", 0, 3)],
      ),
    );
    // inner (0,0)-(1,0) → +（2,0) durch outer → +（0,3) durch top = (2,3)-(3,3).
    expect(c.pts[0].x).toBeCloseTo(2, 9);
    expect(c.pts[0].y).toBeCloseTo(3, 9);
    expect(c.pts[1].x).toBeCloseTo(3, 9);
    expect(c.pts[1].y).toBeCloseTo(3, 9);
  });
});
