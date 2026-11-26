import { describe, expect, it } from "vitest";
import type { LayoutViewport } from "../model/types";
import {
  resizedCenter,
  viewportViewBox,
  applyHandleDrag,
  clampRectToSheet,
  handleAt,
  normalizeRect,
  pickViewport,
  vpRect,
  type RectMm,
} from "./layoutSheetMath";

const vp = (
  id: string,
  xMm: number,
  yMm: number,
  widthMm: number,
  heightMm: number,
): LayoutViewport => ({ id, snapshotId: "s", xMm, yMm, widthMm, heightMm });

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

describe("[333] Inhalt bleibt beim Vergrössern liegen (resizedCenter, viewportViewBox)", () => {
  const start = { xMm: 10, yMm: 20, widthMm: 100, heightMm: 60 };
  it("Unterkante 40 mm nach unten: Mitte 20 mm tiefer, bei 1:100 also 2 m Richtung −y", () => {
    const next = { ...start, heightMm: 100 };
    expect(resizedCenter({ x: 5, y: 7 }, start, next, 100)).toEqual({ x: 5, y: 5 });
  });
  it("linke Kante nach links: Mitte nach links", () => {
    const c = resizedCenter({ x: 0, y: 0 }, start, { ...start, xMm: 0, widthMm: 110 }, 50);
    expect(c.x).toBeCloseTo(-0.25);
    expect(c.y).toBeCloseTo(0);
  });
  it("viewBox: gleicher Rahmen = 0 0 w h; Vergrössern mit mitwandernder Mitte = Inhalt fest; Verschieben = Inhalt wandert mit", () => {
    const c0 = { x: 3, y: 4 };
    expect(viewportViewBox(start, c0, start, c0, 100)).toEqual([0, 0, 100, 60]);
    const bigger = { ...start, yMm: 10, heightMm: 100 };
    const vb = viewportViewBox(bigger, resizedCenter(c0, start, bigger, 100), start, c0, 100);
    vb.forEach((v, i) => expect(v).toBeCloseTo([0, -10, 100, 100][i]));
    const moved = { ...start, xMm: 50 };
    viewportViewBox(moved, c0, start, c0, 100).forEach((v, i) => expect(v).toBeCloseTo([0, 0, 100, 60][i]));
  });
});
