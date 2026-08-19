import { describe, expect, it } from "vitest";
import type { LayoutAnnotation, LayoutViewport } from "../model/types";
import {
  annotationBoundsMm,
  annotationHandleAt,
  applyHandleDrag,
  applyLineHandleDrag,
  clampRectToSheet,
  distanceToSegment,
  fitTransform,
  handleAt,
  lineHandleAt,
  mmToScreen,
  normalizeRect,
  panBy,
  pickAnnotation,
  pickAnnotationHandle,
  pickViewport,
  screenToMm,
  translateAnnotation,
  vpRect,
  zoomAtCursor,
  type RectMm,
  type SheetTransform,
} from "./layoutSheetMath";

const vp = (
  id: string,
  xMm: number,
  yMm: number,
  widthMm: number,
  heightMm: number,
): LayoutViewport => ({ id, snapshotId: "s", xMm, yMm, widthMm, heightMm });

describe("mm ↔ screen", () => {
  const t: SheetTransform = { scale: 2, tx: 100, ty: 50 };
  it("mmToScreen applies scale + translate", () => {
    expect(mmToScreen(t, { xMm: 10, yMm: 20 })).toEqual({ x: 120, y: 90 });
  });
  it("screenToMm is the inverse", () => {
    const p = screenToMm(t, 120, 90);
    expect(p.xMm).toBeCloseTo(10);
    expect(p.yMm).toBeCloseTo(20);
  });
  it("roundtrips arbitrary points", () => {
    const s = mmToScreen(t, { xMm: 37.5, yMm: -12.25 });
    const m = screenToMm(t, s.x, s.y);
    expect(m.xMm).toBeCloseTo(37.5);
    expect(m.yMm).toBeCloseTo(-12.25);
  });
});

describe("fitTransform", () => {
  it("centres an A4 portrait sheet in a wide canvas", () => {
    const t = fitTransform(210, 297, 1000, 600, 0.92);
    // Höhe ist der Engpass: scale = 600*0.92/297.
    expect(t.scale).toBeCloseTo((600 * 0.92) / 297);
    // Zentriert: linker Rand = (1000 - 210*scale)/2.
    expect(t.tx).toBeCloseTo((1000 - 210 * t.scale) / 2);
    expect(t.ty).toBeCloseTo((600 - 297 * t.scale) / 2);
  });
  it("falls back to scale 1 on degenerate canvas", () => {
    const t = fitTransform(210, 297, 0, 0);
    expect(t.scale).toBe(1);
  });
});

describe("zoomAtCursor", () => {
  it("keeps the mm point under the cursor fixed", () => {
    const t: SheetTransform = { scale: 2, tx: 100, ty: 50 };
    const cursor = { x: 300, y: 220 };
    const before = screenToMm(t, cursor.x, cursor.y);
    const zt = zoomAtCursor(t, 1.25, cursor.x, cursor.y);
    expect(zt.scale).toBeCloseTo(2.5);
    const after = screenToMm(zt, cursor.x, cursor.y);
    expect(after.xMm).toBeCloseTo(before.xMm);
    expect(after.yMm).toBeCloseTo(before.yMm);
  });
  it("clamps scale to bounds", () => {
    const t: SheetTransform = { scale: 30, tx: 0, ty: 0 };
    const zt = zoomAtCursor(t, 4, 0, 0);
    expect(zt.scale).toBeLessThanOrEqual(40);
  });
});

describe("panBy", () => {
  it("shifts translation, keeps scale", () => {
    const t = panBy({ scale: 3, tx: 10, ty: 20 }, 5, -7);
    expect(t).toEqual({ scale: 3, tx: 15, ty: 13 });
  });
});

describe("handleAt", () => {
  const r: RectMm = { xMm: 20, yMm: 20, widthMm: 100, heightMm: 60 };
  it("detects corners with priority over edges", () => {
    expect(handleAt(r, 20, 20, 3)).toBe("nw");
    expect(handleAt(r, 120, 80, 3)).toBe("se");
  });
  it("detects edges", () => {
    expect(handleAt(r, 70, 20, 3)).toBe("n");
    expect(handleAt(r, 120, 50, 3)).toBe("e");
    expect(handleAt(r, 20, 50, 3)).toBe("w");
    expect(handleAt(r, 70, 80, 3)).toBe("s");
  });
  it("detects the body inside", () => {
    expect(handleAt(r, 70, 50, 3)).toBe("body");
  });
  it("returns null well outside", () => {
    expect(handleAt(r, 5, 5, 3)).toBe(null);
    expect(handleAt(r, 200, 200, 3)).toBe(null);
  });
});

describe("pickViewport", () => {
  const vps = [vp("a", 0, 0, 100, 100), vp("b", 40, 40, 100, 100)];
  it("returns the topmost (last) viewport in overlap", () => {
    const hit = pickViewport(vps, 60, 60, 2);
    expect(hit?.id).toBe("b");
    expect(hit?.handle).toBe("body");
  });
  it("returns the lower one where only it is hit", () => {
    const hit = pickViewport(vps, 10, 10, 2);
    expect(hit?.id).toBe("a");
  });
  it("returns null on empty space", () => {
    expect(pickViewport(vps, 300, 300, 2)).toBe(null);
  });
});

describe("applyHandleDrag", () => {
  const start: RectMm = { xMm: 20, yMm: 20, widthMm: 100, heightMm: 60 };
  it("moves the whole rect for body", () => {
    expect(applyHandleDrag(start, "body", 10, -5)).toEqual({
      xMm: 30,
      yMm: 15,
      widthMm: 100,
      heightMm: 60,
    });
  });
  it("drags the east edge (width only)", () => {
    const r = applyHandleDrag(start, "e", 25, 0);
    expect(r).toEqual({ xMm: 20, yMm: 20, widthMm: 125, heightMm: 60 });
  });
  it("drags the west edge (x + width, right edge fixed)", () => {
    const r = applyHandleDrag(start, "w", 30, 0);
    expect(r.xMm).toBe(50);
    expect(r.widthMm).toBe(70);
    expect(r.xMm + r.widthMm).toBe(120); // rechte Kante unverändert
  });
  it("enforces min width when dragging west past the limit", () => {
    const r = applyHandleDrag(start, "w", 200, 0, 5);
    expect(r.widthMm).toBe(5);
    expect(r.xMm + r.widthMm).toBe(120);
  });
  it("drags a corner on both axes", () => {
    const r = applyHandleDrag(start, "se", 10, 20);
    expect(r).toEqual({ xMm: 20, yMm: 20, widthMm: 110, heightMm: 80 });
  });
  it("enforces min height dragging north past the limit", () => {
    const r = applyHandleDrag(start, "n", 0, 200, 5);
    expect(r.heightMm).toBe(5);
    expect(r.yMm + r.heightMm).toBe(80);
  });
});

describe("normalizeRect", () => {
  it("orders corners into min + positive size", () => {
    expect(normalizeRect(120, 90, 20, 20)).toEqual({
      xMm: 20,
      yMm: 20,
      widthMm: 100,
      heightMm: 70,
    });
  });
});

describe("clampRectToSheet", () => {
  it("keeps an in-bounds rect unchanged", () => {
    const r: RectMm = { xMm: 10, yMm: 10, widthMm: 50, heightMm: 50 };
    expect(clampRectToSheet(r, 210, 297)).toEqual(r);
  });
  it("pushes an overhanging rect back inside", () => {
    const r: RectMm = { xMm: 200, yMm: 280, widthMm: 50, heightMm: 50 };
    const c = clampRectToSheet(r, 210, 297);
    expect(c.xMm).toBe(160);
    expect(c.yMm).toBe(247);
    expect(c.widthMm).toBe(50);
  });
  it("shrinks a rect larger than the sheet", () => {
    const r: RectMm = { xMm: -20, yMm: -20, widthMm: 400, heightMm: 500 };
    const c = clampRectToSheet(r, 210, 297);
    expect(c).toEqual({ xMm: 0, yMm: 0, widthMm: 210, heightMm: 297 });
  });
});

describe("vpRect", () => {
  it("projects a viewport to its rect", () => {
    expect(vpRect(vp("x", 5, 6, 7, 8))).toEqual({
      xMm: 5,
      yMm: 6,
      widthMm: 7,
      heightMm: 8,
    });
  });
});

// ── Annotationen (Linie/Rechteck/Text) ──────────────────────────────────────

const line = (id: string, x1: number, y1: number, x2: number, y2: number): LayoutAnnotation => ({
  id,
  kind: "line",
  x1Mm: x1,
  y1Mm: y1,
  x2Mm: x2,
  y2Mm: y2,
});
const rect = (id: string, x: number, y: number, w: number, h: number): LayoutAnnotation => ({
  id,
  kind: "rect",
  xMm: x,
  yMm: y,
  widthMm: w,
  heightMm: h,
});
const text = (id: string, x: number, y: number, t: string, h = 3.5): LayoutAnnotation => ({
  id,
  kind: "text",
  xMm: x,
  yMm: y,
  text: t,
  heightMm: h,
});
const image = (id: string, x: number, y: number, w: number, h: number): LayoutAnnotation => ({
  id,
  kind: "image",
  xMm: x,
  yMm: y,
  widthMm: w,
  heightMm: h,
  src: "data:image/png;base64,",
});

describe("distanceToSegment", () => {
  it("returns perpendicular distance for a point beside the segment", () => {
    expect(distanceToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3);
  });
  it("clamps to the nearest endpoint beyond the segment", () => {
    expect(distanceToSegment(-4, 0, 0, 0, 10, 0)).toBeCloseTo(4);
    expect(distanceToSegment(14, 0, 0, 0, 10, 0)).toBeCloseTo(4);
  });
  it("degenerates to point distance for a zero-length segment", () => {
    expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
  });
});

describe("annotationBoundsMm", () => {
  it("rect: its own rectangle", () => {
    expect(annotationBoundsMm(rect("r", 10, 20, 30, 40))).toEqual({
      xMm: 10,
      yMm: 20,
      widthMm: 30,
      heightMm: 40,
    });
  });
  it("line: normalized bounding rect of both endpoints", () => {
    expect(annotationBoundsMm(line("l", 30, 30, 10, 10))).toEqual({
      xMm: 10,
      yMm: 10,
      widthMm: 20,
      heightMm: 20,
    });
  });
  it("text: box sits above the baseline, width grows with character count", () => {
    const b = annotationBoundsMm(text("t", 10, 20, "AB", 4));
    expect(b.xMm).toBe(10);
    expect(b.yMm).toBe(16); // 20 - heightMm
    expect(b.heightMm).toBeCloseTo(5); // heightMm * 1.25
    expect(b.widthMm).toBeGreaterThan(0);
  });
  it("image: its own rectangle, like rect", () => {
    expect(annotationBoundsMm(image("i", 5, 5, 40, 30))).toEqual({
      xMm: 5,
      yMm: 5,
      widthMm: 40,
      heightMm: 30,
    });
  });
});

describe("pickAnnotation", () => {
  it("hits a line within tolerance of the segment", () => {
    expect(pickAnnotation([line("l", 0, 0, 10, 0)], 5, 1, 2)).toBe("l");
    expect(pickAnnotation([line("l", 0, 0, 10, 0)], 5, 5, 2)).toBe(null);
  });
  it("hits a rect on its border and its interior", () => {
    const r = rect("r", 20, 20, 10, 10);
    expect(pickAnnotation([r], 20, 20, 1)).toBe("r"); // corner
    expect(pickAnnotation([r], 25, 25, 1)).toBe("r"); // interior
    expect(pickAnnotation([r], 100, 100, 1)).toBe(null);
  });
  it("hits a text annotation near its baseline box", () => {
    const tx = text("t", 10, 20, "Hallo", 4);
    expect(pickAnnotation([tx], 12, 18, 1)).toBe("t");
    expect(pickAnnotation([tx], 200, 200, 1)).toBe(null);
  });
  it("returns the topmost (last) annotation in overlap, like pickViewport", () => {
    const overlapping = [rect("a", 0, 0, 50, 50), rect("b", 10, 10, 50, 50)];
    expect(pickAnnotation(overlapping, 30, 30, 1)).toBe("b");
  });
  it("hits an image on its border and its interior, like rect", () => {
    const img = image("i", 20, 20, 10, 10);
    expect(pickAnnotation([img], 20, 20, 1)).toBe("i"); // corner
    expect(pickAnnotation([img], 25, 25, 1)).toBe("i"); // interior
    expect(pickAnnotation([img], 100, 100, 1)).toBe(null);
  });
});

describe("lineHandleAt", () => {
  it("hits the first endpoint within tolerance", () => {
    expect(lineHandleAt(0, 0, 10, 0, 0.5, 0.5, 2)).toBe("p1");
  });
  it("hits the second endpoint within tolerance", () => {
    expect(lineHandleAt(0, 0, 10, 0, 9.5, 0.5, 2)).toBe("p2");
  });
  it("hits the body between the endpoints", () => {
    expect(lineHandleAt(0, 0, 10, 0, 5, 1, 2)).toBe("body");
  });
  it("misses far away", () => {
    expect(lineHandleAt(0, 0, 10, 0, 5, 20, 2)).toBe(null);
  });
});

describe("annotationHandleAt / pickAnnotationHandle", () => {
  it("line: endpoint takes priority over body", () => {
    const l = line("l", 0, 0, 10, 0);
    expect(annotationHandleAt(l, 0, 0.5, 2)).toEqual({ kind: "line", handle: "p1" });
    expect(annotationHandleAt(l, 5, 0.5, 2)).toEqual({ kind: "line", handle: "body" });
  });
  it("rect: corner/edge/body like a viewport", () => {
    const r = rect("r", 20, 20, 10, 10);
    expect(annotationHandleAt(r, 20, 20, 1)).toEqual({ kind: "rect", handle: "nw" });
    expect(annotationHandleAt(r, 25, 25, 1)).toEqual({ kind: "rect", handle: "body" });
  });
  it("image: same handle set as rect", () => {
    const img = image("i", 20, 20, 10, 10);
    expect(annotationHandleAt(img, 30, 30, 1)).toEqual({ kind: "image", handle: "se" });
  });
  it("text: no handle system, plain bbox hit still reported as pickAnnotationHandle body", () => {
    const tx = text("t", 10, 20, "Hallo", 4);
    expect(annotationHandleAt(tx, 12, 18, 1)).toBe(null);
    expect(pickAnnotationHandle([tx], 12, 18, 1)).toEqual({
      id: "t",
      hit: { kind: "line", handle: "body" },
    });
  });
  it("pickAnnotationHandle returns null outside every annotation", () => {
    expect(pickAnnotationHandle([line("l", 0, 0, 10, 0)], 500, 500, 1)).toBe(null);
  });
});

describe("applyLineHandleDrag", () => {
  const l = line("l", 0, 0, 10, 0) as Extract<LayoutAnnotation, { kind: "line" }>;
  it("p1 moves only the first endpoint", () => {
    expect(applyLineHandleDrag(l, "p1", 2, 3)).toEqual({ x1Mm: 2, y1Mm: 3, x2Mm: 10, y2Mm: 0 });
  });
  it("p2 moves only the second endpoint", () => {
    expect(applyLineHandleDrag(l, "p2", 2, 3)).toEqual({ x1Mm: 0, y1Mm: 0, x2Mm: 12, y2Mm: 3 });
  });
  it("body moves both endpoints", () => {
    expect(applyLineHandleDrag(l, "body", 2, 3)).toEqual({ x1Mm: 2, y1Mm: 3, x2Mm: 12, y2Mm: 3 });
  });
});

describe("translateAnnotation", () => {
  it("moves both endpoints of a line", () => {
    const moved = translateAnnotation(line("l", 0, 0, 10, 10), 5, -5);
    expect(moved).toMatchObject({ x1Mm: 5, y1Mm: -5, x2Mm: 15, y2Mm: 5 });
  });
  it("moves the origin of a rect", () => {
    const moved = translateAnnotation(rect("r", 10, 10, 20, 20), 3, 4);
    expect(moved).toMatchObject({ xMm: 13, yMm: 14, widthMm: 20, heightMm: 20 });
  });
  it("moves the anchor point of a text annotation", () => {
    const moved = translateAnnotation(text("t", 10, 10, "Hi"), 1, 2);
    expect(moved).toMatchObject({ xMm: 11, yMm: 12, text: "Hi" });
  });
  it("moves the origin of an image, like rect", () => {
    const moved = translateAnnotation(image("i", 10, 10, 20, 20), 3, 4);
    expect(moved).toMatchObject({ xMm: 13, yMm: 14, widthMm: 20, heightMm: 20 });
  });
});
