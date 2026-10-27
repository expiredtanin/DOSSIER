// Kompakte Linien-Unterlage (Plan.underlay): materialisiert muss sie EXAKT
// dieselben Primitive ergeben wie der gewöhnliche Pfad (nur anders angeordnet).

import { describe, it, expect } from "vitest";
import { generatePlan, generateVisibleLevelsPlan, materializeUnderlay, materializeGreyed } from "./generatePlan";
import type { Drawing2D, DrawingLevel, Project } from "../model/types";

const level = (id: string): DrawingLevel =>
  ({ id, name: id, kind: "drawing", visible: true, locked: false }) as unknown as DrawingLevel;

const SHARED = {
  lineStyles: [] as Project["lineStyles"],
  hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }] as Project["hatches"],
  layers: [
    { code: "60", name: "Zeichnung", color: "#0a0a0a", lw: 0.25, visible: true, locked: false },
    { code: "61", name: "Rot", color: "#ff0000", lw: 0.5, visible: true, locked: false },
  ] as Project["layers"],
};

const poly = (id: string, cat: string, pts: [number, number][], closed: boolean, extra: object = {}): Drawing2D =>
  ({
    id,
    type: "drawing2d",
    levelId: "L1",
    categoryCode: cat,
    geom: { shape: "polyline", pts: pts.map(([x, y]) => ({ x, y })), closed },
    ...extra,
  }) as Drawing2D;

function project(drawings: Drawing2D[], levels = [level("L1")]): Project {
  return {
    id: "t",
    name: "T",
    ...SHARED,
    components: [],
    wallTypes: [],
    drawingLevels: levels,
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: drawings,
    context: [],
  } as unknown as Project;
}

const drawings: Drawing2D[] = [
  poly("open", "60", [[0, 0], [1, 0], [2, 1], [3, 1]], false),
  poly("closed", "61", [[10, 10], [12, 10], [12, 12], [10, 12]], true),
  poly("filled", "60", [[20, 20], [22, 20], [22, 22]], true, { fillColor: "#000000" }),
  poly("bulge", "60", [[30, 0], [32, 0], [32, 2]], false, { geom: { shape: "polyline", pts: [{ x: 30, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 2 }], closed: false, bulge: [0.5, 0] } }),
  { id: "ln", type: "drawing2d", levelId: "L1", categoryCode: "60", geom: { shape: "line", a: { x: 0, y: 5 }, b: { x: 4, y: 5 } } } as Drawing2D,
  { id: "ci", type: "drawing2d", levelId: "L1", categoryCode: "60", geom: { shape: "circle", center: { x: 5, y: 5 }, r: 1 } } as Drawing2D,
];
const visible = new Set(["60", "61"]);
const key = (p: unknown) => JSON.stringify(p);

describe("kompakte Linien-Unterlage", () => {
  it("materialisiert ergibt dieselben Primitive wie der normale Pfad (als Menge)", () => {
    const p = project(drawings);
    const normal = generatePlan(p, "L1", visible);
    const compact = generatePlan(p, "L1", visible, undefined, "mittel", false, false, true, 100, false, true);
    expect(compact.underlay?.length).toBeGreaterThan(0);
    // Die kompakten Plan-Primitive enthalten KEINE Linien der berechtigten Zeichnungen …
    const compactLineIds = new Set(compact.primitives.filter((q) => q.kind === "line").map((q) => (q as any).drawingId));
    expect(compactLineIds.has("open")).toBe(false);
    expect(compactLineIds.has("closed")).toBe(false);
    // … aber Bogen-Polylinien, Kreise etc. bleiben unverändert im Plan.
    expect(compact.primitives.some((q) => (q as any).drawingId === "ci")).toBe(true);
    const mat = materializeUnderlay(compact);
    expect(mat.underlay).toBeUndefined();
    expect(mat.primitives.map(key).sort()).toEqual(normal.primitives.map(key).sort());
    expect(mat.bounds).toEqual(normal.bounds);
  });

  it("Zeichnung geschlossener Kontur behält ihr Polygon im Plan (Auswahl/Füllung)", () => {
    const compact = generatePlan(project(drawings), "L1", visible, undefined, "mittel", false, false, true, 100, false, true);
    expect(compact.primitives.some((q) => q.kind === "polygon" && (q as any).drawingId === "closed")).toBe(true);
    expect(compact.primitives.some((q) => q.kind === "polygon" && (q as any).drawingId === "filled")).toBe(true);
  });

  it("mono und Export (forPrint) bleiben beim normalen Pfad", () => {
    const p = project(drawings);
    expect(generatePlan(p, "L1", visible, undefined, "mittel", false, true, true, 100, false, true).underlay).toBeUndefined();
    expect(generatePlan(p, "L1", visible, undefined, "mittel", false, false, true, 100, true, true).underlay).toBeUndefined();
  });

  it("Kategorie-Dimmung: gedimmte Zeichnungen landen in eigener Gruppe, Linien tragen greyed", () => {
    const p = project(drawings);
    const display = (code: string) => ({ render: true, greyed: code === "61", locked: false });
    const compact = generatePlan(p, "L1", visible, display, "mittel", false, false, true, 100, false, true);
    const greyedGroup = compact.underlay!.find((g) => g.catGreyed)!;
    expect(greyedGroup.drawings.map((d) => d.id)).toEqual(["closed"]);
    expect(greyedGroup.build(greyedGroup.drawings).every((q) => (q as any).greyed === true)).toBe(true);
  });

  it("Referenz-Ebene: Gruppe liegt unterhalb und ist als Tönung markiert; Materialisierung markiert sie in greyedRanges", () => {
    const sibling = { ...poly("sib", "60", [[0, 0], [5, 0], [5, 5]], false), levelId: "L2" } as Drawing2D;
    const p = project([drawings[0], sibling], [level("L1"), level("L2")]);
    const display = (id: string) => ({ render: true, greyed: id !== "L1", locked: false });
    const plan = generateVisibleLevelsPlan(p, "L1", visible, undefined, "mittel", false, false, display, 100, true);
    const below = plan.underlay!.filter((g) => !g.above);
    const above = plan.underlay!.filter((g) => g.above);
    expect(below.map((g) => g.drawings[0].id)).toEqual(["sib"]);
    expect(below[0].tint).toBe(true);
    expect(above.map((g) => g.drawings[0].id)).toEqual(["open"]);
    const mat = materializeGreyed(materializeUnderlay(plan), true);
    const sibLines = mat.primitives.filter((q) => (q as any).drawingId === "sib");
    const openLines = mat.primitives.filter((q) => (q as any).drawingId === "open");
    expect(sibLines.length).toBeGreaterThan(0);
    expect(sibLines.every((q) => (q as any).greyed === true)).toBe(true);
    expect(openLines.every((q) => !(q as any).greyed)).toBe(true);
  });

  it("leere Ebene ohne Primitive aber mit Unterlage zählt zum Ausmass", () => {
    const only = [poly("far", "60", [[2_665_000, 1_211_000], [2_665_010, 1_211_000]], false)];
    const p = project(only, [level("L1"), level("L2")]);
    const plan = generateVisibleLevelsPlan(p, "L1", visible, undefined, "mittel", false, false, undefined, 100, true);
    expect(plan.primitives.length).toBe(0);
    expect(plan.bounds.minX).toBeGreaterThan(2_000_000);
  });
});

describe("Ebenen ein-/ausblenden (Kataster-Performance)", () => {
  const vis = (codes: string[]) => new Set(codes);

  it("Unterlage ist pro Kategorie gruppiert", () => {
    const p = project(drawings);
    const plan = generatePlan(p, "L1", vis(["60", "61"]), undefined, "mittel", false, false, true, 100, false, true);
    const cats = plan.underlay!.map((g) => new Set(g.drawings.map((d) => d.categoryCode)));
    expect(cats.every((s) => s.size === 1)).toBe(true);
    expect(plan.underlay!.length).toBe(2);
  });

  it("Ausblenden einer Ebene: nur deren Gruppe verschwindet, die übrigen bleiben inhaltlich IDENTISCH (gleiche Zeichnungen, gleicher Kontext)", () => {
    const p1 = project(drawings);
    // Wie das Umschalten von `visible`: neue Ebenen-Liste, gleiche Stil-Werte.
    const p2 = { ...p1, layers: p1.layers.map((l) => (l.code === "61" ? { ...l, visible: false } : l)) } as Project;
    const a = generatePlan(p1, "L1", vis(["60", "61"]), undefined, "mittel", false, false, true, 100, false, true);
    const b = generatePlan(p2, "L1", vis(["60"]), undefined, "mittel", false, false, true, 100, false, true);
    const g60a = a.underlay!.find((g) => g.drawings[0].categoryCode === "60")!;
    const g60b = b.underlay!.find((g) => g.drawings[0].categoryCode === "60")!;
    expect(g60b.drawings).toEqual(g60a.drawings);
    expect(g60b.drawings.every((d, i) => d === g60a.drawings[i])).toBe(true);
    expect(g60b.ctx.every((x, i) => x === g60a.ctx[i])).toBe(true); // Chunks bleiben wiederverwendbar
    expect(b.underlay!.some((g) => g.drawings[0].categoryCode === "61")).toBe(false);
  });

  it("Ebenen-Sichtbarkeit invalidiert den Primitiv-Cache NICHT; eine Farbänderung schon", () => {
    const d = poly("A", "60", [[0, 0], [1, 0], [2, 1]], false);
    const p1 = project([d]);
    const hidden = { ...p1, layers: p1.layers.map((l) => ({ ...l, visible: false })) } as Project;
    const first = generatePlan(p1, "L1", vis(["60"]));
    const afterToggle = generatePlan(hidden, "L1", vis(["60"]));
    const lineOf = (pl: ReturnType<typeof generatePlan>) => pl.primitives.find((q) => q.kind === "line")!;
    expect(lineOf(afterToggle)).toBe(lineOf(first)); // dasselbe Objekt → GPU-Chunk bleibt gültig
    const recolored = { ...p1, layers: p1.layers.map((l) => ({ ...l, color: "#123456" })) } as Project;
    expect(lineOf(generatePlan(recolored, "L1", vis(["60"])))).not.toBe(lineOf(first));
  });
});
