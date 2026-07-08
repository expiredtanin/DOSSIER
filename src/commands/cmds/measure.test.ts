import { describe, it, expect } from "vitest";
import { measureCommand } from "./measure";
import type { CommandContext, Vec2 } from "../types";

// Der Kontext wird vom Mess-Werkzeug nicht gelesen (rein visuell) — Dummy genügt.
const ctx = {} as CommandContext;
const P = (x: number, y: number): Vec2 => ({ x, y });

describe("measureCommand", () => {
  it("misst Segment + Winkel ab dem ersten Punkt", () => {
    const s0 = measureCommand.init();
    const [s1] = measureCommand.onInput(s0, { kind: "point", point: P(0, 0) }, ctx);
    const [, r] = measureCommand.onMove(s1, P(3, 0), null, ctx);
    expect(r.draft?.measure?.segment).toBeCloseTo(3, 6);
    expect(r.draft?.measure?.angle).toBeCloseTo(0, 6);
    expect(r.draft?.measure?.area).toBeNull();
    expect(r.draft?.measure?.points).toBe(1);
  });

  it("summiert die Pfadlänge und zeigt die Fläche ab 3 Ecken", () => {
    let s = measureCommand.init();
    [s] = measureCommand.onInput(s, { kind: "point", point: P(0, 0) }, ctx);
    [s] = measureCommand.onInput(s, { kind: "point", point: P(4, 0) }, ctx);
    [s] = measureCommand.onInput(s, { kind: "point", point: P(4, 3) }, ctx);
    // Cursor zurück Richtung Ursprung → geschlossenes Dreieck 4×3/2 = 6 m².
    const [, r] = measureCommand.onMove(s, P(0, 0), null, ctx);
    expect(r.draft?.measure?.total).toBeCloseTo(4 + 3 + 5, 6); // 0→4→3→Hypotenuse 5
    expect(r.draft?.measure?.area).toBeCloseTo(6, 6);
    expect(r.draft?.measure?.points).toBe(3);
  });

  it("Rechtsklick beendet den Pfad und armiert einen neuen (kein done)", () => {
    let s = measureCommand.init();
    [s] = measureCommand.onInput(s, { kind: "point", point: P(1, 1) }, ctx);
    const [ns, r] = measureCommand.onConfirm(s, ctx);
    expect(r.done).not.toBe(true);
    expect((ns as { phase: string }).phase).toBe("start");
    expect(r.draft).toBeNull();
  });

  it("Rechtsklick auf leerem Pfad beendet das Werkzeug", () => {
    const s = measureCommand.init();
    const [, r] = measureCommand.onConfirm(s, ctx);
    expect(r.done).toBe(true);
  });
});
