import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { candidatePairs, clashItems, clashMarkerOps, CLASH_MARKER_PREFIX } from "./clash";
import { applyOps } from "../core/ops";
import type { Project } from "../model/types";
import type { Clash } from "./clash";

const applyClashMarkers = (p: Project, clashes: Clash[], cat: string) => applyOps(p, clashMarkerOps(p, clashes, cat));
import type { ClashItem } from "./clash";

const it0 = (id: string, kind: ClashItem["kind"]): ClashItem => ({ id, kind, spec: { kind: "cuboid", min: [0, 0, 0], max: [1, 1, 1] } });
const box = (x0: number, x1: number) => ({ min: [x0, 0, 0] as [number, number, number], max: [x1, 1, 1] as [number, number, number] });

describe("Kollisionspruefung", () => {
  it("prueft nur Paare mit freiem Koerper und ueberlappenden Huellen", () => {
    const items = [it0("w1", "wall"), it0("w2", "wall"), it0("s1", "solid"), it0("s2", "solid")];
    const boxes = [box(0, 2), box(1, 3), box(1.5, 2.5), box(5, 6)];
    expect(candidatePairs(items, boxes)).toEqual([[0, 2], [1, 2]]);
  });
  it("Bauteile des Beispielprojekts werden erfasst", () => {
    const items = clashItems(sampleProject);
    expect(items.some((i) => i.kind === "wall")).toBe(true);
  });
  it("Marker ersetzen alte Marker", () => {
    const clash = { a: it0("a", "solid"), b: it0("b", "wall"), volume: 0.12, center: [1, 2, 0.5] as [number, number, number] };
    const p1 = applyClashMarkers(sampleProject, [clash, clash], "A");
    const n1 = p1.drawings2d.filter((d) => d.id.startsWith(CLASH_MARKER_PREFIX)).length;
    expect(n1).toBe(4);
    const p2 = applyClashMarkers(p1, [clash], "A");
    expect(p2.drawings2d.filter((d) => d.id.startsWith(CLASH_MARKER_PREFIX)).length).toBe(2);
  });
});
