/**
 * `trimCommand` — Integrationstest für den Bogen-Fall (`trimPolylineWithBulge`,
 * s. Kernel-Tests in `geometry/kernel2d.trimBulge.test.ts` für die reine
 * Geometrie). Deckt die Verdrahtung ab: Klick-Trefftest auf einem Bogen-
 * Segment (tesselliert, s. `curveHitEdges`) + committete Geometrie behält
 * bulge — sowohl als Ziel-Kurve als auch als Schneider (Bogen-Cutter).
 */

import { describe, it, expect } from "vitest";
import { trimCommand } from "./trim";
import type { CommandContext, Project } from "../types";

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [
      // Cutter: senkrechte Linie bei x=0.
      { id: "cutter", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "line", a: { x: 0, y: -5 }, b: { x: 0, y: 5 } } },
      // Ziel: Halbkreis (-1,0)→(1,0), bulge=1 (center=(0,0), r=1).
      { id: "target", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "polyline", pts: [{ x: -1, y: 0 }, { x: 1, y: 0 }], closed: false, bulge: [1] } },
    ],
    context: [],
  };
}

function makeCtx(p: Project): CommandContext {
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: null },
  };
}

describe("trimCommand — Bogen-Segmente (bulge)", () => {
  it("Klick auf den rechten Viertelbogen trifft ihn (tessellierter Trefftest) und schneidet ihn weg", () => {
    const p = project();
    const ctx = makeCtx(p);
    // Klick auf dem rechten Viertelbogen (45°: (√2/2, √2/2)) — liegt weit von
    // der geraden Sehne (-1,0)-(1,0) entfernt, ein reiner Sehnen-Trefftest
    // würde hier fehlschlagen.
    const pick = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
    const [, result] = trimCommand.onInput(trimCommand.init(), { kind: "point", point: pick }, ctx);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const rest = next.drawings2d.filter((d) => d.id !== "cutter");
    expect(rest.length).toBe(1);
    const g = rest[0].geom;
    expect(g.shape).toBe("polyline");
    if (g.shape !== "polyline") return;
    // Nur der linke Viertelbogen bleibt: (-1,0) → (0,1), mit echtem bulge.
    expect(g.pts[0].x).toBeCloseTo(-1, 6);
    expect(g.pts[1].x).toBeCloseTo(0, 6);
    expect(g.pts[1].y).toBeCloseTo(1, 6);
    expect(g.bulge?.[0]).toBeDefined();
    expect(Math.abs(g.bulge![0])).toBeGreaterThan(0.01);
  });

  it("ein Bogen-CUTTER schneidet jetzt echt (Kreis↔Kreis-Schnitt), statt ignoriert zu werden", () => {
    const p = project();
    // Geraden-Cutter entfernen, nur der Bogen-Cutter soll hier wirken.
    p.drawings2d = p.drawings2d.filter((d) => d.id !== "cutter");
    // Bogen-Cutter: oberer Halbkreis von center=(1,0), r=1 (a=(0,0)→b=(2,0),
    // bulge=1) — kreuzt das Ziel (oberer Halbkreis center=(0,0), r=1) exakt
    // bei (0.5, √3/2) ("Vesica Piscis", s. kernel2d.trimBulge.test.ts).
    p.drawings2d.push({
      id: "arcCutter",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }], closed: false, bulge: [1] },
    });
    const ctx = makeCtx(p);
    // Klick bei 120° (vor dem Schnitt bei 60° in Schwenkrichtung).
    const pick = { x: Math.cos((2 * Math.PI) / 3), y: Math.sin((2 * Math.PI) / 3) };
    const [, result] = trimCommand.onInput(trimCommand.init(), { kind: "point", point: pick }, ctx);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const rest = next.drawings2d.filter((d) => d.id !== "arcCutter");
    expect(rest.length).toBe(1);
    const g = rest[0].geom;
    expect(g.shape).toBe("polyline");
    if (g.shape !== "polyline") return;
    // Übrig bleibt der rechte Teilbogen: Schnittpunkt (0.5,√3/2) → b=(1,0).
    expect(g.pts[0].x).toBeCloseTo(0.5, 6);
    expect(g.pts[0].y).toBeCloseTo(Math.sqrt(3) / 2, 6);
    expect(g.pts[g.pts.length - 1]).toEqual({ x: 1, y: 0 });
    expect(Math.abs(g.bulge?.[0] ?? 0)).toBeGreaterThan(0.01);
  });
});
