// Reine (netzwerkfreie) Bausteine des SWISSIMAGE-Imports: WMS-URL-Bau +
// Pixelgrössen-Deckelung. Der Fetch selbst bleibt ungetestet (kein Fetch-
// Mocking im Repo, analog swissTopo/swissAlti3d).

import { describe, it, expect } from "vitest";
import {
  buildSwissImageUrl,
  imagePixelSize,
  sampleColorsFromImageData,
} from "./swissImage";

describe("buildSwissImageUrl", () => {
  it("baut eine WMS-1.1.1-GetMap-URL mit EPSG:2056 und E,N-bbox-Reihenfolge", () => {
    const url = buildSwissImageUrl([2600000, 1200000, 2600400, 1200400], 2000, 2000);
    expect(url).toContain("SERVICE=WMS");
    expect(url).toContain("VERSION=1.1.1");
    expect(url).toContain("REQUEST=GetMap");
    expect(url).toContain("LAYERS=ch.swisstopo.swissimage");
    expect(url).toContain("SRS=EPSG%3A2056");
    // bbox in E,N: eMin,nMin,eMax,nMax.
    expect(url).toContain("BBOX=2600000%2C1200000%2C2600400%2C1200400");
    expect(url).toContain("WIDTH=2000");
    expect(url).toContain("HEIGHT=2000");
    expect(url).toContain("FORMAT=image%2Fjpeg");
  });
});

describe("imagePixelSize", () => {
  it("skaliert mit der Spannweite (~0.2 m/px)", () => {
    expect(imagePixelSize(400)).toBe(2000); // 400 m / 0.2
  });
  it("deckelt bei der Maximalgrösse", () => {
    expect(imagePixelSize(100000)).toBe(2500);
  });
  it("hat eine sinnvolle Untergrenze", () => {
    expect(imagePixelSize(1)).toBe(64);
  });
});

describe("sampleColorsFromImageData (Luftbild-Drape)", () => {
  // 2×2-Bild: oben-links rot, oben-rechts grün, unten-links blau, unten-rechts weiss.
  // Reihenfolge im RGBA-Puffer ist zeilenweise von OBEN (Zeile 0 = Nord/+Y).
  const W = 2;
  const H = 2;
  const px = new Uint8ClampedArray([
    255, 0, 0, 255, /* (0,0) rot */ 0, 255, 0, 255, /* (1,0) grün */
    0, 0, 255, 255, /* (0,1) blau */ 255, 255, 255, 255, /* (1,1) weiss */
  ]);
  const min = { x: 0, y: 0 };
  const max = { x: 10, y: 10 };

  it("mappt die Modell-Ecken auf die richtigen Bildpixel (Nord = Bild-oben)", () => {
    // NW (x=0,y=10) -> Bild oben-links = rot; NE (10,10) -> oben-rechts = grün;
    // SW (0,0) -> unten-links = blau; SE (10,0) -> unten-rechts = weiss.
    const positions = [
      0, 10, 0, // NW
      10, 10, 0, // NE
      0, 0, 0, // SW
      10, 0, 0, // SE
    ];
    const c = sampleColorsFromImageData(px, W, H, positions, min, max);
    expect(c.slice(0, 3)).toEqual([1, 0, 0]); // rot
    expect(c.slice(3, 6)).toEqual([0, 1, 0]); // grün
    expect(c.slice(6, 9)).toEqual([0, 0, 1]); // blau
    expect(c.slice(9, 12)).toEqual([1, 1, 1]); // weiss
  });

  it("klemmt Vertices ausserhalb der Bildbox auf den Randpixel", () => {
    const c = sampleColorsFromImageData(px, W, H, [-100, 100, 0], min, max);
    // x<min, y>max -> u=0, v=1 -> Bild oben-links = rot.
    expect(c).toEqual([1, 0, 0]);
  });
});
