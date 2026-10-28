// Tests für den DXF-Import der Kurven-Entities ARC / CIRCLE / ELLIPSE:
// belegt Tessellierung, Winkeleinheit (Radiant), Schließung und Z-Höhe.

import { beforeAll, describe, it, expect } from "vitest";
import { parseDxf } from "./dxfParser";
import { loadFileioForTests } from "../engine/fileioWasm.testing";
import { contoursToDrawings, textsToDrawings } from "./dxfToDrawings";
import type { Contour, ContourSet, Vec2 } from "../model/types";

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

beforeAll(loadFileioForTests);

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

// ── HATCH (gefüllte Flächen) ──────────────────────────────────────────────────

/** HATCH mit Polyline-Randpfad (Flag 3 = external+polyline). */
function hatchPoly(verts: Array<[number, number]>): string[] {
  const g = ["0", "HATCH", "8", "0", "2", "SOLID", "70", "1", "91", "1", "92", "3", "72", "0", "73", "1", "93", `${verts.length}`];
  for (const [x, y] of verts) g.push("10", `${x}`, "20", `${y}`);
  g.push("97", "0");
  return g;
}

/** HATCH mit Kanten-Randpfad aus Linienkanten (Flag 1 = external, kein Polyline-Bit). */
function hatchLineEdges(verts: Array<[number, number]>): string[] {
  const g = ["0", "HATCH", "8", "0", "2", "SOLID", "70", "1", "91", "1", "92", "1", "93", `${verts.length}`];
  for (let k = 0; k < verts.length; k++) {
    const a = verts[k];
    const b = verts[(k + 1) % verts.length];
    g.push("72", "1", "10", `${a[0]}`, "20", `${a[1]}`, "11", `${b[0]}`, "21", `${b[1]}`);
  }
  g.push("97", "0");
  return g;
}

/** HATCH mit einer Bogenkante (Kantentyp 2), Winkel in Grad. */
function hatchArc(cx: number, cy: number, r: number, s: number, e: number): string[] {
  return [
    "0", "HATCH", "8", "0", "2", "SOLID", "70", "1",
    "91", "1", "92", "1", "93", "1",
    "72", "2", "10", `${cx}`, "20", `${cy}`, "40", `${r}`, "50", `${s}`, "51", `${e}`, "73", "1",
    "97", "0",
  ];
}

describe("parseDxf — HATCH", () => {
  it("Polyline-Rand → geschlossene gefüllte Kontur", () => {
    const c = onlyContour(dxf(hatchPoly([[0, 0], [10, 0], [10, 10], [0, 10]])));
    expect(c.closed).toBe(true);
    expect(c.filled).toBe(true);
    expect(c.pts).toHaveLength(4);
    expect(c.pts[1].x).toBeCloseTo(10, 9);
    expect(c.pts[1].y).toBeCloseTo(0, 9);
    expect(c.pts[2].x).toBeCloseTo(10, 9);
    expect(c.pts[2].y).toBeCloseTo(10, 9);
  });

  it("Linienkanten-Rand → geschlossene gefüllte Kontur (Eckpunkte)", () => {
    const c = onlyContour(dxf(hatchLineEdges([[0, 0], [4, 0], [4, 4], [0, 4]])));
    expect(c.closed).toBe(true);
    expect(c.filled).toBe(true);
    expect(c.pts).toHaveLength(4);
    const xs = c.pts.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0, 9);
    expect(xs[3]).toBeCloseTo(4, 9);
  });

  it("Bogenkante → tessellierter Halbkreis auf Radius", () => {
    const c = onlyContour(dxf(hatchArc(0, 0, 5, 0, 180)));
    expect(c.filled).toBe(true);
    for (const p of c.pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(5, 6);
    expect(c.pts[0].x).toBeCloseTo(5, 6);
    expect(c.pts[0].y).toBeCloseTo(0, 6);
    const last = c.pts[c.pts.length - 1];
    expect(last.x).toBeCloseTo(-5, 6);
    expect(last.y).toBeCloseTo(0, 6);
  });

  it("Ellipsenkante → tessellierter Halbumlauf mit korrekten Halbachsen", () => {
    // Center (0,0), Hauptachse (10,0), Verhältnis 0.5, 0°→180° ccw.
    const g = [
      "0", "HATCH", "8", "0", "2", "SOLID", "70", "1",
      "91", "1", "92", "1", "93", "1",
      "72", "3", "10", "0", "20", "0", "11", "10", "21", "0", "40", "0.5", "50", "0", "51", "180", "73", "1",
      "97", "0",
    ];
    const c = onlyContour(dxf(g));
    expect(c.filled).toBe(true);
    // t=0 → Center + Hauptachse = (10,0).
    expect(c.pts[0].x).toBeCloseTo(10, 6);
    expect(c.pts[0].y).toBeCloseTo(0, 6);
    // Scheitel bei t=90° → Nebenachse (0,5).
    const maxY = Math.max(...c.pts.map((p) => p.y));
    expect(maxY).toBeCloseTo(5, 6);
    const last = c.pts[c.pts.length - 1];
    expect(last.x).toBeCloseTo(-10, 6);
    expect(last.y).toBeCloseTo(0, 6);
  });

  it("Spline-Kante (Grad 1) → Kontrollpolygon nachgezeichnet", () => {
    // 2 CPs (0,0)-(10,0), Grad 1, clamped-Knoten [0,0,1,1].
    const g = [
      "0", "HATCH", "8", "0", "2", "SOLID", "70", "1",
      "91", "1", "92", "1", "93", "1",
      "72", "4", "94", "1", "95", "4", "96", "2",
      "40", "0", "40", "0", "40", "1", "40", "1",
      "10", "0", "20", "0", "10", "10", "20", "0",
      "97", "0",
    ];
    const c = onlyContour(dxf(g));
    expect(c.filled).toBe(true);
    expect(c.pts[0].x).toBeCloseTo(0, 9);
    expect(c.pts[0].y).toBeCloseTo(0, 9);
    const last = c.pts[c.pts.length - 1];
    expect(last.x).toBeCloseTo(10, 9);
    expect(last.y).toBeCloseTo(0, 9);
    for (const p of c.pts) expect(p.y).toBeCloseTo(0, 9);
  });

  it("mehrere Randpfade → mehrere Loops (Insel als eigener Ring)", () => {
    // Zwei Polyline-Pfade in EINER HATCH: numPaths = 2.
    const g = [
      "0", "HATCH", "8", "0", "2", "SOLID", "70", "1", "91", "2",
      "92", "3", "72", "0", "73", "1", "93", "4",
      "10", "0", "20", "0", "10", "10", "20", "0", "10", "10", "20", "10", "10", "0", "20", "10",
      "97", "0",
      "92", "3", "72", "0", "73", "1", "93", "4",
      "10", "3", "20", "3", "10", "7", "20", "3", "10", "7", "20", "7", "10", "3", "20", "7",
      "97", "0",
    ];
    const res = parseDxf(dxf(g));
    expect(res.contours[0].contours).toHaveLength(2);
    expect(res.contours[0].contours.every((c) => c.filled && c.closed)).toBe(true);
  });
});

// ── TEXT / MTEXT ──────────────────────────────────────────────────────────────

/** TEXT-Entity: Position, Höhe, Rotation (Grad), String. */
function textEnt(x: number, y: number, h: number, rotDeg: number, s: string): string[] {
  return ["0", "TEXT", "8", "0", "10", `${x}`, "20", `${y}`, "30", "0", "40", `${h}`, "50", `${rotDeg}`, "1", s];
}

/** MTEXT-Entity: Position, Höhe, String (Rotation 0). */
function mtextEnt(x: number, y: number, h: number, s: string): string[] {
  return ["0", "MTEXT", "8", "0", "10", `${x}`, "20", `${y}`, "30", "0", "40", `${h}`, "50", "0", "1", s];
}

describe("parseDxf — TEXT/MTEXT", () => {
  it("TEXT → ImportedText mit Position/Höhe/Winkel (Grad→Radiant)", () => {
    const res = parseDxf(dxf(textEnt(5, 3, 0.5, 90, "Hallo")));
    expect(res.texts).toHaveLength(1);
    const t0 = res.texts![0];
    expect(t0.at.x).toBeCloseTo(5, 9);
    expect(t0.at.y).toBeCloseTo(3, 9);
    expect(t0.height).toBeCloseTo(0.5, 9);
    expect(t0.angle).toBeCloseTo(Math.PI / 2, 9);
    expect(t0.text).toBe("Hallo");
  });

  it("MTEXT → Formatcodes gesäubert (\\P → Leerzeichen)", () => {
    const res = parseDxf(dxf(mtextEnt(1, 2, 0.3, "Welt\\Pzeile2")));
    expect(res.texts![0].text).toBe("Welt zeile2");
    expect(res.texts![0].at.x).toBeCloseTo(1, 9);
    expect(res.texts![0].height).toBeCloseTo(0.3, 9);
  });

  it("leerer Text wird übersprungen", () => {
    const res = parseDxf(dxf(textEnt(0, 0, 0.2, 0, "")));
    expect(res.texts ?? []).toHaveLength(0);
  });

  it("fehlende Höhe → positiver Default", () => {
    const g = ["0", "TEXT", "8", "0", "10", "0", "20", "0", "30", "0", "1", "X"];
    const res = parseDxf(dxf(g));
    expect(res.texts![0].height).toBeGreaterThan(0);
  });
});

describe("textsToDrawings", () => {
  it("ImportedText → Drawing2D {shape:\"text\"}", () => {
    const drawings = textsToDrawings(
      [{ at: { x: 1, y: 2 }, text: "Hi", height: 0.4, angle: 0, layer: "L" }],
      "lvl", "active", "CODE", (s) => s,
    );
    expect(drawings).toHaveLength(1);
    const g = drawings[0].geom;
    expect(g.shape).toBe("text");
    if (g.shape === "text") {
      expect(g.text).toBe("Hi");
      expect(g.height).toBeCloseTo(0.4, 9);
      expect(g.at.x).toBeCloseTo(1, 9);
    }
  });
});

describe("parseDxf — Kurven behalten echte Geometrie (curve)", () => {
  it("CIRCLE trägt curve {kind:circle}", () => {
    const c = onlyContour(dxf(circle(10, 20, 5, 4)));
    expect(c.curve?.kind).toBe("circle");
    expect(c.curve?.cx).toBeCloseTo(10, 9);
    expect(c.curve?.cy).toBeCloseTo(20, 9);
    expect(c.curve?.r).toBeCloseTo(4, 9);
  });

  it("ARC trägt curve {kind:arc} mit Winkeln (Radiant)", () => {
    const c = onlyContour(dxf(arc(0, 0, 10, 0, 90)));
    expect(c.curve?.kind).toBe("arc");
    expect(c.curve?.r).toBeCloseTo(10, 9);
    expect(c.curve?.a0).toBeCloseTo(0, 9);
    expect(c.curve?.a1).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe("contoursToDrawings — Kurven → glatte Formen", () => {
  it("curve circle → {shape:\"circle\"}", () => {
    const set: ContourSet = {
      id: "s", type: "contourSet", name: "c",
      contours: [{ z: 0, closed: true, pts: [{ x: 0, y: 0 }], curve: { kind: "circle", cx: 1, cy: 2, r: 3, a0: 0, a1: Math.PI * 2 } }],
    };
    const [d] = contoursToDrawings([set], "lvl", "active", "C", (s) => s);
    expect(d.geom.shape).toBe("circle");
    if (d.geom.shape === "circle") {
      expect(d.geom.r).toBeCloseTo(3, 9);
      expect(d.geom.center.x).toBeCloseTo(1, 9);
    }
  });

  it("curve arc → {shape:\"arc\"}", () => {
    const set: ContourSet = {
      id: "s", type: "contourSet", name: "c",
      contours: [{ z: 0, closed: false, pts: [{ x: 0, y: 0 }], curve: { kind: "arc", cx: 0, cy: 0, r: 5, a0: 0, a1: 1 } }],
    };
    const [d] = contoursToDrawings([set], "lvl", "active", "C", (s) => s);
    expect(d.geom.shape).toBe("arc");
    if (d.geom.shape === "arc") {
      expect(d.geom.r).toBeCloseTo(5, 9);
      expect(d.geom.a1).toBeCloseTo(1, 9);
    }
  });
});

describe("contoursToDrawings — HATCH-Füllung", () => {
  it("gefüllte Kontur → Drawing2D mit fillColor und polyline-Form", () => {
    const set: ContourSet = {
      id: "s", type: "contourSet", name: "h",
      contours: [{ z: 0, closed: true, filled: true, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }],
    };
    const [d] = contoursToDrawings([set], "lvl", "active", "CODE", (s) => s);
    expect(d.geom.shape).toBe("polyline");
    expect(d.fillColor).toBeTruthy();
  });

  it("ungefüllte Kontur → Drawing2D ohne fillColor", () => {
    const set: ContourSet = {
      id: "s", type: "contourSet", name: "h",
      contours: [{ z: 0, closed: true, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }],
    };
    const [d] = contoursToDrawings([set], "lvl", "active", "CODE", (s) => s);
    expect(d.fillColor).toBeUndefined();
  });
});

describe("parseDxf — Polyface-Mesh (POLYLINE Flag 64, swissBUILDINGS3D-Format)", () => {
  // Regression: die installierte dxf-parser-Version liefert Face-Vertex-
  // Indizes NICHT als `faces`-Array, sondern als vier einzelne Felder
  // (Gruppencodes 71–74, faceA..faceD) — reale swissBUILDINGS3D-DXF-Kacheln
  // ergaben dadurch 0 Dreiecke (Nutzer-Report „Gebäude-Import funktioniert
  // nicht"). Rohes DXF (keine gemockte Entity-Form), damit auch die
  // zugrundeliegende Bibliothek mitgeprüft wird.
  it("ein Dreieck (3 Geometrie-Vertices + 1 Face-Record) ergibt genau 1 Dreieck", () => {
    const lines = [
      "0", "SECTION", "2", "ENTITIES",
      "0", "POLYLINE", "8", "0", "70", "64",
      "0", "VERTEX", "8", "0", "70", "192", "10", "0.0", "20", "0.0", "30", "0.0",
      "0", "VERTEX", "8", "0", "70", "192", "10", "1.0", "20", "0.0", "30", "0.0",
      "0", "VERTEX", "8", "0", "70", "192", "10", "0.0", "20", "1.0", "30", "0.0",
      "0", "VERTEX", "8", "0", "70", "128", "10", "0.0", "20", "0.0", "30", "0.0",
      "71", "1", "72", "2", "73", "3",
      "0", "SEQEND",
      "0", "ENDSEC", "0", "EOF",
    ];
    const res = parseDxf(lines.join("\n"));
    expect(res.meshes).toHaveLength(1);
    expect(res.meshes[0].positions.length / 3).toBe(3);
    expect(res.meshes[0].indices).toEqual([0, 1, 2]);
  });

  it("ein Viereck (4 Geometrie-Vertices + 1 Face-Record mit faceD) ergibt 2 Dreiecke (Fan)", () => {
    const lines = [
      "0", "SECTION", "2", "ENTITIES",
      "0", "POLYLINE", "8", "0", "70", "64",
      "0", "VERTEX", "8", "0", "70", "192", "10", "0.0", "20", "0.0", "30", "0.0",
      "0", "VERTEX", "8", "0", "70", "192", "10", "1.0", "20", "0.0", "30", "0.0",
      "0", "VERTEX", "8", "0", "70", "192", "10", "1.0", "20", "1.0", "30", "0.0",
      "0", "VERTEX", "8", "0", "70", "192", "10", "0.0", "20", "1.0", "30", "0.0",
      "0", "VERTEX", "8", "0", "70", "128", "10", "0.0", "20", "0.0", "30", "0.0",
      "71", "1", "72", "2", "73", "3", "74", "4",
      "0", "SEQEND",
      "0", "ENDSEC", "0", "EOF",
    ];
    const res = parseDxf(lines.join("\n"));
    expect(res.meshes).toHaveLength(1);
    expect(res.meshes[0].positions.length / 3).toBe(4);
    expect(res.meshes[0].indices.length / 3).toBe(2);
  });

  it("negative (unsichtbare-Kante) Face-Indizes werden per abs() aufgelöst", () => {
    const lines = [
      "0", "SECTION", "2", "ENTITIES",
      "0", "POLYLINE", "8", "0", "70", "64",
      "0", "VERTEX", "8", "0", "70", "192", "10", "0.0", "20", "0.0", "30", "0.0",
      "0", "VERTEX", "8", "0", "70", "192", "10", "1.0", "20", "0.0", "30", "0.0",
      "0", "VERTEX", "8", "0", "70", "192", "10", "0.0", "20", "1.0", "30", "0.0",
      "0", "VERTEX", "8", "0", "70", "128", "10", "0.0", "20", "0.0", "30", "0.0",
      "71", "1", "72", "-2", "73", "3",
      "0", "SEQEND",
      "0", "ENDSEC", "0", "EOF",
    ];
    const res = parseDxf(lines.join("\n"));
    expect(res.meshes).toHaveLength(1);
    expect(res.meshes[0].indices).toEqual([0, 1, 2]);
  });
});
