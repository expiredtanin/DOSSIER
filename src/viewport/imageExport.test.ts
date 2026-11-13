import { describe, expect, it } from "vitest";
import { IMAGE_MAX_EDGE, clampImageSize, imageFileName, isBlankImage, matteFromBlackWhite } from "./imageExport";

describe("[223] Bild-Export 3D", () => {
  it("Zielgrösse: unverändert, begrenzt mit Seitenverhältnis, Unsinn wird 16 px", () => {
    expect(clampImageSize(3840, 2160)).toEqual({ width: 3840, height: 2160, clamped: false });
    const a1 = clampImageSize(9933, 7016);
    expect(a1.clamped).toBe(true);
    expect(Math.max(a1.width, a1.height)).toBe(IMAGE_MAX_EDGE);
    expect(a1.width / a1.height).toBeCloseTo(9933 / 7016, 2);
    expect(clampImageSize(NaN, -5)).toEqual({ width: 16, height: 16, clamped: false });
  });

  it("transparenter Hintergrund: deckend bleibt, Hintergrund wird 0, halbdeckend wird rekonstruiert", () => {
    // Pixel 0: deckendes Rot, 1: reiner Hintergrund, 2: 50 % Blau (Farbe 0,0,255).
    const black = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 128, 255]);
    const white = new Uint8ClampedArray([255, 0, 0, 255, 255, 255, 255, 255, 128, 128, 255, 255]);
    matteFromBlackWhite(black, white);
    expect([...black.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...black.slice(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(black[11]).toBeGreaterThan(120);
    expect(black[11]).toBeLessThan(135);
    expect(black[10]).toBeGreaterThan(245);
  });

  it("leeres Bild erkennen, Dateiname", () => {
    expect(isBlankImage(new Uint8ClampedArray(64))).toBe(true);
    expect(isBlankImage(new Uint8ClampedArray([200, 100, 50, 255, 0, 0, 0, 0]))).toBe(false);
    expect(imageFileName("Haus Süd", 4000, 3000)).toBe("Haus_S_d-3d-4000x3000.png");
  });
});
