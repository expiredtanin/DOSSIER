/**
 * Unit-Tests für den Wand-Schichttrennlinien-Snap:
 *  • `wallLayerBoundarySegments` muss die kumulierten Schicht-Offsets EXAKT so
 *    berechnen wie `addWallPoche` in `plan/generatePlan.ts` (Start bei
 *    `refOff − total/2`, danach `+= layer.thickness` je Schicht, inkl. beider
 *    Aussenflächen) — inklusive Referenzversatz (`center`/`left`/`right`).
 *  • `computeSnap` muss auf diesen Grenzlinien fangen (Endpunkt-Snap ist per
 *    Default aktiv), damit z. B. ein Decken-Umrisspunkt an einer einzelnen
 *    Wandschicht statt nur an Achse/Aussenkante enden kann.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeSnap, snapCommonAngle } from "./snapping";
import { DEFAULT_SNAP } from "./types";
import type { Ceiling, Column, Drawing2D, Project, Roof, Room, Stair, Vec2, Wall } from "../model/types";

/** Minimalprojekt mit einer dreischichtigen Wand (0.1 / 0.15 / 0.2 m). */
function wallProject(wall: Wall): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [
      {
        id: "aw",
        name: "AW",
        layers: [
          { componentId: "c", thickness: 0.1 },
          { componentId: "c", thickness: 0.15 },
          { componentId: "c", thickness: 0.2 },
        ],
      },
    ],
    drawingLevels: [
      {
        id: "eg",
        name: "EG",
        kind: "floor",
        visible: true,
        locked: false,
        floorHeight: 2.6,
        cutHeight: 1.0,
        baseElevation: 0,
      },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [wall],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

function wall(id: string, start: Vec2, end: Vec2, referenceLine?: Wall["referenceLine"]): Wall {
  return {
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start,
    end,
    wallTypeId: "aw",
    height: 2.6,
    referenceLine,
  };
}

/** Fang an `raw` auf dem Wand-Projekt (nur Objekt-Fang, kein Raster/Winkel). */
function snapWall(w: Wall, raw: Vec2) {
  return computeSnap({
    raw,
    project: wallProject(w),
    levelId: "eg",
    visibleCodes: new Set(["20"]),
    settings: { ...DEFAULT_SNAP, grid: false, commonAngles: false, ortho: false },
    draftPoints: [],
    lastPoint: null,
    pxPerMeter: 100,
    shift: false,
    ctrl: false,
  });
}

describe("Wand-Schichtgrenzen als Fang-Strecken (Kern `snap_model.rs`)", () => {
  // Achse horizontal → leftNormal = (0,1); die Grenzen liegen bei y = Offset, jede über die volle Länge.
  const cases: [Wall["referenceLine"], number[]][] = [
    ["center", [-0.225, -0.125, 0.025, 0.225]], // −T/2, −T/2 + 0.10, … +T/2
    ["left", [0, 0.1, 0.25, 0.45]], // refOff = +T/2
    ["right", [-0.45, -0.35, -0.2, 0]], // refOff = −T/2
  ];
  for (const [ref, offsets] of cases) {
    it(`fängt die Endpunkte aller layers.length+1 Grenzlinien (referenceLine=${ref})`, () => {
      const w = wall("W1", { x: 0, y: 0 }, { x: 4, y: 0 }, ref);
      for (const o of offsets) {
        for (const x of [0, 4]) {
          const r = snapWall(w, { x: x + 0.004, y: o + 0.004 });
          expect(r?.kind).toBe("endpoint");
          expect(r!.point.x).toBeCloseTo(x, 9);
          expect(r!.point.y).toBeCloseTo(o, 9);
        }
      }
    });
  }

  it("unbekannter Wandtyp: nur die Achse, keine Grenzlinien (kein Crash im Snap-Pfad)", () => {
    const w = wall("W1", { x: 0, y: 0 }, { x: 4, y: 0 });
    w.wallTypeId = "unknown";
    expect(snapWall(w, { x: 4.004, y: -0.13 })).toBeNull();
    expect(snapWall(w, { x: 4.004, y: 0.004 })?.point).toEqual({ x: 4, y: 0 });
  });
});

describe("computeSnap — fängt auf Wand-Schichttrennlinien", () => {
  it("fängt den Endpunkt einer inneren Schichtgrenze (nicht nur Achse/Aussenkante)", () => {
    const w = wall("W1", { x: 0, y: 0 }, { x: 4, y: 0 });
    const project = wallProject(w);
    // Endpunkt der Schichtgrenze bei y=0.025 (Fuge zwischen Schicht 2 und 3).
    const raw: Vec2 = { x: 0.01, y: 0.02 };
    const result = computeSnap({
      raw,
      project,
      levelId: "eg",
      visibleCodes: new Set(["20"]),
      settings: DEFAULT_SNAP,
      draftPoints: [],
      lastPoint: null,
      pxPerMeter: 100,
      shift: false,
      ctrl: false,
    });
    expect(result).not.toBeNull();
    expect(result!.point.x).toBeCloseTo(0, 6);
    expect(result!.point.y).toBeCloseTo(0.025, 6);
  });
});

// ── Kreis-/Bogen-Snaps (Center/Quadrant/Bogen-Endpunkt) ──────────────────────

/** Minimalprojekt mit gegebenen 2D-Geometrien auf dem Geschoss „eg". */
function drawProject(geoms: Drawing2D["geom"][]): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [],
    drawingLevels: [
      {
        id: "eg",
        name: "EG",
        kind: "floor",
        visible: true,
        locked: false,
        floorHeight: 2.6,
        cutHeight: 1.0,
        baseElevation: 0,
      },
    ],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: geoms.map((geom, i) => ({
      id: `d${i}`,
      type: "drawing2d" as const,
      levelId: "eg",
      categoryCode: "20",
      geom,
    })),
    context: [],
  };
}

function snapAt(project: Project, raw: Vec2, settings = DEFAULT_SNAP) {
  return computeSnap({
    raw,
    project,
    levelId: "eg",
    visibleCodes: new Set(["20"]),
    settings,
    draftPoints: [],
    lastPoint: null,
    pxPerMeter: 100,
    shift: false,
    ctrl: false,
  });
}

describe("computeSnap — Kreis/Bogen", () => {
  const withCenter = { ...DEFAULT_SNAP, center: true };

  it("fängt Mittelpunkt + Quadranten eines Kreises (center aktiv)", () => {
    const p = drawProject([{ shape: "circle", center: { x: 0, y: 0 }, r: 1 }]);
    const c = snapAt(p, { x: 0, y: 0 }, withCenter);
    expect(c?.kind).toBe("center");
    expect(c!.point.x).toBeCloseTo(0, 6);
    expect(c!.point.y).toBeCloseTo(0, 6);
    const q = snapAt(p, { x: 1, y: 0 }, withCenter);
    expect(q?.kind).toBe("quadrant");
    expect(q!.point.x).toBeCloseTo(1, 6);
    expect(q!.point.y).toBeCloseTo(0, 6);
  });

  it("fängt Bogen-Endpunkte (endpoint per Default aktiv)", () => {
    // Viertelbogen um (5,0), r=1, 0…90° → Endpunkte (6,0) und (5,1).
    const p = drawProject([
      { shape: "arc", center: { x: 5, y: 0 }, r: 1, a0: 0, a1: Math.PI / 2 },
    ]);
    const e = snapAt(p, { x: 6, y: 0 });
    expect(e?.kind).toBe("endpoint");
    expect(e!.point.x).toBeCloseTo(6, 6);
    expect(e!.point.y).toBeCloseTo(0, 6);
  });

  it("bietet Quadranten AUSSERHALB der Bogen-Spanne NICHT an", () => {
    // Viertelbogen 0…90°: der West-Quadrant (4,0) liegt NICHT im Bogen.
    const p = drawProject([
      { shape: "arc", center: { x: 5, y: 0 }, r: 1, a0: 0, a1: Math.PI / 2 },
    ]);
    const r = snapAt(p, { x: 4, y: 0 }, withCenter);
    expect(r?.kind).not.toBe("quadrant");
  });
});

// ── Weiches Winkel-Einrasten (snapCommonAngle) ──────────────────────────────

describe("snapCommonAngle", () => {
  const O: Vec2 = { x: 0, y: 0 };

  it("lässt einen exakten 45°-Winkel unverändert", () => {
    const r = snapCommonAngle(O, { x: 2, y: 2 });
    expect(r).not.toBeNull();
    expect(r!.angleDeg).toBeCloseTo(45, 9);
    expect(r!.point.x).toBeCloseTo(2, 9);
    expect(r!.point.y).toBeCloseTo(2, 9);
  });

  it("rastet 43.8° (innerhalb 2.5° Toleranz) auf 45°", () => {
    const rad = (43.8 * Math.PI) / 180;
    const raw: Vec2 = { x: Math.cos(rad) * 5, y: Math.sin(rad) * 5 };
    const r = snapCommonAngle(O, raw, 2.5);
    expect(r).not.toBeNull();
    expect(r!.angleDeg).toBeCloseTo(45, 9);
  });

  it("rastet NICHT bei 40° (5° Abweichung > 2.5° Toleranz)", () => {
    const rad = (40 * Math.PI) / 180;
    const raw: Vec2 = { x: Math.cos(rad) * 5, y: Math.sin(rad) * 5 };
    const r = snapCommonAngle(O, raw, 2.5);
    expect(r).toBeNull();
  });

  it("Länge = Projektion der Roh-Distanz auf den gerasterten Strahl", () => {
    const rad = (43.8 * Math.PI) / 180;
    const rawLen = 5;
    const raw: Vec2 = { x: Math.cos(rad) * rawLen, y: Math.sin(rad) * rawLen };
    const r = snapCommonAngle(O, raw, 2.5);
    expect(r).not.toBeNull();
    const expectedLen = rawLen * Math.cos(((45 - 43.8) * Math.PI) / 180);
    const len = Math.hypot(r!.point.x, r!.point.y);
    expect(len).toBeCloseTo(expectedLen, 9);
    // Der gerastete Punkt liegt exakt auf dem 45°-Strahl.
    expect(r!.point.x).toBeCloseTo(r!.point.y, 9);
  });

  it("normalisiert auf den Bereich (−180,180] — z. B. −135°", () => {
    const rad = (-133 * Math.PI) / 180;
    const raw: Vec2 = { x: Math.cos(rad) * 3, y: Math.sin(rad) * 3 };
    const r = snapCommonAngle(O, raw, 2.5);
    expect(r).not.toBeNull();
    expect(r!.angleDeg).toBeCloseTo(-135, 9);
  });

  it("deckt alle 15°-Vielfachen ab (0/30/45/60/90/135/…)", () => {
    for (const deg of [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, -15, -90, -135]) {
      const rad = (deg * Math.PI) / 180;
      const raw: Vec2 = { x: Math.cos(rad) * 4, y: Math.sin(rad) * 4 };
      const r = snapCommonAngle(O, raw, 2.5);
      expect(r, `deg=${deg}`).not.toBeNull();
      expect(r!.angleDeg, `deg=${deg}`).toBeCloseTo(deg === -180 ? 180 : deg, 9);
    }
  });

  it("liefert null bei Roh-Distanz ≈ 0 (kein Winkel bestimmbar)", () => {
    expect(snapCommonAngle(O, { x: 1e-10, y: 0 })).toBeNull();
  });
});

describe("computeSnap — Objekt-Snap hat Vorrang vor dem weichen Winkelraster", () => {
  it("fängt den Endpunkt statt auf das Winkelraster einzurasten, wenn beide zutreffen", () => {
    // Wand-Endpunkt bei (5,5) liegt exakt auf dem 45°-Strahl ab (0,0) — beide
    // Kandidaten (Endpunkt UND Winkelraster) träfen zu; der Endpunkt muss gewinnen.
    const w = wall2d({ x: 5, y: 5 }, { x: 8, y: 5 });
    const project = drawProject([]);
    project.walls = [w];
    const result = computeSnap({
      raw: { x: 5.02, y: 5.02 },
      project,
      levelId: "eg",
      visibleCodes: new Set(["20"]),
      settings: DEFAULT_SNAP,
      draftPoints: [],
      lastPoint: { x: 0, y: 0 },
      pxPerMeter: 100,
      shift: false,
      ctrl: false,
    });
    expect(result?.kind).toBe("endpoint");
    expect(result!.point.x).toBeCloseTo(5, 6);
    expect(result!.point.y).toBeCloseTo(5, 6);
  });

  it("rastet auf das Winkelraster, wenn KEIN Objekt-Snap in Reichweite ist", () => {
    const project = drawProject([]);
    const rad = (43.8 * Math.PI) / 180;
    const raw: Vec2 = { x: Math.cos(rad) * 5, y: Math.sin(rad) * 5 };
    const result = computeSnap({
      raw,
      project,
      levelId: "eg",
      visibleCodes: new Set(["20"]),
      settings: DEFAULT_SNAP,
      draftPoints: [],
      lastPoint: { x: 0, y: 0 },
      pxPerMeter: 100,
      shift: false,
      ctrl: false,
    });
    expect(result?.kind).toBe("angle");
    expect(result?.angleDeg).toBeCloseTo(45, 9);
  });

  it("respektiert settings.commonAngles=false (kein Winkelraster-Fallback)", () => {
    const project = drawProject([]);
    const rad = (45 * Math.PI) / 180;
    const raw: Vec2 = { x: Math.cos(rad) * 5, y: Math.sin(rad) * 5 };
    const result = computeSnap({
      raw,
      project,
      levelId: "eg",
      visibleCodes: new Set(["20"]),
      settings: { ...DEFAULT_SNAP, commonAngles: false, grid: false },
      draftPoints: [],
      lastPoint: { x: 0, y: 0 },
      pxPerMeter: 100,
      shift: false,
      ctrl: false,
    });
    expect(result).toBeNull();
  });
});

/** Minimal-Wand (nur für Endpunkt-Snap-Vorrang-Tests) — kein Wandtyp nötig. */
function wall2d(start: Vec2, end: Vec2): Wall {
  return {
    id: "w-angle-test",
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start,
    end,
    wallTypeId: "unknown",
    height: 2.6,
  };
}

// ── Teilpunkte (divide) — nur fangbar nach Verweilen ────────────────────────
// computeSnap hält den Verweil-Zustand modulweit (mehrere, unabhängige
// Aufrufer teilen ihn sich, s. Kommentar dort) — Date.now()-basiert, daher
// hier mit Fake-Timern gesteuert statt echter Wartezeit.
describe("computeSnap — Teilpunkte (divide) nach Verweilen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fängt NICHT auf dem Drittelpunkt, solange der Cursor noch nicht lange genug verweilt hat", () => {
    const project = drawProject([{ shape: "line", a: { x: 0, y: 0 }, b: { x: 9, y: 0 } }]);
    const settings = { ...DEFAULT_SNAP, hoverDivideDelayMs: 300, hoverDivideCount: 3 };
    const result = snapAt(project, { x: 3, y: 0.02 }, settings);
    expect(result?.kind).not.toBe("divide");
  });

  it("fängt auf dem Drittelpunkt, sobald der Cursor lange genug auf derselben Linie verweilt hat", () => {
    const project = drawProject([{ shape: "line", a: { x: 0, y: 0 }, b: { x: 9, y: 0 } }]);
    const settings = { ...DEFAULT_SNAP, hoverDivideDelayMs: 300, hoverDivideCount: 3 };
    const raw: Vec2 = { x: 3, y: 0.02 };
    snapAt(project, raw, settings); // erster Aufruf verankert nur den Verweil-Beginn
    vi.advanceTimersByTime(350);
    const result = snapAt(project, raw, settings);
    expect(result?.kind).toBe("divide");
    expect(result?.point.x).toBeCloseTo(3, 6); // 1/3 von 9
    expect(result?.point.y).toBeCloseTo(0, 6);
  });

  it("verwirft den Verweil, sobald der Cursor zwischenzeitlich auf eine ANDERE Linie wechselt", () => {
    const project = drawProject([
      { shape: "line", a: { x: 0, y: 0 }, b: { x: 9, y: 0 } },
      { shape: "line", a: { x: 0, y: 5 }, b: { x: 9, y: 5 } },
    ]);
    const settings = { ...DEFAULT_SNAP, hoverDivideDelayMs: 300, hoverDivideCount: 3 };
    snapAt(project, { x: 3, y: 0.02 }, settings);
    vi.advanceTimersByTime(350);
    snapAt(project, { x: 3, y: 5.02 }, settings); // andere Linie dazwischen
    const result = snapAt(project, { x: 3, y: 0.02 }, settings);
    expect(result?.kind).not.toBe("divide");
  });
});

// ── Raum-/Decken-/Dach-/Treppen-/Stützen-Umrisse (bisher komplett blind) ────

function bimSnapProject(overrides: Partial<Project>): Project {
  return { ...drawProject([]), ...overrides };
}

function ceiling(outline: Vec2[], openings?: Vec2[][]): Ceiling {
  return { id: "c1", type: "ceiling", floorId: "eg", categoryCode: "20", outline, openings, wallTypeId: "wt1" };
}

function room(boundary: Vec2[]): Room {
  return { id: "r1", type: "room", floorId: "eg", categoryCode: "20", siaCategory: "HNF", name: "R", boundary, color: "#fff" };
}

function roof(outline: Vec2[]): Roof {
  return { id: "rf1", type: "roof", floorId: "eg", categoryCode: "20", outline, shape: "flach", pitchDeg: 0, overhang: 0.5, ridgeAxis: "x", thickness: 0.3 };
}

function straightStair(): Stair {
  return { id: "s1", type: "stair", floorId: "eg", categoryCode: "20", shape: "straight", start: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, runLength: 3, width: 1.2, stepCount: 18 };
}

function spiralStair(): Stair {
  return {
    id: "s2", type: "stair", floorId: "eg", categoryCode: "20", shape: "spiral",
    start: { x: 1, y: 0 }, dir: { x: 0, y: 1 }, runLength: 0, width: 1, stepCount: 12,
    center: { x: 0, y: 0 }, radius: 1, sweep: 270,
  };
}

function rectColumn(): Column {
  return { id: "col1", type: "column", floorId: "eg", categoryCode: "20", position: { x: 5, y: 5 }, profile: { kind: "rect", width: 0.4, depth: 0.4 }, rotation: 0, height: 2.6 };
}

function roundColumn(): Column {
  return { id: "col2", type: "column", floorId: "eg", categoryCode: "20", position: { x: -3, y: -3 }, profile: { kind: "round", radius: 0.25 }, rotation: 0, height: 2.6 };
}

describe("computeSnap — Raum-/Decken-/Dach-Umriss (Endpunkt/Kante)", () => {
  it("fängt eine Raum-Ecke", () => {
    const p = bimSnapProject({ rooms: [room([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }])] });
    const r = snapAt(p, { x: 4.02, y: 0.01 });
    expect(r?.kind).toBe("endpoint");
    expect(r!.point).toEqual({ x: 4, y: 0 });
  });

  it("fängt den Lotfusspunkt auf einer Raumkante (onEdge)", () => {
    const p = bimSnapProject({ rooms: [room([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }])] });
    // x=1.3 bewusst NICHT der Kantenmittelpunkt (x=2, sonst gewönne "midpoint").
    const r = snapAt(p, { x: 1.3, y: 0.02 });
    expect(r?.kind).toBe("onEdge");
    expect(r!.point.x).toBeCloseTo(1.3, 6);
    expect(r!.point.y).toBeCloseTo(0, 6);
  });

  it("fängt eine Decken-Ecke UND eine Aussparungs-Ecke", () => {
    const p = bimSnapProject({
      ceilings: [ceiling([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], [[{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }]])],
    });
    const outer = snapAt(p, { x: 4.02, y: 0.01 });
    expect(outer?.point).toEqual({ x: 4, y: 0 });
    const hole = snapAt(p, { x: 1.98, y: 1.01 });
    expect(hole?.point).toEqual({ x: 2, y: 1 });
  });

  it("fängt eine Dach-Ecke", () => {
    const p = bimSnapProject({ roofs: [roof([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 8 }, { x: 0, y: 8 }])] });
    const r = snapAt(p, { x: 0.02, y: 8.01 });
    expect(r?.point).toEqual({ x: 0, y: 8 });
  });
});

describe("computeSnap — Treppen-Umriss", () => {
  it("fängt eine Ecke einer geraden Treppe", () => {
    const p = bimSnapProject({ stairs: [straightStair()] });
    // Lauf 3m × Breite 1.2m entlang +x ab (0,0), mittig referenziert → Ecke bei (3,0.6).
    const r = snapAt(p, { x: 3.01, y: 0.59 });
    expect(r?.kind).toBe("endpoint");
    expect(r!.point.x).toBeCloseTo(3, 6);
    expect(r!.point.y).toBeCloseTo(0.6, 6);
  });

  it("fängt das Zentrum einer Wendeltreppe (center aktiv)", () => {
    const p = bimSnapProject({ stairs: [spiralStair()] });
    // intersection aus: die beiden radialen Abschlusslinien schneiden sich als
    // UNENDLICHE Geraden ebenfalls im Zentrum — hier soll isoliert der
    // eigene Kreis-Center-Kandidat (aus `spiral.arcs`) geprüft werden.
    const withCenter = { ...DEFAULT_SNAP, center: true, intersection: false };
    const c = snapAt(p, { x: 0.02, y: -0.01 }, withCenter);
    expect(c?.kind).toBe("center");
    expect(c!.point).toEqual({ x: 0, y: 0 });
  });
});

describe("computeSnap — Stützen (rechteckig via Kanten, rund via Zentrum)", () => {
  it("fängt eine Ecke einer rechteckigen Stütze", () => {
    const p = bimSnapProject({ columns: [rectColumn()] });
    const r = snapAt(p, { x: 5.21, y: 5.19 });
    expect(r?.kind).toBe("endpoint");
    expect(r!.point.x).toBeCloseTo(5.2, 6);
    expect(r!.point.y).toBeCloseTo(5.2, 6);
  });

  it("fängt das Zentrum einer runden Stütze (center aktiv), keine Vieleck-Ecken", () => {
    const p = bimSnapProject({ columns: [roundColumn()] });
    const withCenter = { ...DEFAULT_SNAP, center: true };
    const c = snapAt(p, { x: -2.99, y: -3.01 }, withCenter);
    expect(c?.kind).toBe("center");
    expect(c!.point).toEqual({ x: -3, y: -3 });
  });
});

// ── Senkrecht/Tangential/Parallel zu Referenz (Nutzer-Wunsch, s. PENDENZEN) ──
// Alle drei brauchen zwingend einen `lastPoint` — daher hier über einen
// eigenen Helper statt `snapAt` (der `lastPoint` fest auf `null` setzt), und
// mit ansonsten ALLEN Objekt-Snaps aus (isoliert), um Interferenzen mit den
// bereits oben getesteten Fang-Arten auszuschliessen.
const ISOLATED_OFF = {
  ...DEFAULT_SNAP,
  endpoint: false,
  midpoint: false,
  intersection: false,
  onEdge: false,
  center: false,
  perpendicular: false,
  tangent: false,
  parallel: false,
  grid: false,
  ortho: false,
  commonAngles: false,
};

function snapFrom(
  project: Project,
  raw: Vec2,
  lastPoint: Vec2 | null,
  settings: typeof DEFAULT_SNAP,
) {
  return computeSnap({
    raw,
    project,
    levelId: "eg",
    visibleCodes: new Set(["20"]),
    settings,
    draftPoints: [],
    lastPoint,
    pxPerMeter: 100,
    shift: false,
    ctrl: false,
  });
}

describe("computeSnap — Senkrecht zum letzten Punkt (perpendicular)", () => {
  it("fängt den Lotfusspunkt VOM LETZTEN PUNKT aus (nicht vom Cursor)", () => {
    const p = drawProject([{ shape: "line", a: { x: 0, y: 0 }, b: { x: 4, y: 0 } }]);
    const settings = { ...ISOLATED_OFF, perpendicular: true };
    // lastPoint (2,3) → Lot auf die Linie y=0 liegt bei (2,0); der Cursor muss
    // nur NAHE (2,0) sein, nicht selbst auf der Linie.
    const r = snapFrom(p, { x: 2.01, y: 0.02 }, { x: 2, y: 3 }, settings);
    expect(r?.kind).toBe("perpendicular");
    expect(r!.point.x).toBeCloseTo(2, 6);
    expect(r!.point.y).toBeCloseTo(0, 6);
  });

  it("bleibt wirkungslos ohne lastPoint", () => {
    const p = drawProject([{ shape: "line", a: { x: 0, y: 0 }, b: { x: 4, y: 0 } }]);
    const settings = { ...ISOLATED_OFF, perpendicular: true };
    const r = snapFrom(p, { x: 2.01, y: 0.02 }, null, settings);
    expect(r).toBeNull();
  });
});

describe("computeSnap — Tangential an Kreis/Bogen (tangent)", () => {
  it("fängt einen der beiden Tangentenpunkte von aussen (rechtwinklig zum Radius)", () => {
    const center = { x: 5, y: 0 };
    const r = 2;
    const lastPoint = { x: 5, y: 6 };
    const p = drawProject([{ shape: "circle", center, r }]);
    const d = Math.hypot(lastPoint.x - center.x, lastPoint.y - center.y);
    const thetaCP = Math.atan2(lastPoint.y - center.y, lastPoint.x - center.x);
    const angAtC = Math.acos(r / d);
    const t1 = {
      x: center.x + r * Math.cos(thetaCP + angAtC),
      y: center.y + r * Math.sin(thetaCP + angAtC),
    };
    const settings = { ...ISOLATED_OFF, tangent: true };
    const result = snapFrom(p, t1, lastPoint, settings);
    expect(result?.kind).toBe("tangent");
    expect(result!.point.x).toBeCloseTo(t1.x, 6);
    expect(result!.point.y).toBeCloseTo(t1.y, 6);
    // Geometrische Gegenprobe: Tangente steht rechtwinklig auf dem Radius.
    const toLast = { x: lastPoint.x - result!.point.x, y: lastPoint.y - result!.point.y };
    const toCenter = { x: center.x - result!.point.x, y: center.y - result!.point.y };
    expect(toLast.x * toCenter.x + toLast.y * toCenter.y).toBeCloseTo(0, 6);
  });

  it("bietet keine Tangente an, wenn lastPoint innerhalb des Kreises liegt", () => {
    const p = drawProject([{ shape: "circle", center: { x: 0, y: 0 }, r: 2 }]);
    const settings = { ...ISOLATED_OFF, tangent: true };
    const r = snapFrom(p, { x: 1, y: 0 }, { x: 0, y: 0 }, settings);
    expect(r).toBeNull();
  });

  it("bietet einen Tangentenpunkt AUSSERHALB der Bogen-Spanne NICHT an", () => {
    // Halbkreis 0..180° (a0=0, a1=π): ein von UNTEN (negatives y) angesetzter
    // lastPoint hätte seinen Tangentenpunkt ausserhalb dieser Spanne.
    const center = { x: 0, y: 0 };
    const r = 1;
    const p = drawProject([{ shape: "arc", center, r, a0: 0, a1: Math.PI }]);
    const settings = { ...ISOLATED_OFF, tangent: true };
    const lastPoint = { x: 0, y: -5 }; // deutlich unterhalb des Bogens
    // Beide Tangentenpunkte einer Kreis-von-unten-Konstruktion liegen im
    // UNTEREN Halbkreis (ausserhalb 0..π) — kein Treffer erwartet, egal wo
    // der Cursor auf dem (vollen) Kreis steht.
    const r1 = snapFrom(p, { x: -0.99, y: -0.14 }, lastPoint, settings);
    expect(r1?.kind).not.toBe("tangent");
  });
});

describe("computeSnap — Parallel zu erfasster Referenz (parallel)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fängt NICHT parallel, solange die Referenzlinie noch nicht lange genug erfasst wurde", () => {
    const p = drawProject([{ shape: "line", a: { x: 0, y: 0 }, b: { x: 9, y: 0 } }]);
    const settings = { ...ISOLATED_OFF, parallel: true, hoverDivideDelayMs: 300 };
    const r = snapFrom(p, { x: 3, y: 0.02 }, { x: 1, y: 5 }, settings);
    expect(r?.kind).not.toBe("parallel");
  });

  it("fängt auf der Parallelen DURCH lastPoint, sobald die Referenz erfasst ist", () => {
    const p = drawProject([{ shape: "line", a: { x: 0, y: 0 }, b: { x: 9, y: 0 } }]);
    const settings = { ...ISOLATED_OFF, parallel: true, hoverDivideDelayMs: 300 };
    const lastPoint = { x: 1, y: 5 };
    const onLine = { x: 3, y: 0.02 };
    // Erfassen: Cursor lange genug auf DERSELBEN Stelle der Referenzlinie
    // halten (zwei Aufrufe, wie bei "divide" — der erste verankert nur den
    // Verweil-Beginn, erst der zweite NACH Ablauf der Verweilzeit erfasst).
    snapFrom(p, onLine, lastPoint, settings);
    vi.advanceTimersByTime(350);
    snapFrom(p, onLine, lastPoint, settings);
    // Jetzt zum eigentlichen Zielbereich bewegen: die Parallele zu y=0 durch
    // lastPoint (1,5) ist die Gerade y=5 — der Cursor muss dort fangen (die
    // Erfassung bleibt STICKY bestehen), NICHT mehr auf der Referenzlinie
    // selbst sein.
    const result = snapFrom(p, { x: 6.01, y: 5.02 }, lastPoint, settings);
    expect(result?.kind).toBe("parallel");
    // Projektion auf die Parallele (horizontal, durch lastPoint bei y=5): die
    // y-Koordinate wird auf 5 eingerastet, die x-Koordinate folgt frei dem
    // Cursor (keine Rundung) — daher x bleibt 6.01, nur y wird zu 5.
    expect(result!.point.x).toBeCloseTo(6.01, 6);
    expect(result!.point.y).toBeCloseTo(5, 6);
  });

  it("bleibt wirkungslos ohne lastPoint (nur die Referenz wäre erfasst)", () => {
    const p = drawProject([{ shape: "line", a: { x: 0, y: 0 }, b: { x: 9, y: 0 } }]);
    const settings = { ...ISOLATED_OFF, parallel: true, hoverDivideDelayMs: 300 };
    snapFrom(p, { x: 3, y: 0.02 }, null, settings);
    vi.advanceTimersByTime(350);
    const result = snapFrom(p, { x: 6, y: 5 }, null, settings);
    expect(result?.kind).not.toBe("parallel");
  });
});

describe("computeSnap — Spline (fit- vs. control-Modus)", () => {
  const pts = [{ x: 0, y: 0 }, { x: 2, y: 10 }, { x: 6, y: 10 }, { x: 8, y: 0 }];

  it("fit-Modus (Default): fängt AUF dem inneren Wegpunkt (Catmull-Rom interpoliert, taucht als Vertex der Tessellierung auf)", () => {
    const p = drawProject([{ shape: "spline", pts, closed: false, mode: "fit" }]);
    const r = snapAt(p, { x: 2, y: 10 });
    expect(r?.kind).toBe("endpoint");
    expect(r!.point.x).toBeCloseTo(2, 6);
    expect(r!.point.y).toBeCloseTo(10, 6);
  });

  it("control-Modus: fängt NICHT auf dem inneren Kontrollpunkt (B-Spline berührt/nähert ihn nicht — kein endpoint-/onEdge-Treffer)", () => {
    const p = drawProject([{ shape: "spline", pts, closed: false, mode: "control" }]);
    const r = snapAt(p, { x: 2, y: 10 });
    expect(r?.kind).not.toBe("endpoint");
    expect(r?.kind).not.toBe("onEdge");
  });

  it("control-Modus: fängt trotzdem auf dem geklemmten Start-/Endpunkt", () => {
    const p = drawProject([{ shape: "spline", pts, closed: false, mode: "control" }]);
    const r = snapAt(p, { x: 8, y: 0 });
    expect(r?.point.x).toBeCloseTo(8, 6);
    expect(r?.point.y).toBeCloseTo(0, 6);
  });
});

// ── Grosse Projekte (Kataster-Import): Fang nur in Cursornähe ────────────────
// Regression: bei ~10^5 Zeichnungen baute computeSnap bei JEDER Mausbewegung die
// Liste aller Strecken und prüfte beim Schnittpunkt-Fang alle Paare (O(N²)) —
// die Seite blockierte beim ersten Klick eines Zeichenwerkzeugs.

describe("computeSnap — grosse Projekte", () => {
  const ALL = { ...DEFAULT_SNAP, endpoint: true, midpoint: true, onEdge: true, intersection: true, perpendicular: true };

  /** Gemeinsame Geometrie nahe am Ursprung + (optional) viele weit entfernte Linien. */
  const geoms = (far: number): Drawing2D["geom"][] => {
    const near: Drawing2D["geom"][] = [
      { shape: "line", a: { x: 0, y: 0 }, b: { x: 4, y: 0 } },
      { shape: "line", a: { x: 2, y: -2 }, b: { x: 2, y: 2 } },
      { shape: "polyline", pts: [{ x: 6, y: 0 }, { x: 8, y: 1 }, { x: 8, y: 3 }], closed: false },
      { shape: "circle", center: { x: -3, y: 0 }, r: 1 },
    ];
    for (let i = 0; i < far; i++) {
      const x = 1000 + (i % 200) * 5, y = 1000 + Math.floor(i / 200) * 5;
      near.push({ shape: "line", a: { x, y }, b: { x: x + 3, y: y + 2 } });
    }
    return near;
  };

  it("liefert in Cursornähe dasselbe wie das kleine Projekt (End-/Mittel-/Schnitt-/Randpunkt)", () => {
    const small = drawProject(geoms(0));
    const large = drawProject(geoms(3000)); // > Schwelle → Nähe-Modus
    const probes: Vec2[] = [
      { x: 0.02, y: 0.03 }, // Endpunkt
      { x: 2.01, y: 0.02 }, // Schnittpunkt der beiden Linien
      { x: 1.0, y: 0.015 }, // Rand der ersten Linie
      { x: 8.01, y: 2.0 }, // Polylinie
      { x: -2.0, y: 0.01 }, // Kreis (Quadrant)
      { x: 3.0, y: 0.02 },
    ];
    for (const raw of probes) {
      const a = snapAt(small, raw, ALL);
      const b = snapAt(large, raw, ALL);
      expect(b?.kind).toBe(a?.kind);
      expect(b?.point.x ?? NaN).toBeCloseTo(a?.point.x ?? NaN, 9);
      expect(b?.point.y ?? NaN).toBeCloseTo(a?.point.y ?? NaN, 9);
    }
  });

  it("fängt auch zwischen den vielen entfernten Linien (Endpunkt) und bleibt schnell", () => {
    const big = drawProject(geoms(60000)); // ~ Grössenordnung eines Kataster-Imports
    const t = performance.now();
    const r = snapAt(big, { x: 1000.01, y: 1000.01 }, ALL);
    const first = performance.now() - t; // inkl. einmaligem Aufbau des Index
    expect(r?.kind).toBe("endpoint");
    expect(r!.point.x).toBeCloseTo(1000, 6);
    const t2 = performance.now();
    for (let i = 0; i < 20; i++) snapAt(big, { x: 1000.01 + i * 0.001, y: 1000.01 }, ALL);
    const perCall = (performance.now() - t2) / 20;
    expect(first).toBeLessThan(3000);
    expect(perCall).toBeLessThan(50);
  });
});
