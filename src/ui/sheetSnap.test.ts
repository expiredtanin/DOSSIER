import { describe, expect, it } from "vitest";
import { addGuide, clipToCrop, dragCropClip, guideAt, moveGuide, removeGuide, snapRectToGuides } from "./sheetSnap";

const guides = [
  { axis: "x", posMm: 100 },
  { axis: "x", posMm: 300 },
  { axis: "y", posMm: 50 },
];
const r = (xMm: number, yMm: number, widthMm: number, heightMm: number) => ({ xMm, yMm, widthMm, heightMm });

describe("Fang auf Hilfslinien", () => {
  it("Körper: linke Kante rastet ein, ganze Fläche rutscht", () => {
    const s = snapRectToGuides(r(102, 200, 50, 40), "body", guides, 3);
    expect(s.rect).toEqual(r(100, 200, 50, 40));
    expect(s.hits).toEqual([{ axis: "x", posMm: 100 }]);
  });
  it("Körper: rechte Kante und Mitte fangen auch; ausserhalb der Toleranz nichts", () => {
    expect(snapRectToGuides(r(248, 0, 50, 40), "body", guides, 3).rect.xMm).toBe(250); // rechte Kante 298 → 300
    expect(snapRectToGuides(r(276, 0, 50, 40), "body", guides, 3).rect.xMm).toBe(275); // Mitte 301 → 300
    expect(snapRectToGuides(r(175, 0, 50, 40), "body", guides, 3).rect.xMm).toBe(175);
    expect(snapRectToGuides(r(104, 0, 50, 40), "body", guides, 3).rect.xMm).toBe(104);
  });
  it("Körper: waagrechte Linie fängt oben/Mitte/unten", () => {
    expect(snapRectToGuides(r(0, 31, 50, 40), "body", guides, 3).rect.yMm).toBe(30); // Mitte 51 → 50
  });
  it("Griff: nur die bewegte Kante rastet, die feste bleibt", () => {
    const s = snapRectToGuides(r(40, 10, 62, 40), "e", guides, 3); // rechte Kante 102 → 100
    expect(s.rect).toEqual(r(40, 10, 60, 40));
    const w = snapRectToGuides(r(98, 10, 52, 40), "w", guides, 3); // linke Kante 98 → 100, rechts 150 fix
    expect(w.rect).toEqual(r(100, 10, 50, 40));
  });
  it("Griff: Mindestgrösse verhindert einen Fang, der das Rechteck zusammenfallen liesse", () => {
    const s = snapRectToGuides(r(40, 10, 62, 40), "e", [{ axis: "x", posMm: 42 }], 3, { minMm: 8 });
    expect(s.rect.widthMm).toBe(62);
  });
  it("Bild-Ecke mit festem Seitenverhältnis: Höhe folgt der Breite", () => {
    const s = snapRectToGuides(r(0, 0, 98, 49), "se", guides, 3, { keepAspect: 2 });
    expect(s.rect.widthMm).toBe(100);
    expect(s.rect.heightMm).toBe(50);
    const t = snapRectToGuides(r(0, 0, 90, 48), "se", [{ axis: "y", posMm: 50 }], 3, { keepAspect: 2 });
    expect(t.rect.heightMm).toBe(50);
    expect(t.rect.widthMm).toBe(100);
  });
  it("ohne Hilfslinien oder Toleranz 0 bleibt alles", () => {
    expect(snapRectToGuides(r(101, 0, 5, 5), "body", undefined, 3).rect).toEqual(r(101, 0, 5, 5));
    expect(snapRectToGuides(r(101, 0, 5, 5), "body", guides, 0).hits).toEqual([]);
  });
});

describe("Hilfslinien ändern", () => {
  it("anfügen ohne Doppelte, runden", () => {
    expect(addGuide(undefined, "x", 12.3456)).toEqual([{ axis: "x", posMm: 12.35 }]);
    expect(addGuide([{ axis: "x", posMm: 10 }], "x", 10)).toHaveLength(1);
    expect(addGuide([{ axis: "x", posMm: 10 }], "y", 10)).toHaveLength(2);
  });
  it("entfernen und verschieben", () => {
    expect(removeGuide(guides, 1)).toEqual([guides[0], guides[2]]);
    expect(moveGuide(guides, 0, 120)[0]).toEqual({ axis: "x", posMm: 120 });
    expect(moveGuide(guides, 0, 300)).toEqual([{ axis: "x", posMm: 300 }, guides[2]]);
  });
  it("greifen: nächste Linie in Reichweite", () => {
    expect(guideAt(guides, 101, 0, 2)).toBe(0);
    expect(guideAt(guides, 0, 51, 2)).toBe(2);
    expect(guideAt(guides, 200, 0, 2)).toBe(-1);
  });
});

describe("Bild-Zuschnitt durch Ziehen", () => {
  const draw = r(0, 0, 200, 100);
  it("Kante ziehen: Ausschnitt schrumpft, Original bleibt", () => {
    const c = dragCropClip(draw, draw, "w", 50, 0);
    expect(c).toEqual(r(50, 0, 150, 100));
    expect(clipToCrop(draw, c)).toEqual({ x: 0.25, y: 0, w: 0.75, h: 1 });
  });
  it("nie über das Original hinaus und nie unter die Mindestgrösse", () => {
    expect(dragCropClip(draw, r(50, 0, 150, 100), "w", -80, 0).xMm).toBe(0);
    const tiny = dragCropClip(draw, draw, "e", -500, 0);
    expect(tiny.xMm).toBe(0);
    expect(tiny.widthMm).toBeCloseTo(4);
    expect(dragCropClip(draw, draw, "s", 500, 0).heightMm).toBe(100);
  });
  it("Ecke zieht zwei Kanten; Körper verschiebt den Ausschnitt im Original", () => {
    expect(dragCropClip(draw, draw, "nw", 20, 10)).toEqual(r(20, 10, 180, 90));
    expect(dragCropClip(draw, r(0, 0, 100, 50), "body", 500, 500)).toEqual(r(100, 50, 100, 50));
  });
  it("ganzes Original = kein Zuschnitt", () => {
    expect(clipToCrop(draw, draw)).toBeUndefined();
    expect(clipToCrop(draw, r(0, 0, 100, 100))).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
  });
});
