import { describe, it, expect } from "vitest";
import type { Primitive } from "../generatePlan";
import { buildOwnerIndex, ownedBy } from "./ownerIndex";

const line = (drawingId: string): Primitive =>
  ({ kind: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, cls: "draw2d", weightMm: 0.1, drawingId }) as Primitive;
const poly = (extra: Record<string, string>): Primitive =>
  ({ kind: "polygon", pts: [], fill: "#fff", stroke: "#000", strokeWidthMm: 0.1, ...extra }) as unknown as Primitive;

describe("ownerIndex", () => {
  const prims: Primitive[] = [
    poly({ wallId: "w1" }),
    line("d1"),
    poly({ roomId: "r1" }),
    line("d2"),
    poly({ wallId: "w2", openingId: "o1" }),
    line("d1"),
  ];
  const idx = buildOwnerIndex(prims);

  it("findet Primitive je Besitzer-ID in Plan-Reihenfolge", () => {
    expect(ownedBy(idx, prims, "drawingId", ["d1"])).toEqual([prims[1], prims[5]]);
    expect(ownedBy(idx, prims, "wallId", ["w2", "w1"])).toEqual([prims[0], prims[4]]);
    expect(ownedBy(idx, prims, "roomId", ["r1"])).toEqual([prims[2]]);
  });

  it("ein Primitiv kann mehrere Besitzer-Felder tragen (ausser Zeichnungs-Primitive)", () => {
    expect(ownedBy(idx, prims, "openingId", ["o1"])).toEqual([prims[4]]);
    expect(ownedBy(idx, prims, "wallId", ["w2"])).toEqual([prims[4]]);
  });

  it("liefert nichts für unbekannte IDs/leere Mengen und gleicht dem früheren filter()", () => {
    expect(ownedBy(idx, prims, "drawingId", ["x"])).toEqual([]);
    expect(ownedBy(idx, prims, "wallId", [])).toEqual([]);
    const ids = new Set(["d2", "w1"]);
    const viaFilter = prims.filter(
      (p) => ids.has((p as any).drawingId) || ids.has((p as any).wallId),
    );
    const viaIndex = [...ownedBy(idx, prims, "drawingId", ids), ...ownedBy(idx, prims, "wallId", ids)].sort(
      (a, b) => prims.indexOf(a) - prims.indexOf(b),
    );
    expect(viaIndex).toEqual(viaFilter);
  });
});
