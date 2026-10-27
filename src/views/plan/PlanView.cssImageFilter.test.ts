// `cssImageFilter` baut die CSS-`filter`-Kette für ein Hintergrund-Luftbild
// aus `ContextImage.filters` (Sättigung/Helligkeit/Kontrast/Graustufen, s.
// PENDENZEN.md „Bildschraffur: Bild-Filter"). Reiner Helfer, kein React nötig.

import { describe, it, expect } from "vitest";
import { cssImageFilter } from "./PlanView";

describe("cssImageFilter", () => {
  it("liefert undefined bei fehlenden filters (kein style-Attribut nötig)", () => {
    expect(cssImageFilter(undefined)).toBeUndefined();
  });

  it("liefert undefined bei ausschliesslich neutralen Werten (1/1/1/0)", () => {
    expect(cssImageFilter({ saturation: 1, brightness: 1, contrast: 1, grayscale: 0 })).toBeUndefined();
  });

  it("liefert undefined bei leerem filters-Objekt (alle Defaults greifen)", () => {
    expect(cssImageFilter({})).toBeUndefined();
  });

  it("baut nur die tatsächlich abweichenden Filter-Funktionen", () => {
    expect(cssImageFilter({ saturation: 0.5 })).toBe("saturate(0.5)");
    expect(cssImageFilter({ brightness: 1.3 })).toBe("brightness(1.3)");
    expect(cssImageFilter({ contrast: 1.2 })).toBe("contrast(1.2)");
    expect(cssImageFilter({ grayscale: 0.8 })).toBe("grayscale(0.8)");
  });

  it("kombiniert mehrere abweichende Werte in EINEM filter-String", () => {
    expect(cssImageFilter({ saturation: 0, grayscale: 1 })).toBe("saturate(0) grayscale(1)");
  });

  it("volle Kombination aller vier Werte, in fester Reihenfolge", () => {
    expect(
      cssImageFilter({ saturation: 0.5, brightness: 1.2, contrast: 1.1, grayscale: 0.3 }),
    ).toBe("saturate(0.5) brightness(1.2) contrast(1.1) grayscale(0.3)");
  });
});
