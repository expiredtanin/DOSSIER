/**
 * [190] Verbinden (Cmd/Ctrl+J, Befehl „join") mit Bogenwänden: Kern `cmd_wall_edit.rs::connect_ops`.
 * Enden rücken auf den Kreis–Gerade- bzw. Kreis–Kreis-Schnitt, die Bogenwand behält Mittelpunkt und Radius.
 */
import { describe, it, expect } from "vitest";
import type { Project, Wall } from "../../model/types";
import { documentFor } from "../../core/document";
import { applyOps } from "../../core/ops";
import { sampleProject } from "../../model/sampleProject";

/** Bogenwand auf dem Kreis (Mitte c, Radius r) von a0 nach a1 (Grad, a1 > a0 = Gegenuhrzeigersinn). */
function arcWall(id: string, c: { x: number; y: number }, r: number, a0: number, a1: number): Wall {
  const rad = (d: number) => (d * Math.PI) / 180;
  const pt = (a: number) => ({ x: c.x + r * Math.cos(rad(a)), y: c.y + r * Math.sin(rad(a)) });
  return { ...line(id, pt(a0), pt(a1)), bulge: -Math.tan(rad(a1 - a0) / 4) };
}

function line(id: string, a: { x: number; y: number }, b: { x: number; y: number }): Wall {
  return { id, type: "wall", floorId: "eg", categoryCode: "20", start: a, end: b, wallTypeId: "aw", height: 2.6 };
}

function join(walls: Wall[]): Wall[] {
  const p = { ...sampleProject, walls, openings: [], rooms: [], drawings2d: [] } as Project;
  const ops = documentFor(p).cmdOps({ cmd: "join", ids: walls.map((w) => w.id), stamp: "t" });
  return applyOps(p, ops).walls;
}

/** Mittelpunkt und Radius aus Sehne und Modell-Bulge (positiv = Scheitel links der Sehne). */
function circleOf(w: Wall): { x: number; y: number; r: number } {
  const b = w.bulge ?? 0;
  const dx = w.end.x - w.start.x;
  const dy = w.end.y - w.start.y;
  const c = Math.hypot(dx, dy);
  const r = (c * (1 + b * b)) / (4 * Math.abs(b));
  const sagitta = (Math.abs(b) * c) / 2;
  // Scheitel auf der Seite sign(b) der linken Normalen; Mitte um (Pfeilhöhe − r) von der Sehnenmitte.
  const k = Math.sign(b) * (sagitta - r);
  return { x: (w.start.x + w.end.x) / 2 + (-dy / c) * k, y: (w.start.y + w.end.y) / 2 + (dx / c) * k, r };
}

describe("[190] Cmd+J verbindet Bogenwände", () => {
  it("Bogen–Gerade-Ecke: beide Enden auf dem Achsschnittpunkt, Kreis bleibt", () => {
    const walls = join([arcWall("a", { x: 0, y: 0 }, 5, 0, 85), line("b", { x: 0, y: 5.3 }, { x: 0, y: 9 })]);
    const a = walls.find((w) => w.id === "a")!;
    const b = walls.find((w) => w.id === "b")!;
    expect(a.end.x).toBeCloseTo(0, 6);
    expect(a.end.y).toBeCloseTo(5, 6);
    expect(b.start.x).toBeCloseTo(0, 6);
    expect(b.start.y).toBeCloseTo(5, 6);
    expect(a.bulge).toBeLessThan(0);
    const c = circleOf(a);
    expect(c.r).toBeCloseTo(5, 6);
    expect(Math.hypot(c.x, c.y)).toBeCloseTo(0, 6);
  });

  it("Bogen–Bogen-Ecke: Kreis–Kreis-Schnitt nahe den Enden", () => {
    const walls = join([arcWall("a", { x: 0, y: 0 }, 5, 0, 85), arcWall("b", { x: -5, y: 5 }, 5, 5, 80)]);
    const a = walls.find((w) => w.id === "a")!;
    const b = walls.find((w) => w.id === "b")!;
    expect(a.end.x).toBeCloseTo(0, 6);
    expect(a.end.y).toBeCloseTo(5, 6);
    expect(b.start.x).toBeCloseTo(0, 6);
    expect(b.start.y).toBeCloseTo(5, 6);
    const cb = circleOf(b);
    expect(cb.r).toBeCloseTo(5, 6);
    expect(cb.x).toBeCloseTo(-5, 6);
    expect(cb.y).toBeCloseTo(5, 6);
  });

  it("Gerade an Bogen (T-Stoss): die Gerade endet an der zugewandten Bogenfläche, der Bogen bleibt", () => {
    const arc = arcWall("a", { x: 0, y: 0 }, 5, 0, 180);
    const walls = join([arc, line("b", { x: 0, y: 1 }, { x: 0, y: 4.6 })]);
    const a = walls.find((w) => w.id === "a")!;
    const b = walls.find((w) => w.id === "b")!;
    // Wandtyp „aw" des Beispielprojekts, Referenz Mitte: Innenfläche bei r = 5 − Dicke/2.
    expect(b.end.x).toBeCloseTo(0, 6);
    expect(b.end.y).toBeGreaterThan(4.6);
    expect(b.end.y).toBeLessThan(5);
    expect(a.start).toEqual(arc.start);
    expect(a.end).toEqual(arc.end);
  });
});
