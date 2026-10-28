// Geometrie der Türen/Fenster im IFC-Export ([B5]): Rahmen, Blatt, Glas, Ausführung. Reine Rechnung,
// kein WASM nötig.

import { describe, expect, it } from "vitest";
import { fillGeometry, DEFAULT_FRAME_WIDTH, DEFAULT_FRAME_DEPTH, DOOR_LEAF_THICK } from "./ifcOpenings";
import type { DoorType, Opening, Project, Wall, WindowType } from "../model/types";

const wall = { id: "W", start: { x: 0, y: 0 }, end: { x: 5, y: 0 } } as Wall;
const host = { nLo: -0.2, nHi: 0.2 };

function proj(over: { doorTypes?: DoorType[]; windowTypes?: WindowType[] }): Project {
  return { doorTypes: over.doorTypes ?? [], windowTypes: over.windowTypes ?? [] } as unknown as Project;
}
function door(over: Partial<Opening> = {}): Opening {
  return { id: "D", type: "opening", hostWallId: "W", categoryCode: "21", kind: "door", position: 1, width: 1, height: 2.1, sillHeight: 0, ...over } as Opening;
}
function win(over: Partial<Opening> = {}): Opening {
  return { id: "F", type: "opening", hostWallId: "W", categoryCode: "21", kind: "window", position: 1, width: 1.2, height: 1.2, sillHeight: 0.9, ...over } as Opening;
}
const cut = (o: Opening) => ({ from: o.position, to: o.position + o.width, zBottom: o.sillHeight, zTop: o.sillHeight + o.height });
const wt = (over: Partial<WindowType> = {}): WindowType =>
  ({ id: "wt", name: "Fenster", kind: "dreh", wingCount: 1, glazing: "zweifach", frameThickness: 0.08, defaultSillHeight: 0.9, defaultWidth: 1.2, defaultHeight: 1.2, ...over }) as WindowType;
const dtp = (over: Partial<DoorType> = {}): DoorType =>
  ({ id: "dt", name: "Tür", kind: "dreh", leafCount: 1, leafStyle: "glatt", frameThickness: 0.06, defaultWidth: 1, defaultHeight: 2.1, ...over }) as DoorType;

const bbox = (pts: { x: number; y: number }[]) => ({
  x0: Math.min(...pts.map((p) => p.x)),
  x1: Math.max(...pts.map((p) => p.x)),
  y0: Math.min(...pts.map((p) => p.y)),
  y1: Math.max(...pts.map((p) => p.y)),
});
const volume = (parts: { pts: { x: number; y: number }[]; depth: number }[]) =>
  parts.reduce((a, p) => {
    const b = bbox(p.pts);
    return a + (b.x1 - b.x0) * (b.y1 - b.y0) * p.depth;
  }, 0);

describe("fillGeometry — Fenster", () => {
  it("Blendrahmen aus 4 Teilen + eine Glasscheibe, Masse aus Konstanten, Glas = Paketdicke", () => {
    const o = win({ typeId: "wt" });
    const g = fillGeometry(proj({ windowTypes: [wt()] }), wall, o, cut(o), host);
    const frame = g.parts.filter((p) => p.role === 0);
    const glass = g.parts.filter((p) => p.role === 2);
    expect(frame.length).toBe(4);
    expect(glass.length).toBe(1);
    expect(g.kind).toBe("SINGLE_PANEL");
    // Rahmenvolumen = (W·H − lichtes Mass) · Tiefe
    const fw = DEFAULT_FRAME_WIDTH;
    expect(volume(frame)).toBeCloseTo((1.2 * 1.2 - (1.2 - 2 * fw) * (1.2 - 2 * fw)) * DEFAULT_FRAME_DEPTH, 9);
    // Glas füllt das lichte Mass, 24 mm (zweifach), mittig in der Rahmentiefe (aussen = nLo).
    const gb = bbox(glass[0].pts);
    expect(gb.x1 - gb.x0).toBeCloseTo(1.2 - 2 * fw, 9);
    expect(gb.y1 - gb.y0).toBeCloseTo(0.024, 9);
    expect((gb.y0 + gb.y1) / 2).toBeCloseTo(-0.2 + DEFAULT_FRAME_DEPTH / 2, 9);
    expect(glass[0].zRel).toBeCloseTo(fw, 9);
    expect(glass[0].depth).toBeCloseTo(1.2 - 2 * fw, 9);
  });
  it("Rahmenbreite/-tiefe/Einzug/Verglasung aus dem Typ; Einzug von innen", () => {
    const o = win({ typeId: "wt" });
    const t = wt({ frameWidth: 0.09, frameDepth: 0.1, insetFromFace: 0.05, insetFace: "innen", glazing: "dreifach" });
    const g = fillGeometry(proj({ windowTypes: [t] }), wall, o, cut(o), host);
    const frame = g.parts.filter((p) => p.role === 0);
    const b = bbox(frame[0].pts);
    // innen = nHi: Vorderkante 5 cm eingezogen → Rahmen von 0.05 bis 0.15 (Tiefe 10 cm nach aussen)
    expect(b.y0).toBeCloseTo(0.05, 9);
    expect(b.y1).toBeCloseTo(0.15, 9);
    expect(bbox(frame[2].pts).y1 - bbox(frame[2].pts).y0).toBeCloseTo(0.1, 9);
    const gl = bbox(g.parts.find((p) => p.role === 2)!.pts);
    expect(gl.y1 - gl.y0).toBeCloseTo(0.036, 9);
    expect(gl.x1 - gl.x0).toBeCloseTo(1.2 - 0.18, 9);
  });
  it("Rahmentiefe wird auf die Wanddicke geklemmt", () => {
    const o = win({ typeId: "wt" });
    const g = fillGeometry(proj({ windowTypes: [wt({ frameDepth: 1 })] }), wall, o, cut(o), host);
    const b = bbox(g.parts[0].pts);
    expect(b.y0).toBeCloseTo(-0.2, 9);
    expect(b.y1).toBeCloseTo(0.2, 9);
  });
  it("Flügelzahl → Mittelpfosten + eine Scheibe je Flügel, PartitioningType", () => {
    for (const [wing, kind] of [
      [2, "DOUBLE_PANEL_VERTICAL"],
      [3, "TRIPLE_PANEL_VERTICAL"],
      [4, "NOTDEFINED"],
    ] as const) {
      const o = win({ typeId: "wt", wingCount: wing });
      const g = fillGeometry(proj({ windowTypes: [wt()] }), wall, o, cut(o), host);
      expect(g.parts.filter((p) => p.role === 2).length, `${wing}`).toBe(wing);
      expect(g.parts.filter((p) => p.role === 0).length, `${wing}`).toBe(4 + (wing - 1));
      expect(g.kind).toBe(kind);
    }
  });
  it("Flügeltabelle mit Pfosten und fester Breite: Gläser abgrenzend, keine Überlappung", () => {
    const o = win({ typeId: "wt" });
    const t = wt({
      sashes: [
        { kind: "fluegel", autoWidth: false, width: 0.5 },
        { kind: "pfosten", postWidth: 0.1 },
        { kind: "fluegel" },
      ],
    });
    const g = fillGeometry(proj({ windowTypes: [t] }), wall, o, cut(o), host);
    const glass = g.parts.filter((p) => p.role === 2).map((p) => bbox(p.pts));
    expect(glass.length).toBe(2);
    expect(glass[0].x1 - glass[0].x0).toBeCloseTo(0.5, 9);
    const clear = 1.2 - 2 * 0.06;
    expect(glass[1].x1 - glass[1].x0).toBeCloseTo(clear - 0.6, 9);
    expect(glass[1].x0).toBeCloseTo(glass[0].x1 + 0.1, 9);
    expect(g.kind).toBe("DOUBLE_PANEL_VERTICAL");
  });
  it("ohne Typ: Standardmasse, zweifach, Flügelzahl der Öffnung", () => {
    const o = win({ wingCount: 2 });
    const g = fillGeometry(proj({}), wall, o, cut(o), host);
    const glass = g.parts.filter((p) => p.role === 2);
    expect(glass.length).toBe(2);
    const b = bbox(glass[0].pts);
    expect(b.y1 - b.y0).toBeCloseTo(0.024, 9);
  });
  it("alle Teile liegen innerhalb der Öffnung und der Wand", () => {
    const o = win({ typeId: "wt", wingCount: 2 });
    const g = fillGeometry(proj({ windowTypes: [wt()] }), wall, o, cut(o), host);
    for (const p of g.parts) {
      const b = bbox(p.pts);
      expect(b.x0).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(b.x1).toBeLessThanOrEqual(2.2 + 1e-9);
      expect(b.y0).toBeGreaterThanOrEqual(-0.2 - 1e-9);
      expect(b.y1).toBeLessThanOrEqual(0.2 + 1e-9);
      expect(p.zRel).toBeGreaterThanOrEqual(-1e-9);
      expect(p.zRel + p.depth).toBeLessThanOrEqual(1.2 + 1e-9);
    }
  });
});

describe("fillGeometry — Tür", () => {
  it("Zarge (3 Teile) + Blatt, Blatt 4 cm mittig, Höhe bis unter den Sturz", () => {
    const o = door({ typeId: "dt" });
    const g = fillGeometry(proj({ doorTypes: [dtp()] }), wall, o, cut(o), host);
    expect(g.parts.filter((p) => p.role === 0).length).toBe(3);
    const leaf = g.parts.filter((p) => p.role === 1);
    expect(leaf.length).toBe(1);
    const lb = bbox(leaf[0].pts);
    expect(lb.y1 - lb.y0).toBeCloseTo(DOOR_LEAF_THICK, 9);
    expect(lb.x1 - lb.x0).toBeCloseTo(1 - 2 * DEFAULT_FRAME_WIDTH, 9);
    expect(leaf[0].zRel).toBe(0);
    expect(leaf[0].depth).toBeCloseTo(2.1 - DEFAULT_FRAME_WIDTH, 9);
    expect(g.parts.some((p) => p.role === 2)).toBe(false);
  });
  it("zweiflügelig: zwei Blätter, DOUBLE_DOOR_SINGLE_SWING", () => {
    const o = door({ typeId: "dt" });
    const g = fillGeometry(proj({ doorTypes: [dtp({ leafCount: 2 })] }), wall, o, cut(o), host);
    expect(g.parts.filter((p) => p.role === 1).length).toBe(2);
    expect(g.kind).toBe("DOUBLE_DOOR_SINGLE_SWING");
  });
  it("Glastür: Glasfläche = glazingRatio des Blatts, Blatt als Rahmen darum, ohne Überlappung", () => {
    const o = door({ typeId: "dt" });
    const g = fillGeometry(proj({ doorTypes: [dtp({ leafStyle: "glas", glazingRatio: 0.36 })] }), wall, o, cut(o), host);
    const glass = g.parts.filter((p) => p.role === 2);
    expect(glass.length).toBe(1);
    const gb = bbox(glass[0].pts);
    const leafW = 1 - 2 * DEFAULT_FRAME_WIDTH;
    const leafH = 2.1 - DEFAULT_FRAME_WIDTH;
    expect(((gb.x1 - gb.x0) * glass[0].depth) / (leafW * leafH)).toBeCloseTo(0.36, 9);
    const leaf = g.parts.filter((p) => p.role === 1);
    expect(leaf.length).toBe(4);
    // Blatt ohne Glasfläche = volle Blattfläche − Glasfläche, über 4 cm
    expect(volume(leaf)).toBeCloseTo((leafW * leafH - (gb.x1 - gb.x0) * glass[0].depth) * DOOR_LEAF_THICK, 9);
  });
  it("Oberlicht: Riegel + Glasstreifen, Blatt entsprechend kürzer", () => {
    const o = door({ typeId: "dt" });
    const g = fillGeometry(proj({ doorTypes: [dtp({ transomHeight: 0.4 })] }), wall, o, cut(o), host);
    const glass = g.parts.filter((p) => p.role === 2);
    expect(glass.length).toBe(1);
    expect(glass[0].depth).toBeCloseTo(0.4, 9);
    expect(glass[0].zRel + glass[0].depth).toBeCloseTo(2.1 - DEFAULT_FRAME_WIDTH, 9);
    const leaf = g.parts.find((p) => p.role === 1)!;
    expect(leaf.zRel + leaf.depth).toBeCloseTo(2.1 - DEFAULT_FRAME_WIDTH - 0.4 - DEFAULT_FRAME_WIDTH, 9);
  });
  it("reine Wandöffnung (Typ oder Inline): kein Körper, keine Ausführung", () => {
    const o = door({ typeId: "dt" });
    expect(fillGeometry(proj({ doorTypes: [dtp({ kind: "wandoeffnung" })] }), wall, o, cut(o), host)).toMatchObject({ kind: null, parts: [] });
    const o2 = door({ doorType: "wandoeffnung" });
    expect(fillGeometry(proj({}), wall, o2, cut(o2), host)).toMatchObject({ kind: null, parts: [] });
  });
  it("Scharnierseite und Aufschlag → LEFT/RIGHT (von der Aufschlagseite gesehen), Schiebetür", () => {
    // Wand entlang +X, linke Normale +Y. Standard: Aufschlag nach +Y, Scharnier am Anfang (x klein):
    // von +Y nach −Y gesehen liegt x klein rechts → RIGHT.
    const kind = (o: Opening, t: DoorType = dtp()) => fillGeometry(proj({ doorTypes: [t] }), wall, o, cut(o), host).kind;
    expect(kind(door({ typeId: "dt" }))).toBe("SINGLE_SWING_RIGHT");
    expect(kind(door({ typeId: "dt", hinge: "end" }))).toBe("SINGLE_SWING_LEFT");
    // Aufschlag nach aussen (−Y): Blickrichtung dreht → Seiten tauschen.
    expect(kind(door({ typeId: "dt", openingDir: "out" }))).toBe("SINGLE_SWING_LEFT");
    expect(kind(door({ typeId: "dt", swing: "right" }))).toBe("SINGLE_SWING_LEFT");
    expect(kind(door({ typeId: "dt" }), dtp({ kind: "schiebe" }))).toBe("SLIDING_TO_RIGHT");
    expect(kind(door({ typeId: "dt" }), dtp({ kind: "schiebe", leafCount: 2 }))).toBe("DOUBLE_DOOR_SLIDING");
  });
  it("Füllungssystem: Y = Aufschlagrichtung, Ursprung = Öffnungsmitte auf der Achse", () => {
    const o = door({ typeId: "dt" });
    const g = fillGeometry(proj({ doorTypes: [dtp()] }), wall, o, cut(o), host);
    expect(g.origin).toEqual({ x: 1.5, y: 0 });
    expect(g.u.x).toBeCloseTo(1, 12); // Aufschlag +Y → X = (swing.y, −swing.x) = (1, 0)
    expect(g.u.y).toBeCloseTo(0, 12);
    const out = fillGeometry(proj({ doorTypes: [dtp()] }), wall, door({ typeId: "dt", openingDir: "out" }), cut(o), host);
    expect(out.u.x).toBeCloseTo(-1, 12);
  });
});
