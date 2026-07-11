/**
 * Unit-Tests für den Ansichts-Generator (toElevation.ts): Projektion einer
 * bekannten Fläche auf (u, v)+Tiefe, Rückseiten-Culling, Painter-Reihenfolge
 * (nähere Fassade NACH der ferneren) und Schlagschatten (nur mit shadows=true).
 * Alles rein geometrisch auf synthetischen RWall/RSlab-Fixtures bzw. einem
 * Minimalprojekt — KEIN WASM.
 */

import { describe, it, expect } from "vitest";
import type { Project, Wall } from "../model/types";
import type { RModel3d, RSlab, RWall } from "./toWalls3d";
import type { SectionPlaneSpec } from "./toSection";
import {
  buildShadows,
  collectElevationFaces,
  elevationFrame,
  generateElevationPlan,
  projectFace,
  projectPoint,
  wallWorldFaces,
} from "./toElevation";

// Betrachter im Süden (world z = −2), Blick nach +Z (in die Szene). Damit liegt
// eine Wand bei z ≈ 0 HINTER der Ebene (depth > 0) und ihre Süd-Langseite zeigt
// zum Betrachter (front-facing).
const PLANE_SOUTH: SectionPlaneSpec = { point: [-1, 0, -2], normal: [0, 0, 1] };

function wall(over: Partial<RWall> = {}): RWall {
  return {
    start: [0, 0],
    end: [4, 0],
    thickness: 0.2,
    height: 3,
    baseElevation: 0,
    color: [0.8, 0.8, 0.8],
    layers: [],
    wallId: "W",
    ...over,
  };
}

describe("toElevation — Projektion + Culling", () => {
  it("projiziert einen Weltpunkt auf (u, v, depth)", () => {
    const frame = elevationFrame(PLANE_SOUTH);
    // Punkt auf der Süd-Fassade (z ≈ −0.1), x = 4, Höhe 3.
    const p = projectPoint(frame, [4, 3, -0.1]);
    expect(p.v).toBeCloseTo(3, 6); // v = absolute Höhe
    expect(p.depth).toBeCloseTo(1.9, 6); // −0.1 − (−2) = 1.9 hinter der Ebene
    // u = dot(rel, U); U (entspiegelt, Blick +z ⇒ rechts = +x) = [1, 0, 0],
    // P.x = −1 → u = 4 − (−1) = 5.
    expect(p.u).toBeCloseTo(5, 6);
  });

  it("Süd-Langseite einer Wand: erwartetes (u, v)-Rechteck + Tiefe, Rückseite gecullt", () => {
    const frame = elevationFrame(PLANE_SOUTH);
    const faces = wallWorldFaces(wall());
    const projected = faces.map((f) => projectFace(frame, f));
    // Genau EINE sichtbare Fläche (die Süd-Langseite); alle anderen sind
    // Rückseiten oder streifend (Deckel/Boden/Stirnkappen).
    const visible = projected.filter((p) => p !== null);
    expect(visible.length).toBe(1);
    const face = visible[0]!;
    expect(face.wallId).toBe("W");
    const us = face.pts.map((p) => p[0]);
    const vs = face.pts.map((p) => p[1]);
    expect(Math.min(...us)).toBeCloseTo(1, 6); // x=0 → u=1 (P.x=−1)
    expect(Math.max(...us)).toBeCloseTo(5, 6); // x=4 → u=5
    expect(Math.min(...vs)).toBeCloseTo(0, 6);
    expect(Math.max(...vs)).toBeCloseTo(3, 6);
    expect(face.depth).toBeCloseTo(1.9, 6);
  });

  it("Rückseiten-Culling: eine Fläche mit Normale VON der Ebene weg erscheint nicht", () => {
    const frame = elevationFrame(PLANE_SOUTH);
    const faces = wallWorldFaces(wall());
    // Die +Quer-Fläche (Nord-Langseite, Normale [0,0,−1]·N = −1 … eigentlich die
    // Süd-Seite ist sichtbar) — hier prüfen wir explizit die Rückseite:
    const north = faces.find((f) => f.normal[2] > 0.5); // Normale zeigt +Z (= mit N)
    expect(north).toBeDefined();
    expect(projectFace(frame, north!)).toBeNull();
  });
});

describe("toElevation — Painter-Reihenfolge", () => {
  it("nähere Fassade wird NACH der ferneren emittiert", () => {
    const frame = elevationFrame(PLANE_SOUTH);
    const model: RModel3d = {
      walls: [
        wall({ wallId: "NEAR", start: [0, 0], end: [4, 0] }), // z ≈ 0 → näher
        wall({ wallId: "FAR", start: [0, 3], end: [4, 3] }), // z ≈ 3 → ferner
      ],
      slabs: [],
      meshes: [],
    };
    const faces = collectElevationFaces(model, frame);
    const near = faces.find((f) => f.wallId === "NEAR")!;
    const far = faces.find((f) => f.wallId === "FAR")!;
    expect(near.depth).toBeLessThan(far.depth);
  });

  it("im Plan: nähere Wand-Fläche hat einen höheren Primitiv-Index", () => {
    const project = elevationProject({ overhang: false });
    const plan = generateElevationPlan(project, project.drawingLevels[1])!;
    expect(plan).not.toBeNull();
    const idxNear = plan.primitives.findIndex(
      (p) => p.kind === "polygon" && p.wallId === "NEAR",
    );
    const idxFar = plan.primitives.findIndex(
      (p) => p.kind === "polygon" && p.wallId === "FAR",
    );
    expect(idxNear).toBeGreaterThanOrEqual(0);
    expect(idxFar).toBeGreaterThanOrEqual(0);
    expect(idxNear).toBeGreaterThan(idxFar); // fern zuerst, nah zuletzt
  });
});

describe("toElevation — Schlagschatten", () => {
  it("buildShadows: Überstand vor einer Fassade wirft ein Schatten-Polygon", () => {
    const frame = elevationFrame(PLANE_SOUTH);
    // Wandfläche (Fassade) hinter dem Überstand.
    const wallFaces = collectElevationFaces(
      { walls: [wall()], slabs: [], meshes: [] },
      frame,
    );
    // Überstand-Slab, der VOR der Wand (näher, z < −0.1) liegt und sie u-seitig
    // überdeckt.
    const slab: RSlab = {
      outline: [
        [0, -0.6],
        [4, -0.6],
        [4, 0.2],
        [0, 0.2],
      ],
      zBottom: 2.8,
      zTop: 3,
      color: [0.9, 0.9, 0.9],
      ceilingId: "R",
    };
    const slabFaces = collectElevationFaces(
      { walls: [], slabs: [slab], meshes: [] },
      frame,
    );
    const shadows = buildShadows(wallFaces, slabFaces);
    expect(shadows.length).toBeGreaterThan(0);
  });

  it("buildShadows: kein Überlapp → keine Schatten", () => {
    const frame = elevationFrame(PLANE_SOUTH);
    const wallFaces = collectElevationFaces(
      { walls: [wall({ start: [0, 0], end: [4, 0] })], slabs: [], meshes: [] },
      frame,
    );
    // Slab weit seitlich versetzt (u außerhalb der Wand).
    const slab: RSlab = {
      outline: [
        [20, -0.6],
        [24, -0.6],
        [24, 0.2],
        [20, 0.2],
      ],
      zBottom: 2.8,
      zTop: 3,
      color: [0.9, 0.9, 0.9],
      ceilingId: "R",
    };
    const slabFaces = collectElevationFaces(
      { walls: [], slabs: [slab], meshes: [] },
      frame,
    );
    expect(buildShadows(wallFaces, slabFaces).length).toBe(0);
  });

  it("im Plan: shadows=true erzeugt zusätzliche Schatten-Primitive, false exakt keine", () => {
    const project = elevationProject({ overhang: true });
    const level = project.drawingLevels[1];
    const withOff = generateElevationPlan(project, level, { shadows: false })!;
    const withOn = generateElevationPlan(project, level, { shadows: true })!;
    // Schatten sind randlose (stroke "none") Polygone im festen Schattengrau.
    const shadowCount = (plan: typeof withOn) =>
      plan.primitives.filter(
        (p) => p.kind === "polygon" && p.stroke === "none" && p.fill === "#8f959e",
      ).length;
    expect(shadowCount(withOff)).toBe(0);
    expect(shadowCount(withOn)).toBeGreaterThan(0);
  });
});

describe("toElevation — Fallback", () => {
  it("ohne linePoints liefert generateElevationPlan null", () => {
    const project = elevationProject({ overhang: false });
    const bare = { ...project.drawingLevels[1], linePoints: undefined };
    expect(generateElevationPlan(project, bare)).toBeNull();
  });
});

// ── Minimalprojekt-Factory ──────────────────────────────────────────────────
// Zwei parallele Wände (nah/fern) + optional eine auskragende Dach-Decke.
function elevationProject(opts: { overhang: boolean }): Project {
  const w = (id: string, y: number): Wall => ({
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start: { x: 0, y },
    end: { x: 4, y },
    wallTypeId: "aw",
    height: 3,
  });
  const project: Project = {
    id: "t",
    name: "T",
    lineStyles: [{ id: "thin", name: "d", weight: 0.13, color: "#111", dash: null }],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [{ id: "a", name: "A", color: "#d8d2c7", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "a", thickness: 0.2 }] }],
    ceilingTypes: [{ id: "dc", name: "Dach", layers: [{ componentId: "a", thickness: 0.2 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 3, cutHeight: 1, baseElevation: 0 },
      {
        id: "ans",
        name: "Ansicht Süd",
        kind: "elevation",
        visible: true,
        locked: false,
        linePoints: [{ x: -1, y: -2 }, { x: 5, y: -2 }],
        directionSign: 1,
      },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [w("NEAR", 0), w("FAR", 3)],
    doors: [],
    openings: [],
    ceilings: opts.overhang
      ? [
          {
            id: "R",
            type: "ceiling",
            floorId: "eg",
            categoryCode: "20",
            wallTypeId: "aw",
            ceilingTypeId: "dc",
            // Umriss ragt nach Süden (y < 0) über die Süd-Wand (y=0) hinaus.
            outline: [
              { x: 0, y: -0.6 },
              { x: 4, y: -0.6 },
              { x: 4, y: 0.2 },
              { x: 0, y: 0.2 },
            ],
          },
        ]
      : [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
  return project;
}

describe("toElevation — Hidden-Line-Clipping (keine Durchsicht)", () => {
  // Zwei deckungsgleiche Wände (NEAR vor FAR): die hintere Silhouette liegt
  // vollständig hinter der vorderen und darf KEINE Umrisslinie beisteuern —
  // sonst „scheint" die Hinterwand durch (Nutzer-Report). Erwartet: genau die
  // 4 Kanten der vorderen Wand.
  it("deckungsgleiche Hinterwand trägt keine Umrisslinie bei", () => {
    const project = elevationProject({ overhang: false });
    const plan = generateElevationPlan(project, project.drawingLevels[1])!;
    const outlineLines = plan.primitives.filter(
      (p) => p.kind === "line" && (p as { cls?: string }).cls === "elevation-outline",
    );
    // Nur die 4 Kanten der NEAR-Fassade (FAR ist vollständig geclippt).
    expect(outlineLines.length).toBe(4);
  });

  it("höhere Hinterwand: nur der ÜBERSTEHENDE Teil bleibt sichtbar", () => {
    const base = elevationProject({ overhang: false });
    // FAR-Wand höher machen (4 statt 3 m) → ihr oberer Rand ragt über NEAR.
    const project: Project = {
      ...base,
      walls: base.walls.map((w) => (w.id === "FAR" ? { ...w, height: 4 } : w)),
    };
    const plan = generateElevationPlan(project, project.drawingLevels[1])!;
    const outline = plan.primitives.filter(
      (p) => p.kind === "line" && (p as { cls?: string }).cls === "elevation-outline",
    ) as Array<{ a: { x: number; y: number }; b: { x: number; y: number } }>;
    // Eine horizontale Kante bei v≈4 (FAR-Oberkante, sichtbar über NEAR) …
    const hasFarTop = outline.some(
      (l) => Math.abs(l.a.y - 4) < 1e-4 && Math.abs(l.b.y - 4) < 1e-4,
    );
    expect(hasFarTop).toBe(true);
    // … aber KEINE horizontale Kante bei v≈0 aus FAR im von NEAR verdeckten
    // Bereich: die einzige v≈0-Kante ist NEARs Unterkante (die FAR-Unterkante
    // liegt hinter NEAR und ist geclippt). Es gibt also nur EINE v≈0-Linie.
    const bottomLines = outline.filter(
      (l) => Math.abs(l.a.y) < 1e-4 && Math.abs(l.b.y) < 1e-4,
    );
    expect(bottomLines.length).toBe(1);
  });
});

describe("toElevation — Öffnungen: Verdeckung + Reveal-Schatten", () => {
  // Projekt mit einem Fenster auf NEAR und einem deckungsgleich dahinter auf FAR.
  function openingProject(): Project {
    const base = elevationProject({ overhang: false });
    const wt = {
      id: "wt",
      name: "Fenster",
      kind: "drehkipp" as const,
      wingCount: 1,
      glazing: "zweifach" as const,
      frameWidth: 0.06,
      defaultSillHeight: 0.9,
      defaultWidth: 1,
      defaultHeight: 1.2,
    };
    const mkOpening = (id: string, hostWallId: string) => ({
      id,
      type: "opening" as const,
      hostWallId,
      categoryCode: "21",
      kind: "window" as const,
      typeId: "wt",
      position: 1.5,
      width: 1,
      height: 1.2,
      sillHeight: 0.9,
    });
    return {
      ...base,
      windowTypes: [wt],
      openings: [mkOpening("op-near", "NEAR"), mkOpening("op-far", "FAR")],
    } as unknown as Project;
  }

  it("Fenster auf der verdeckten Hinterwand wird NICHT emittiert (keine Durchsicht)", () => {
    const project = openingProject();
    const plan = generateElevationPlan(project, project.drawingLevels[1])!;
    // Öffnungs-Symbollinien (DIN) — die des FAR-Fensters dürften durch NEAR
    // scheinen, wenn nicht gecullt. Nur das NEAR-Fenster liefert Symbole.
    const symbols = plan.primitives.filter(
      (p) => p.kind === "line" && (p as { cls?: string }).cls === "elevation-opening-symbol",
    );
    const nearOnly = generateElevationPlan(
      { ...project, openings: (project.openings ?? []).filter((o) => o.id === "op-near") },
      project.drawingLevels[1],
    )!;
    const nearSymbols = nearOnly.primitives.filter(
      (p) => p.kind === "line" && (p as { cls?: string }).cls === "elevation-opening-symbol",
    );
    // Mit beiden Fenstern gleich viele Symbole wie mit NUR dem vorderen → das
    // hintere trägt nichts bei (vollständig verdeckt).
    expect(symbols.length).toBe(nearSymbols.length);
    expect(symbols.length).toBeGreaterThan(0);
  });

  it("Reveal-Schatten: shadows=true erzeugt Öffnungs-Schattenbänder, false keine", () => {
    const project = openingProject();
    const level = project.drawingLevels[1];
    const off = generateElevationPlan(project, level, { shadows: false })!;
    const on = generateElevationPlan(project, level, { shadows: true })!;
    const revealShadows = (plan: typeof on) =>
      plan.primitives.filter(
        (p) => p.kind === "polygon" && p.stroke === "none" && p.fill === "#a7adb5",
      ).length;
    expect(revealShadows(off)).toBe(0);
    // Ein sichtbares Fenster → zwei Reveal-Bänder (Kopf + linke Laibung).
    expect(revealShadows(on)).toBe(2);
  });
});

describe("Dächer in der Ansicht (roofWorldFacesAll)", () => {
  it("Dachflächen erscheinen als roofId-Polygone bis zur Firsthöhe", () => {
    // Sattel 4×3 über dem Fixture-Haus, First entlang X, Traufe 3 m — die
    // Süd-Schräge zeigt zum Betrachter (Ansicht Süd des Fixtures), die
    // Nord-Schräge ist rückseiten-gecullt.
    const base = elevationProject({ overhang: false });
    const p = {
      ...base,
      roofs: [
        {
          id: "R1",
          type: "roof",
          floorId: "eg",
          categoryCode: "35",
          outline: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4, y: 3 },
            { x: 0, y: 3 },
          ],
          shape: "sattel",
          pitchDeg: 30,
          overhang: 0,
          ridgeAxis: "x",
          baseElevation: 3,
          thickness: 0.2,
        },
      ],
    } as unknown as Project;
    const level = p.drawingLevels.find((z) => z.kind === "elevation")!;
    const plan = generateElevationPlan(p, level);
    expect(plan).not.toBeNull();
    const roofPolys = plan!.primitives.filter(
      (pr) => pr.kind === "polygon" && (pr as { roofId?: string }).roofId === "R1",
    );
    expect(roofPolys.length).toBeGreaterThanOrEqual(1);
    // Die sichtbare Dachfläche reicht bis zur Firsthöhe 3 + 1.5·tan30.
    const ridge = 3 + 1.5 * Math.tan((30 * Math.PI) / 180);
    const maxV = Math.max(
      ...roofPolys.flatMap((pr) => (pr as { pts: { y: number }[] }).pts.map((q) => q.y)),
    );
    expect(maxV).toBeCloseTo(ridge, 5);
  });
});
