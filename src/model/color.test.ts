import { describe, expect, it } from "vitest";
import {
  cmykToRgb,
  hexToRgb,
  hslToRgb,
  hsvToRgb,
  rgbToCmyk,
  rgbToHex,
  rgbToHsl,
  rgbToHsv,
  MATERIAL_PALETTE,
  RAL_CLASSIC,
  TANGO_PALETTE,
} from "./color";

describe("hexToRgb/rgbToHex", () => {
  it("löst 6-stelliges Hex korrekt auf", () => {
    expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb("#00ff80")).toEqual({ r: 0, g: 255, b: 128 });
  });

  it("löst 3-stelliges Kurz-Hex auf", () => {
    expect(hexToRgb("#f00")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("rgbToHex ist die Umkehrung von hexToRgb (Rundreise)", () => {
    for (const hex of ["#123456", "#abcdef", "#000000", "#ffffff"]) {
      expect(rgbToHex(hexToRgb(hex))).toBe(hex);
    }
  });

  it("rgbToHex klammert ausserhalb 0..255", () => {
    expect(rgbToHex({ r: -10, g: 300, b: 128 })).toBe("#00ff80");
  });
});

describe("rgbToCmyk/cmykToRgb", () => {
  it("Schwarz → k=100, c=m=y=0", () => {
    expect(rgbToCmyk({ r: 0, g: 0, b: 0 })).toEqual({ c: 0, m: 0, y: 0, k: 100 });
  });

  it("Weiss → alle 0", () => {
    expect(rgbToCmyk({ r: 255, g: 255, b: 255 })).toEqual({ c: 0, m: 0, y: 0, k: 0 });
  });

  it("Reinrot → kein Cyan, k=0", () => {
    const cmyk = rgbToCmyk({ r: 255, g: 0, b: 0 });
    expect(cmyk.c).toBe(0);
    expect(cmyk.k).toBe(0);
    expect(cmyk.m).toBe(100);
    expect(cmyk.y).toBe(100);
  });

  it("Rundreise RGB → CMYK → RGB bleibt (nach Rundung) nah am Original", () => {
    for (const rgb of [
      { r: 200, g: 100, b: 50 },
      { r: 10, g: 200, b: 230 },
      { r: 128, g: 128, b: 128 },
    ]) {
      const back = cmykToRgb(rgbToCmyk(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(3);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(3);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(3);
    }
  });
});

describe("RAL_CLASSIC", () => {
  it("jeder Eintrag hat eindeutigen Code + gültiges 6-stelliges Hex", () => {
    const seen = new Set<string>();
    for (const ral of RAL_CLASSIC) {
      expect(seen.has(ral.code)).toBe(false);
      seen.add(ral.code);
      expect(ral.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(ral.name.length).toBeGreaterThan(0);
    }
  });

  it("enthält eine substanzielle Auswahl über alle RAL-Klassen (1000er-9000er)", () => {
    const groups = new Set(RAL_CLASSIC.map((r) => r.code[0]));
    for (const g of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      expect(groups.has(g)).toBe(true);
    }
    expect(RAL_CLASSIC.length).toBeGreaterThan(100);
  });
});

describe("TANGO_PALETTE", () => {
  it("27 Einträge (9 Farbfamilien × 3 Helligkeitsstufen), alle gültiges Hex", () => {
    expect(TANGO_PALETTE.length).toBe(27);
    for (const c of TANGO_PALETTE) {
      expect(c.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  it("keine doppelten Hex-Werte", () => {
    const seen = new Set(TANGO_PALETTE.map((c) => c.hex.toLowerCase()));
    expect(seen.size).toBe(TANGO_PALETTE.length);
  });
});

describe("MATERIAL_PALETTE", () => {
  it("19 Farbfamilien × 3 Stufen (100/500/900), alle gültiges Hex", () => {
    expect(MATERIAL_PALETTE.length).toBe(57);
    for (const c of MATERIAL_PALETTE) {
      expect(c.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(c.name).toMatch(/ (100|500|900)$/);
    }
  });

  it("keine doppelten Hex-Werte", () => {
    const seen = new Set(MATERIAL_PALETTE.map((c) => c.hex.toLowerCase()));
    expect(seen.size).toBe(MATERIAL_PALETTE.length);
  });
});

describe("rgbToHsl/hslToRgb", () => {
  it("Grundfarben haben die erwarteten Farbtöne", () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 });
    expect(rgbToHsl({ r: 0, g: 255, b: 0 }).h).toBe(120);
    expect(rgbToHsl({ r: 0, g: 0, b: 255 }).h).toBe(240);
  });

  it("unbunte Farben: Sättigung 0 (Farbton ist dort undefiniert)", () => {
    expect(rgbToHsl({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, l: 100 });
    expect(rgbToHsl({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, l: 0 });
    expect(rgbToHsl({ r: 128, g: 128, b: 128 }).s).toBe(0);
  });

  it("Rundreise RGB → HSL → RGB bleibt nah am Original", () => {
    for (const rgb of [
      { r: 200, g: 100, b: 50 },
      { r: 10, g: 200, b: 230 },
      { r: 128, g: 128, b: 128 },
      { r: 0, g: 0, b: 0 },
    ]) {
      const back = hslToRgb(rgbToHsl(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(3);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(3);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(3);
    }
  });
});

describe("rgbToHsv/hsvToRgb", () => {
  it("Reinrot ist h=0, s=100, v=100; Schwarz hat v=0", () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, v: 100 });
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
  });

  it("Rundreise RGB → HSV → RGB bleibt nah am Original", () => {
    for (const rgb of [
      { r: 200, g: 100, b: 50 },
      { r: 10, g: 200, b: 230 },
      { r: 255, g: 255, b: 255 },
    ]) {
      const back = hsvToRgb(rgbToHsv(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(3);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(3);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(3);
    }
  });

  it("HSV und HSL stimmen im Farbton überein", () => {
    const rgb = { r: 40, g: 180, b: 90 };
    expect(rgbToHsv(rgb).h).toBe(rgbToHsl(rgb).h);
  });
});
