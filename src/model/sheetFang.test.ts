import { describe, expect, it } from "vitest";
import type { Layout } from "./types";
import { sheetFangSegments, guideSeg } from "./sheetFang";

const layout = (extra: Partial<Layout> = {}): Layout =>
  ({ id: "L", name: "Blatt", paper: "A4", orientation: "landscape", viewports: [], ...extra }) as Layout;

describe("sheetFangSegments", () => {
  it("Papierrand als vier Strecken in Metern (y nach unten = −y)", () => {
    const s = sheetFangSegments(layout(), { w: 420, h: 297 });
    expect(s).toHaveLength(4);
    expect(s[0][1]).toEqual({ x: 0.42, y: -0 });
    expect(s[2][0]).toEqual({ x: 0.42, y: -0.297 });
  });

  it("Hilfslinien reichen über das ganze Blatt", () => {
    expect(guideSeg({ axis: "x", posMm: 100 }, 420, 297)).toEqual([{ x: 0.1, y: -0 }, { x: 0.1, y: -0.297 }]);
    expect(guideSeg({ axis: "y", posMm: 50 }, 420, 297)).toEqual([{ x: 0, y: -0.05 }, { x: 0.42, y: -0.05 }]);
    const s = sheetFangSegments(layout(), { w: 420, h: 297 }, [{ axis: "x", posMm: 10 }, { axis: "y", posMm: Number.NaN }]);
    expect(s).toHaveLength(5);
  });

  it("Rahmen von Viewport, Bild und Tabelle mit Höhe; kaputte Rahmen fehlen", () => {
    const l = layout({
      viewports: [{ id: "v", snapshotId: "s", xMm: 10, yMm: 10, widthMm: 100, heightMm: 80 } as never],
      images: [{ id: "i", xMm: 0, yMm: 0, widthMm: 0, heightMm: 5 } as never],
      tables: [
        { id: "t1", xMm: 5, yMm: 5, widthMm: 50, heightMm: 20 } as never,
        { id: "t2", xMm: 5, yMm: 5, widthMm: 50 } as never,
      ],
    });
    expect(sheetFangSegments(l, { w: 420, h: 297 })).toHaveLength(4 + 4 + 4);
  });
});
