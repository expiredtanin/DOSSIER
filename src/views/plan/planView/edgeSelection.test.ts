import { describe, expect, it } from "vitest";
import type { EdgeGrip } from "../../../model/types";
import { edgeHitAt, edgeKey, edgeSelStep, selectedEdgeOf } from "./edgeSelection";

// Quadrat 0..10 (Bildschirm = Modell × 10, damit Pixel-Toleranzen greifbar sind).
const sq = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];
const edges: EdgeGrip[] = sq.map((a, i) => {
  const b = sq[(i + 1) % 4];
  return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, normal: { x: 0, y: 0 }, aIndex: i, bIndex: (i + 1) % 4, a, b };
});
const toClient = (v: { x: number; y: number }) => ({ x: v.x * 10, y: v.y * 10 });

describe("[288] Kantenauswahl", () => {
  it("Treffer auf der Kante innerhalb der Pixel-Toleranz, sonst keiner", () => {
    expect(edgeHitAt(edges, toClient, { x: 30, y: 4 })?.aIndex).toBe(0);
    expect(edgeHitAt(edges, toClient, { x: 104, y: 70 })?.aIndex).toBe(1);
    expect(edgeHitAt(edges, toClient, { x: 50, y: 50 })).toBeNull();
    expect(edgeHitAt(edges, toClient, { x: 30, y: 9 })).toBeNull();
  });

  it("Schlüssel unterscheidet Eigentümer bei gleichen Indizes", () => {
    const a = { ...edges[0], owner: { wallId: "w1" } };
    const b = { ...edges[0], owner: { drawingId: "d1" } };
    expect(edgeKey(a)).not.toBe(edgeKey(b));
  });

  it("Zustand: zweiter Klick wählt, gleiche Kante läuft durch, daneben hebt auf, Esc hebt auf", () => {
    let s = edgeSelStep(null, { kind: "click", hit: edges[1] });
    expect(s).toEqual({ key: edgeKey(edges[1]), consumed: true });
    expect(selectedEdgeOf(edges, s.key)).toBe(edges[1]);
    s = edgeSelStep(s.key, { kind: "click", hit: edges[1] });
    expect(s.consumed).toBe(false);
    expect(s.key).toBe(edgeKey(edges[1]));
    s = edgeSelStep(s.key, { kind: "click", hit: edges[2] });
    expect(s).toEqual({ key: edgeKey(edges[2]), consumed: true });
    expect(edgeSelStep(s.key, { kind: "escape" })).toEqual({ key: null, consumed: true });
    expect(edgeSelStep(null, { kind: "escape" })).toEqual({ key: null, consumed: false });
    expect(edgeSelStep(s.key, { kind: "click", hit: null })).toEqual({ key: null, consumed: false });
    expect(edgeSelStep(s.key, { kind: "edges", edges: edges.slice(0, 2) }).key).toBeNull();
  });
});
