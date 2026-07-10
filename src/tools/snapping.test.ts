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

import { describe, it, expect } from "vitest";
import { computeSnap, snapCommonAngle, wallLayerBoundarySegments } from "./snapping";
import { DEFAULT_SNAP } from "./types";
import type { Drawing2D, Project, Vec2, Wall } from "../model/types";

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
    doors: [],
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

describe("wallLayerBoundarySegments", () => {
  it("liefert layers.length+1 Grenzlinien mit kumulierten Offsets (referenceLine=center)", () => {
    const w = wall("W1", { x: 0, y: 0 }, { x: 4, y: 0 });
    const segs = wallLayerBoundarySegments(wallProject(w), w);
    expect(segs).toHaveLength(4); // 3 Schichten → 4 Grenzlinien
    // Achse horizontal → leftNormal = (0,1); Offset erscheint als y-Koordinate.
    const offsets = segs.map(([a]) => a.y);
    expect(offsets[0]).toBeCloseTo(-0.225, 9); // −T/2 (Aussenfläche)
    expect(offsets[1]).toBeCloseTo(-0.125, 9); // −T/2 + 0.10
    expect(offsets[2]).toBeCloseTo(0.025, 9); // −T/2 + 0.10 + 0.15
    expect(offsets[3]).toBeCloseTo(0.225, 9); // +T/2 (Aussenfläche, innen)
    // Jede Grenzlinie läuft parallel zur Achse über die volle Wandlänge.
    for (const [a, b] of segs) {
      expect(a.y).toBeCloseTo(b.y, 9);
      expect(a.x).toBeCloseTo(0, 9);
      expect(b.x).toBeCloseTo(4, 9);
    }
  });

  it("verschiebt die Offsets um wallReferenceOffset bei referenceLine=left/right", () => {
    const wLeft = wall("W1", { x: 0, y: 0 }, { x: 4, y: 0 }, "left");
    const offLeft = wallLayerBoundarySegments(wallProject(wLeft), wLeft).map(([a]) => a.y);
    // refOff = +T/2 = 0.225 → Offsets laufen von 0 bis T (0.45).
    expect(offLeft[0]).toBeCloseTo(0, 9);
    expect(offLeft[3]).toBeCloseTo(0.45, 9);

    const wRight = wall("W1", { x: 0, y: 0 }, { x: 4, y: 0 }, "right");
    const offRight = wallLayerBoundarySegments(wallProject(wRight), wRight).map(([a]) => a.y);
    // refOff = −T/2 = −0.225 → Offsets laufen von −0.45 bis 0.
    expect(offRight[0]).toBeCloseTo(-0.45, 9);
    expect(offRight[3]).toBeCloseTo(0, 9);
  });

  it("liefert eine leere Liste bei unbekanntem Wandtyp (kein Crash im Snap-Pfad)", () => {
    const w = wall("W1", { x: 0, y: 0 }, { x: 4, y: 0 });
    w.wallTypeId = "unknown";
    expect(wallLayerBoundarySegments(wallProject(w), w)).toEqual([]);
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
    doors: [],
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
