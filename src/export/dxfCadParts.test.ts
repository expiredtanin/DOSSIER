import { describe, expect, it } from "vitest";
import { dashToLtypeMeters, fontNameOf, ltypeNameFor, paperFor, primitiveToLocal, roundKey } from "./dxfCadParts";
import type { LineStyle } from "../model/types";
import type { Primitive } from "../plan/generatePlan";

describe("fontNameOf", () => {
  it("erste echte Familie, ohne Anführungszeichen; generische/Variablen übersprungen", () => {
    expect(fontNameOf('"Helvetica Neue", Arial, sans-serif')).toBe("Helvetica Neue");
    expect(fontNameOf("var(--font-ui, sans-serif)")).toBeNull();
    expect(fontNameOf("sans-serif, Arial")).toBe("Arial");
    expect(fontNameOf("'Source Sans 3'")).toBe("Source Sans 3");
    expect(fontNameOf(undefined)).toBeNull();
    expect(fontNameOf("")).toBeNull();
  });
});

describe("Linientypen", () => {
  it("Papier-mm × Massstab → Meter (Strich +, Lücke −); ungerade Muster werden verdoppelt", () => {
    expect(dashToLtypeMeters([3, 1], 100)!.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.3, -0.1]);
    expect(dashToLtypeMeters([2, 1, 0.5], 50)!.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.1, -0.05, 0.025, -0.1, 0.05, -0.025]);
    expect(dashToLtypeMeters([], 100)).toBeNull();
    expect(dashToLtypeMeters([0, 0], 100)).toBeNull();
    // Punkt (Strich 0) bleibt 0, Lücke nie 0
    const dot = dashToLtypeMeters([0, 0], 100);
    expect(dot).toBeNull();
    expect(dashToLtypeMeters([0, 1], 100)![0]).toBe(0);
  });

  it("Name: Projekt-Linienstil mit gleichem Muster, sonst DOSSIER_STRICH_…", () => {
    const styles = [{ id: "a", name: " Strichlinie ", weight: 0.1, color: "#000", dash: [3, 1] }] as LineStyle[];
    expect(ltypeNameFor([3, 1], styles)).toBe("Strichlinie");
    expect(ltypeNameFor([2, 0.5], styles)).toBe("DOSSIER_STRICH_2_0.5");
  });
});

describe("Papierbereich", () => {
  it("kleinstes Format, das den Ausschnitt samt Rand aufnimmt", () => {
    // 20 m × 12 m bei 1:100 = 200 × 120 mm + 20 mm Rand → A4 quer
    expect(paperFor(20, 12, 100)).toMatchObject({ name: "A4", paperW: 297, paperH: 210, vpW: 277, vpH: 190 });
    // 30 m × 18 m bei 1:100 → 300 × 180 (+20): A3
    expect(paperFor(30, 18, 100).name).toBe("A3");
    // Hochformat, wenn nur so passend
    expect(paperFor(12, 20, 100)).toMatchObject({ name: "A4", paperW: 210, paperH: 297 });
    // grösser als A0: Sonderformat in 10-mm-Schritten
    const big = paperFor(200, 100, 50);
    expect(big.name).toBe("Sonder");
    expect(big.paperW % 10).toBe(0);
  });
});

describe("primitiveToLocal", () => {
  const frame = { origin: { x: 10, y: 5 }, rot: Math.PI / 2, scale: 2 };
  it("Linie, Bogen, Kreis, Text: verschoben, gedreht, skaliert", () => {
    const line = { kind: "line", a: { x: 10, y: 5 }, b: { x: 10, y: 9 }, cls: "x", weightMm: 0.1 } as Primitive;
    const l = primitiveToLocal(line, frame) as Extract<Primitive, { kind: "line" }>;
    expect(l.a.x).toBeCloseTo(0, 12);
    expect(l.a.y).toBeCloseTo(0, 12);
    expect(l.b.x).toBeCloseTo(2, 12); // 4 m in Richtung +y = lokale +x, durch Skalierung 2
    expect(l.b.y).toBeCloseTo(0, 12);
    const text = { kind: "drawingText", at: { x: 10, y: 5 }, text: "a", heightM: 0.4, angle: Math.PI / 2, color: "#000" } as Primitive;
    const t = primitiveToLocal(text, frame) as Extract<Primitive, { kind: "drawingText" }>;
    expect(t.heightM).toBeCloseTo(0.2, 12);
    expect(t.angle).toBeCloseTo(0, 12);
    const circle = { kind: "drawingCircle", center: { x: 10, y: 7 }, r: 1, fill: "none", stroke: "#000", weightMm: 0.1 } as Primitive;
    const c = primitiveToLocal(circle, frame) as Extract<Primitive, { kind: "drawingCircle" }>;
    expect(c.r).toBeCloseTo(0.5, 12);
    expect(c.center.x).toBeCloseTo(1, 12);
  });
  it("andere Primitivarten (Raumstempel, Bild) gehören nicht in Blöcke", () => {
    expect(primitiveToLocal({ kind: "drawingImage" } as Primitive, frame)).toBeNull();
  });
  it("roundKey: auf 1 mm gerundet", () => {
    expect(roundKey([1.0001, 2])).toBe(roundKey([1.0004, 2]));
    expect(roundKey([1.0001, 2])).not.toBe(roundKey([1.002, 2]));
  });
});
