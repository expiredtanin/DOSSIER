// Bilder auf Layout-Blättern ([208]): Einlesen (Format am Dateikopf), Seitenverhältnis, Zuschnitt, Listen-Änderungen.
import { describe, expect, it } from "vitest";
import type { Layout } from "./types";
import {
  addImage,
  bytesToDataUrl,
  createLayoutImage,
  cropImage,
  dataUrlToBytes,
  imageAspect,
  imageGeometry,
  imageInfo,
  patchImage,
  removeImage,
  resizeImageWidth,
} from "./layoutImages";
import { JPEG_64X48, PNG_40X30, PNG_40X30_ALPHA } from "./layoutImages.testing";

const A1 = { w: 841, h: 594 };
const layout = (): Layout => ({ id: "l1", name: "Blatt", paper: "a1", orientation: "landscape", viewports: [] });

describe("Blatt-Bilder", () => {
  it("liest Format und Pixelgrösse aus dem Dateikopf", () => {
    expect(imageInfo(bytesToDataUrl(JPEG_64X48, "image/jpeg"))).toEqual({ mime: "image/jpeg", width: 64, height: 48 });
    expect(imageInfo(bytesToDataUrl(PNG_40X30, "image/png"))).toEqual({ mime: "image/png", width: 40, height: 30 });
    expect(imageInfo(bytesToDataUrl(PNG_40X30_ALPHA, "image/png"))?.width).toBe(40);
    expect(imageInfo("data:image/gif;base64,R0lGODlhAQABAAAAACw=")).toBeNull();
  });

  it("Data-URL und Bytes sind verlustfrei austauschbar", () => {
    expect(dataUrlToBytes(bytesToDataUrl(JPEG_64X48, "image/jpeg"))).toEqual(JPEG_64X48);
  });

  it("neues Bild liegt mittig, im Seitenverhältnis, und die Dateiendung zählt nicht", () => {
    // JPEG-Bytes mit PNG-Hinweis: der Kopf entscheidet
    const img = createLayoutImage("i1", "foto.png", JPEG_64X48, A1, "image/png")!;
    expect(img.src.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect([img.pixelWidth, img.pixelHeight]).toEqual([64, 48]);
    expect(img.widthMm / img.heightMm).toBeCloseTo(64 / 48, 1);
    expect(img.widthMm).toBeLessThanOrEqual(841 * 0.6 + 0.1);
    expect(img.xMm + img.widthMm / 2).toBeCloseTo(420.5, 0);
    expect(img.yMm + img.heightMm / 2).toBeCloseTo(297, 0);
  });

  it("weist Unbrauchbares ab", () => {
    expect(createLayoutImage("i", "x", new Uint8Array([1, 2, 3]), A1)).toBeNull();
    expect(createLayoutImage("i", "x", new Uint8Array(), A1)).toBeNull();
  });

  it("Breite ändern hält das Seitenverhältnis, Zuschnitt ändert es", () => {
    const img = createLayoutImage("i1", "a", PNG_40X30, A1)!;
    const r = resizeImageWidth(img, 200);
    expect(r).toEqual({ widthMm: 200, heightMm: 150 });
    // linke Hälfte: 20×30 px → Verhältnis 2/3
    const c = cropImage({ ...img, ...r }, { x: 0, y: 0, w: 0.5, h: 1 });
    expect(c.widthMm).toBe(200);
    expect(c.heightMm).toBe(300);
    expect(imageAspect({ ...img, crop: c.crop })).toBeCloseTo(2 / 3, 6);
  });

  it("Zeichen-Rechteck füllt mit Zuschnitt den Rahmen; dpi folgt der Grösse", () => {
    const img = { ...createLayoutImage("i1", "a", PNG_40X30, A1)!, xMm: 100, yMm: 50, widthMm: 100, heightMm: 75 };
    const g = imageGeometry(img);
    expect(g.draw).toEqual(g.clip);
    expect(g.dpi).toBeCloseTo(40 / (100 / 25.4), 6);
    const c = imageGeometry({ ...img, crop: { x: 0.5, y: 0, w: 0.5, h: 1 }, heightMm: 150 });
    expect(c.draw.w).toBe(200);
    expect(c.draw.x).toBe(0);
  });

  it("hängt an, ändert und entfernt Bilder am Blatt", () => {
    const img = createLayoutImage("i1", "a", PNG_40X30, A1)!;
    let l = addImage(layout(), img);
    expect(l.images).toHaveLength(1);
    l = patchImage(l, "i1", { xMm: 5, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } });
    expect(l.images![0].xMm).toBe(5);
    l = patchImage(l, "i1", { crop: undefined });
    expect("crop" in l.images![0]).toBe(false);
    expect(removeImage(l, "i1").images).toEqual([]);
  });
});
