/**
 * `chamferCommand` — die Kernel-Geometrie (`chamferCorner`) ist neu (existierte
 * bisher gar nicht, anders als filletCorner). Test: eine rechtwinklige
 * Polylinien-Ecke wird mit einer Distanz gefast (gerader Schnitt statt Bogen).
 */

import { describe, it, expect } from "vitest";
import { chamferCommand } from "./chamfer";
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
      // L-förmige offene Polylinie: (0,0) → (2,0) → (2,2). Ecke bei (2,0).
      {
        id: "poly",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "20",
        geom: { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }], closed: false },
      },
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

describe("chamferCommand", () => {
  it("fast die Ecke mit getippter Distanz (Zahl-Eingabe)", () => {
    const p = project();
    const ctx = makeCtx(p);

    // Schritt 1: Ecke wählen (Klick nahe (2,0)).
    const [afterPick, r1] = chamferCommand.onInput(
      chamferCommand.init(),
      { kind: "point", point: { x: 2, y: 0 } },
      ctx,
    );
    expect(r1.done).toBeFalsy();

    // Schritt 2: Distanz getippt (0.5m) → commit.
    const [, r2] = chamferCommand.onInput(afterPick, { kind: "number", value: 0.5 }, ctx);
    expect(r2.done).toBe(true);
    expect(r2.commit).toBeDefined();

    const next = r2.commit!(p);
    const poly = next.drawings2d.find((d) => d.id === "poly")!;
    expect(poly.geom.shape).toBe("polyline");
    if (poly.geom.shape !== "polyline") return;
    const pts = poly.geom.pts;
    // Die scharfe Ecke (2,0) darf nicht mehr vorkommen — durch die Fasung ersetzt.
    expect(pts.some((p) => p.x === 2 && p.y === 0)).toBe(false);
    // Anfangs-/Endpunkt der ganzen Kette bleiben unverändert.
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 2, y: 2 });
    // Exakt zwei neue Punkte (gerade Fasung, keine Tessellierung): 0.5m vom
    // Eck entlang jedes Schenkels.
    expect(pts.length).toBe(4);
    const close = (a: { x: number; y: number }, x: number, y: number) =>
      Math.hypot(a.x - x, a.y - y) < 1e-9;
    expect(close(pts[1], 1.5, 0)).toBe(true);
    expect(close(pts[2], 2, 0.5)).toBe(true);
  });

  it("daneben geklickt → Befehl bleibt im pick-Zustand (kein Treffer)", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [state, result] = chamferCommand.onInput(
      chamferCommand.init(),
      { kind: "point", point: { x: 50, y: 50 } },
      ctx,
    );
    expect(result.commit).toBeUndefined();
    expect(result.done).toBeFalsy();
    expect((state as { phase: string }).phase).toBe("pick");
  });

  it("Distanz zu gross für die Schenkellänge → No-op (kein commit-Effekt)", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterPick] = chamferCommand.onInput(
      chamferCommand.init(),
      { kind: "point", point: { x: 2, y: 0 } },
      ctx,
    );
    // Schenkel sind 2m lang; 10m Distanz passt auf keinen der beiden.
    const [, r2] = chamferCommand.onInput(afterPick, { kind: "number", value: 10 }, ctx);
    expect(r2.commit).toBeDefined();
    const next = r2.commit!(p);
    expect(next).toBe(p); // unverändert
  });
});
