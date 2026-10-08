import { describe, expect, it } from "vitest";
import {
  DIM_DEFAULTS_MM,
  dimTextFrame,
  dimTextOffsetFromPoint,
  dimTextPos,
  mmToModel,
  modelToMm,
} from "./dimension";

const A = { x: 0, y: 0 };
const B = { x: 4, y: 0 };
/** Schrifthöhe in MODELL-Metern bei 1:50 — die Helfer rechnen in Modellmass. */
const H = mmToModel(DIM_DEFAULTS_MM.textHeight, 50);

describe("dimTextFrame", () => {
  it("Standardlage: mittig über der Masslinie (Offset eingerechnet)", () => {
    const f = dimTextFrame(A, B, 1, H);
    expect(f.base.x).toBeCloseTo(2, 9);
    expect(f.base.y).toBeCloseTo(1 + H * 0.6, 9);
  });

  it("Leserichtung nie kopfüber — auch bei rückwärts laufender Kette", () => {
    const forward = dimTextFrame(A, B, 0, H);
    const backward = dimTextFrame(B, A, 0, H);
    expect(forward.read.x).toBeCloseTo(1, 9);
    // b→a zeigt nach −X; die Zahl dreht sich trotzdem in die Leserichtung.
    expect(backward.read.x).toBeCloseTo(1, 9);
  });
});

describe("dimTextPos", () => {
  it("ohne Versatz identisch zur Standardlage", () => {
    const f = dimTextFrame(A, B, 0.5, H);
    const p = dimTextPos(A, B, 0.5, H, undefined);
    expect(p).toEqual(f.base);
  });

  it("Versatz wirkt entlang der Leserichtung und quer dazu", () => {
    const p = dimTextPos(A, B, 0, H, { along: 1, perp: 2 });
    const f = dimTextFrame(A, B, 0, H);
    expect(p.x).toBeCloseTo(f.base.x + 1, 9);
    expect(p.y).toBeCloseTo(f.base.y + 2, 9);
  });
});

describe("dimTextOffsetFromPoint — Verschieben mit Einrasten", () => {
  it("nahe der Standardlage rastet BEIDES auf 0 ein", () => {
    const f = dimTextFrame(A, B, 0, H);
    const near = { x: f.base.x + H * 0.2, y: f.base.y - H * 0.2 };
    expect(dimTextOffsetFromPoint(A, B, 0, H, near)).toEqual({ along: 0, perp: 0 });
  });

  it("die Achsen rasten UNABHÄNGIG ein (seitlich verschoben, Höhe exakt Standard)", () => {
    const f = dimTextFrame(A, B, 0, H);
    const pt = { x: f.base.x + 1.5, y: f.base.y + H * 0.1 };
    const o = dimTextOffsetFromPoint(A, B, 0, H, pt);
    expect(o.along).toBeCloseTo(1.5, 9);
    expect(o.perp).toBe(0);
  });

  it("ausserhalb des Fangbereichs bleibt der gezogene Wert erhalten", () => {
    const f = dimTextFrame(A, B, 0, H);
    const pt = { x: f.base.x + 0.8, y: f.base.y + 0.6 };
    const o = dimTextOffsetFromPoint(A, B, 0, H, pt);
    expect(o.along).toBeCloseTo(0.8, 9);
    expect(o.perp).toBeCloseTo(0.6, 9);
  });

  it("Rundreise: gezogene Position → Versatz → Position ergibt wieder den Punkt", () => {
    const pt = { x: 3.1, y: 1.4 };
    const o = dimTextOffsetFromPoint(A, B, 0.5, H, pt);
    const back = dimTextPos(A, B, 0.5, H, o);
    expect(back.x).toBeCloseTo(pt.x, 9);
    expect(back.y).toBeCloseTo(pt.y, 9);
  });
});

describe("mmToModel/modelToMm — Papier-mm ↔ Modellmass", () => {
  it("bei 1:50 entsprechen die Defaults exakt den früheren festen Modellwerten", () => {
    expect(mmToModel(DIM_DEFAULTS_MM.gap, 50)).toBeCloseTo(0.05, 12);
    expect(mmToModel(DIM_DEFAULTS_MM.overshoot, 50)).toBeCloseTo(0.05, 12);
    expect(mmToModel(DIM_DEFAULTS_MM.tickLen, 50)).toBeCloseTo(0.15, 12);
    expect(mmToModel(DIM_DEFAULTS_MM.textHeight, 50)).toBeCloseTo(0.2, 12);
  });

  it("derselbe Papierwert ergibt bei anderem Massstab andere Modellmasse", () => {
    // 2 mm Papier: bei 1:50 = 10 cm im Modell, bei 1:100 = 20 cm.
    expect(mmToModel(2, 50)).toBeCloseTo(0.1, 12);
    expect(mmToModel(2, 100)).toBeCloseTo(0.2, 12);
  });

  it("Rundreise mm → Modell → mm ist verlustfrei", () => {
    for (const scale of [20, 50, 100, 200]) {
      expect(modelToMm(mmToModel(2.5, scale), scale)).toBeCloseTo(2.5, 12);
    }
  });
});
