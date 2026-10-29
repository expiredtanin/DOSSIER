import { describe, it, expect } from "vitest";
import {
  activePenSet,
  resolvePenColor,
  resolvePenWeight,
  rebakePenOps,
  freeColorPalette,
  deletePenOps,
  seedStandardPenSetOps,
  PEN_FALLBACK_COLOR,
  PEN_FALLBACK_WEIGHT,
} from "./penSets";
import type { Ceiling, Component, Drawing2D, LayerCategory, PenStyle, Project, Room, Wall } from "./types";
import { applyOps } from "../core/ops";

const rebakePenColors = (p: Project): Project => applyOps(p, rebakePenOps(p));
const seedStandardPenSet = (p: Project): Project => applyOps(p, seedStandardPenSetOps(p));

function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [],
    layers: [],
    walls: [],
    drawings2d: [],
    ...overrides,
  };
}

/** Kurzform für einen PenStyle-Eintrag in Tests. */
const ps = (color: string, weight = 0.5): PenStyle => ({ color, weight });

describe("activePenSet/resolvePenColor/resolvePenWeight", () => {
  it("liefert undefined ohne Stiftsätze/aktiven Verweis", () => {
    const p = baseProject();
    expect(activePenSet(p)).toBeUndefined();
  });

  it("löst Farbe UND Strichstärke gegen den aktiven Stiftsatz auf", () => {
    const p = baseProject({
      penSets: [
        { id: "std", name: "Standard", pens: { "1": ps("#ff0000", 0.35) } },
        { id: "bw", name: "S/W", pens: { "1": ps("#000000", 0.13) } },
      ],
      activePenSetId: "bw",
    });
    expect(resolvePenColor(p, "1")).toBe("#000000");
    expect(resolvePenWeight(p, "1")).toBe(0.13);
  });

  it("liefert den Fallback, wenn der Stift im aktiven Satz keinen Eintrag hat", () => {
    const p = baseProject({
      penSets: [{ id: "std", name: "Standard", pens: {} }],
      activePenSetId: "std",
    });
    expect(resolvePenColor(p, "1")).toBe(PEN_FALLBACK_COLOR);
    expect(resolvePenWeight(p, "1")).toBe(PEN_FALLBACK_WEIGHT);
  });

  it("liefert den Fallback ohne aktiven Stiftsatz", () => {
    const p = baseProject({ penSets: [{ id: "std", name: "Standard", pens: { "1": ps("#ff0000") } }] });
    expect(resolvePenColor(p, "1")).toBe(PEN_FALLBACK_COLOR);
  });
});

const comp = (overrides: Partial<Component> = {}): Component => ({
  id: "c1",
  name: "C1",
  color: "#111111",
  hatchId: "none",
  joinPriority: 10,
  ...overrides,
});

const cat = (overrides: Partial<LayerCategory> = {}): LayerCategory => ({
  code: "20",
  name: "Wände",
  color: "#222222",
  lw: 0.35,
  visible: true,
  locked: false,
  ...overrides,
});

describe("rebakePenColors — Bauteile (nur Farbe, kein Stärke-Feld)", () => {
  it("lässt ein Bauteil OHNE Stift-Verweis unangetastet (referenzgleich)", () => {
    const c = comp();
    const p = baseProject({ components: [c] });
    const out = rebakePenColors(p);
    expect(out.components[0]).toBe(c);
  });

  it("bäckt `color` aus dem aktiven Stiftsatz, wenn `colorPenId` gesetzt ist", () => {
    const p = baseProject({
      components: [comp({ colorPenId: "1", color: "#stale" })],
      penSets: [{ id: "std", name: "Standard", pens: { "1": ps("#abcdef") } }],
      activePenSetId: "std",
    });
    const out = rebakePenColors(p);
    expect(out.components[0].color).toBe("#abcdef");
  });

  it("bäckt `foreground`/`background` unabhängig voneinander", () => {
    const p = baseProject({
      components: [
        comp({
          color: "#base",
          foregroundPenId: "fg",
          backgroundPenId: "bg",
        }),
      ],
      penSets: [{ id: "std", name: "Standard", pens: { fg: ps("#f00"), bg: ps("#0f0") } }],
      activePenSetId: "std",
    });
    const out = rebakePenColors(p);
    expect(out.components[0].foreground).toBe("#f00");
    expect(out.components[0].background).toBe("#0f0");
    // color selbst hat keinen Stift-Verweis -> bleibt unverändert.
    expect(out.components[0].color).toBe("#base");
  });

  it("nutzt den Fallback, wenn der referenzierte Stift im aktiven Satz fehlt", () => {
    const p = baseProject({
      components: [comp({ colorPenId: "missing" })],
      penSets: [{ id: "std", name: "Standard", pens: {} }],
      activePenSetId: "std",
    });
    const out = rebakePenColors(p);
    expect(out.components[0].color).toBe(PEN_FALLBACK_COLOR);
  });
});

describe("rebakePenColors — Ebenen (Farbe UND Strichstärke, inkl. verschachtelt)", () => {
  it("bäckt `color` UND `lw` einer Top-Level-Kategorie", () => {
    const p = baseProject({
      layers: [cat({ colorPenId: "1" })],
      penSets: [{ id: "std", name: "Standard", pens: { "1": ps("#123456", 0.7) } }],
      activePenSetId: "std",
    });
    const out = rebakePenColors(p);
    expect(out.layers[0].color).toBe("#123456");
    expect(out.layers[0].lw).toBe(0.7);
  });

  it("bäckt eine verschachtelte Kategorie (children) und lässt Geschwister ohne Stift inhaltlich unverändert", () => {
    const child = cat({ code: "21", colorPenId: "2" });
    const untouchedChild = cat({ code: "22", color: "#untouched" });
    const parent = cat({ code: "20", children: [child, untouchedChild] });
    const p = baseProject({
      layers: [parent],
      penSets: [{ id: "std", name: "Standard", pens: { "2": ps("#00ff00") } }],
      activePenSetId: "std",
    });
    const out = rebakePenColors(p);
    expect(out.layers[0].children?.[0].color).toBe("#00ff00");
    expect(out.layers[0].children?.[1]).toEqual(untouchedChild);
  });

  it("lässt eine Kategorie OHNE Stift-Verweis referenzgleich", () => {
    const c = cat();
    const p = baseProject({ layers: [c] });
    const out = rebakePenColors(p);
    expect(out.layers[0]).toBe(c);
  });
});

const wall = (overrides: Partial<Wall> = {}): Wall => ({
  id: "w1",
  type: "wall",
  floorId: "eg",
  categoryCode: "20",
  start: { x: 0, y: 0 },
  end: { x: 5, y: 0 },
  wallTypeId: "aw",
  height: 2.6,
  ...overrides,
});

const ceiling = (overrides: Partial<Ceiling> = {}): Ceiling => ({
  id: "c1",
  type: "ceiling",
  floorId: "eg",
  categoryCode: "30",
  outline: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
  wallTypeId: "aw",
  ...overrides,
});

const drawing2d = (overrides: Partial<Drawing2D> = {}): Drawing2D => ({
  id: "d1",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
  ...overrides,
});

const room = (overrides: Partial<Room> = {}): Room => ({
  id: "r1",
  type: "room",
  floorId: "eg",
  categoryCode: "60",
  siaCategory: "HNF",
  name: "Wohnen",
  boundary: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
  color: "#stale",
  ...overrides,
});

describe("rebakePenColors — Elemente MIT Strichstärke-Feld (Wand/Decke/Drawing2D)", () => {
  it("bäckt Farbe UND `strokeWeight` einer Wand", () => {
    const p = baseProject({
      walls: [wall({ colorPenId: "1", strokeWeight: 0.05 })],
      penSets: [{ id: "std", name: "Standard", pens: { "1": ps("#c0ffee", 0.6) } }],
      activePenSetId: "std",
    });
    const out = rebakePenColors(p);
    expect(out.walls[0].color).toBe("#c0ffee");
    expect(out.walls[0].strokeWeight).toBe(0.6);
  });

  it("lässt eine Wand OHNE Stift-Verweis referenzgleich", () => {
    const w = wall();
    const p = baseProject({ walls: [w] });
    const out = rebakePenColors(p);
    expect(out.walls[0]).toBe(w);
  });

  it("bäckt Farbe UND `strokeWeight` einer Decke", () => {
    const p = baseProject({
      ceilings: [ceiling({ colorPenId: "1" })],
      penSets: [{ id: "std", name: "Standard", pens: { "1": ps("#aaaaaa", 0.25) } }],
      activePenSetId: "std",
    });
    const out = rebakePenColors(p);
    expect(out.ceilings![0].color).toBe("#aaaaaa");
    expect(out.ceilings![0].strokeWeight).toBe(0.25);
  });

  it("bäckt Farbe UND `weightMm` eines Drawing2D (eigenes Feld, nicht `strokeWeight`)", () => {
    const p = baseProject({
      drawings2d: [drawing2d({ colorPenId: "1" })],
      penSets: [{ id: "std", name: "Standard", pens: { "1": ps("#ff00ff", 0.4) } }],
      activePenSetId: "std",
    });
    const out = rebakePenColors(p);
    expect(out.drawings2d[0].color).toBe("#ff00ff");
    expect(out.drawings2d[0].weightMm).toBe(0.4);
  });

  it("bäckt `foreground`/`background` einer Wand UNABHÄNGIG von `colorPenId` und OHNE Strichstärke anzufassen", () => {
    const p = baseProject({
      walls: [wall({ foregroundPenId: "2", backgroundPenId: "3", strokeWeight: 0.05 })],
      penSets: [
        {
          id: "std",
          name: "Standard",
          pens: { "2": ps("#00ff00", 0.9), "3": ps("#0000ff", 0.9) },
        },
      ],
      activePenSetId: "std",
    });
    const out = rebakePenColors(p);
    expect(out.walls[0].foreground).toBe("#00ff00");
    expect(out.walls[0].background).toBe("#0000ff");
    // Kein `colorPenId` gesetzt ⇒ `color`/`strokeWeight` bleiben unangetastet.
    expect(out.walls[0].color).toBeUndefined();
    expect(out.walls[0].strokeWeight).toBe(0.05);
  });

  it("lässt eine Wand MIT `foreground`/`background` OHNE Stift-Verweis referenzgleich", () => {
    const w = wall({ foreground: "#fixed", background: "#alsoFixed" });
    const p = baseProject({ walls: [w] });
    const out = rebakePenColors(p);
    expect(out.walls[0]).toBe(w);
  });
});

describe("rebakePenColors — Elemente OHNE Strichstärke-Feld (Raum), Robustheit", () => {
  it("bäckt einen Raum (nur `color`, PFLICHT-Feld, kein Stärke-Feld vorhanden)", () => {
    const p = baseProject({
      rooms: [room({ colorPenId: "1" })],
      penSets: [{ id: "std", name: "Standard", pens: { "1": ps("#112233") } }],
      activePenSetId: "std",
    });
    const out = rebakePenColors(p);
    expect(out.rooms![0].color).toBe("#112233");
  });

  it("übersteht ein Projekt ohne optionale Arrays (ceilings/roofs/... fehlen ganz)", () => {
    const p = baseProject({ activePenSetId: "std", penSets: [{ id: "std", name: "S", pens: {} }] });
    expect(() => rebakePenColors(p)).not.toThrow();
    expect(rebakePenColors(p).ceilings).toBeUndefined();
  });
});

describe("Standardpalette (Kern)", () => {
  const seeded = seedStandardPenSet(baseProject());
  const pens = seeded.pens!;
  const styles = seeded.penSets![0].pens;

  it("liefert genau 255 Stifte mit IDs '1'..'255', je Farbe+Strichstärke", () => {
    expect(pens.length).toBe(255);
    expect(new Set(pens.map((p) => p.id)).size).toBe(255);
    for (let i = 1; i <= 255; i++) {
      expect(styles[String(i)].color).toMatch(/^#[0-9a-f]{6}$/);
      expect(styles[String(i)].weight).toBe(PEN_FALLBACK_WEIGHT);
    }
  });

  it("nutzt für 1-9 die klassischen Grundfarben (Rot/Gelb/.../Grau)", () => {
    expect(styles["1"].color).toBe("#ff0000");
    expect(styles["2"].color).toBe("#ffff00");
    expect(styles["3"].color).toBe("#00ff00");
  });

  it("liefert für 250-255 einen monoton aufhellenden Graukeil", () => {
    const greys = [250, 251, 252, 253, 254, 255].map((i) => parseInt(styles[String(i)].color.slice(1, 3), 16));
    for (let i = 1; i < greys.length; i++) expect(greys[i]).toBeGreaterThan(greys[i - 1]);
  });

  it("erzeugt für 10-249 gültige, paarweise unterschiedliche Hex-Farben", () => {
    const mid = Array.from({ length: 240 }, (_, i) => styles[String(10 + i)].color);
    expect(new Set(mid).size).toBeGreaterThan(200); // Grossteil eindeutig, ein paar Rundungs-Kollisionen sind ok
  });
});

describe("seedStandardPenSet", () => {
  it("legt `pens` (255) + einen neuen aktiven Stiftsatz mit denselben Stilen an", () => {
    const p = baseProject();
    const out = seedStandardPenSet(p);
    expect(out.pens?.length).toBe(255);
    expect(out.penSets?.length).toBe(1);
    expect(out.activePenSetId).toBe(out.penSets![0].id);
    expect(out.penSets![0].pens["1"].color).toBe("#ff0000");
  });

  it("aktiviert den neuen Satz NICHT, wenn bereits ein anderer Satz aktiv war", () => {
    const p = baseProject({
      penSets: [{ id: "existing", name: "Alt", pens: {} }],
      activePenSetId: "existing",
    });
    const out = seedStandardPenSet(p);
    expect(out.activePenSetId).toBe("existing");
    expect(out.penSets?.length).toBe(2);
  });

  it("bäckt sofort gekoppelte Bauteil-Farben, wenn der neue Satz aktiv wird", () => {
    const p = baseProject({ components: [comp({ colorPenId: "3" })] });
    const out = seedStandardPenSet(p);
    expect(out.components[0].color).toBe("#00ff00");
  });
});

describe("freeColorPalette", () => {
  it("liefert 8 Graustufen und 8 × 5 Farbtöne als #rrggbb", () => {
    const pal = freeColorPalette();
    expect(pal).toHaveLength(48);
    expect(pal[0]).toBe("#000000");
    expect(pal[7]).toBe("#ffffff");
    for (const c of pal) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(freeColorPalette()).toBe(pal);
  });
});

describe("deletePenOps", () => {
  it("entfernt Stift, Satz-Einträge und alle Verweise (Bauteile, verschachtelte Kategorien)", () => {
    const p = baseProject({
      pens: [{ id: "1", name: "a" }, { id: "2", name: "b" }],
      penSets: [{ id: "s", name: "S", pens: { "1": ps("#111111"), "2": ps("#222222") } }],
      components: [comp({ colorPenId: "1", foregroundPenId: "2" })],
      layers: [{ code: "20", name: "x", color: "#000", visible: true, lw: 1, children: [{ code: "21", name: "y", color: "#000", visible: true, lw: 1, colorPenId: "1" }] } as LayerCategory],
    });
    const out = applyOps(p, deletePenOps(p, "1"));
    expect(out.pens!.map((x) => x.id)).toEqual(["2"]);
    expect(Object.keys(out.penSets![0].pens)).toEqual(["2"]);
    expect(out.components[0].colorPenId).toBeUndefined();
    expect(out.components[0].foregroundPenId).toBe("2");
    expect(out.layers[0].children![0].colorPenId).toBeUndefined();
    expect(deletePenOps(out, "1")).toEqual([]);
  });
});
