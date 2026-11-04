import { describe, expect, it } from "vitest";
import type { DrawingLevel } from "../model/types";
import { elevationFix } from "./InlineEditors";

const lv = (id: string, base: number, h: number, zero = false) =>
  ({ id, name: id, kind: "floor", visible: true, locked: false, baseElevation: base, floorHeight: h, ...(zero ? { zeroLevel: true } : {}) }) as unknown as DrawingLevel;
const levels = [lv("ug", -2.7, 2.7), lv("eg", 0, 2.9, true), lv("og", 2.9, 2.8)];

describe("[131] Geschosshöhe direkt setzen", () => {
  it("über ±0.00: Geschosshöhe darunter passt sich an", () => {
    expect(elevationFix(levels, "og", 3.1)).toEqual({ id: "eg", floorHeight: 3.1 });
  });
  it("unter ±0.00: eigene Geschosshöhe passt sich an", () => {
    expect(elevationFix(levels, "ug", -3)).toEqual({ id: "ug", floorHeight: 3 });
  });
  it("Bezugsgeschoss, gleiche Höhe und Unsinn: nichts", () => {
    expect(elevationFix(levels, "eg", 1)).toBeNull();
    expect(elevationFix(levels, "og", 2.9)).toBeNull();
    expect(elevationFix(levels, "og", -1)).toBeNull();
    expect(elevationFix(levels, "og", Number.NaN)).toBeNull();
  });
});
