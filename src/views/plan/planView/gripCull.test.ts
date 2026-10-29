import { describe, expect, it } from "vitest";
import { GRIP_CULL_FROM, GRIP_DRAW_MAX, visibleGripIndices } from "./gripCull";

const id = (p: { x: number; y: number }) => p;

describe("visibleGripIndices", () => {
  it("wenige Griffe: alle zeichnen (normale Pläne unverändert)", () => {
    const pts = [{ x: 1e9, y: 1e9 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
    expect(visibleGripIndices(pts, id, { x: 0, y: 0, w: 10, h: 10 }, 1)).toBeNull();
  });

  it("viele Griffe: nur die im Ausschnitt (mit Rand), in Reihenfolge", () => {
    // Kataster in LV95 (viewBox-Einheiten = Meter · 90): Griffe entlang einer langen Strasse.
    const pts = Array.from({ length: GRIP_CULL_FROM + 100 }, (_, i) => ({ x: 2.34e8 + i * 100, y: -1.08e8 }));
    const view = { x: 2.34e8, y: -1.08e8 - 500, w: 1000, h: 1000 };
    const idx = visibleGripIndices(pts, id, view, 1)!;
    expect(idx).not.toBeNull();
    expect(idx[0]).toBe(0);
    // Ausschnitt 1000 breit, Rand = max(w, h) je Seite → x bis 2.34e8 + 2000 → Index 0..20.
    expect(idx).toEqual(Array.from({ length: 21 }, (_, i) => i));
  });

  it("dicht liegende Griffe werden je Bildschirmzelle nur einmal gezeichnet", () => {
    const pts = Array.from({ length: GRIP_CULL_FROM + 1 }, (_, i) => ({ x: i * 0.01, y: 0 }));
    // meet 1 px/Einheit: 0.01 Einheiten Abstand → alle in derselben 3-px-Zelle (bis auf Zellgrenzen).
    const idx = visibleGripIndices(pts, id, { x: 0, y: -50, w: 100, h: 100 }, 1)!;
    expect(idx.length).toBeLessThan(10);
    expect(idx[0]).toBe(0);
  });

  it("Obergrenze der gezeichneten Griffe", () => {
    const n = GRIP_DRAW_MAX * 2;
    const pts = Array.from({ length: n }, (_, i) => ({ x: (i % 1000) * 10, y: Math.floor(i / 1000) * 10 }));
    const idx = visibleGripIndices(pts, id, { x: 0, y: 0, w: 10_000, h: 10_000 }, 1)!;
    expect(idx.length).toBe(GRIP_DRAW_MAX);
  });

  it("unsinniger Massstab: nichts verwerfen ausser ausserhalb", () => {
    const pts = Array.from({ length: GRIP_CULL_FROM + 1 }, (_, i) => ({ x: i, y: 0 }));
    const idx = visibleGripIndices(pts, id, { x: 0, y: -10, w: 10_000, h: 20 }, Number.NaN)!;
    expect(idx.length).toBe(GRIP_CULL_FROM + 1);
  });
});
