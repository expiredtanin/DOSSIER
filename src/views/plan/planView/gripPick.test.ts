import { describe, expect, it } from "vitest";
import { pickGripIndex } from "./gripPick";

// Stütze 12 cm: Mitte (Index 0) und Ecke (Index 1) nur 7 px auseinander.
const col = [{ x: 100, y: 100 }, { x: 107, y: 100 }, { x: 93, y: 100 }];

describe("pickGripIndex", () => {
  it("Klick auf die Ecke trifft die Ecke, nicht die Mitte", () => {
    expect(pickGripIndex(col, 107, 100, 9)).toBe(1);
    expect(pickGripIndex(col, 93, 101, 9)).toBe(2);
  });
  it("Klick auf die Mitte trifft die Mitte", () => {
    expect(pickGripIndex(col, 100, 100, 9)).toBe(0);
  });
  it("praktisch gleich nah: Ecke (höherer Index) vor Mitte", () => {
    expect(pickGripIndex(col, 103.5, 100, 9)).toBe(1);
  });
  it("ausserhalb des Radius: null", () => {
    expect(pickGripIndex(col, 140, 100, 9)).toBeNull();
    expect(pickGripIndex([], 0, 0, 9)).toBeNull();
  });
});
