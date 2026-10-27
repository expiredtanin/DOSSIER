/**
 * `filletCommand` — die Kernel-Geometrie (`filletCorner`) existierte bereits
 * und war getestet, hatte aber KEINEN Aufrufer (kein Command, kein Tool).
 * Test: eine rechtwinklige Polylinien-Ecke wird mit einem Radius verrundet.
 */

import { describe, it, expect } from "vitest";
import { filletCommand } from "./fillet";
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

describe("filletCommand", () => {
  it("verrundet die Ecke mit getipptem Radius (Zahl-Eingabe)", () => {
    const p = project();
    const ctx = makeCtx(p);

    // Schritt 1: Ecke wählen (Klick nahe (2,0)).
    const [afterPick, r1] = filletCommand.onInput(
      filletCommand.init(),
      { kind: "point", point: { x: 2, y: 0 } },
      ctx,
    );
    expect(r1.done).toBeFalsy();

    // Schritt 2: Radius getippt (0.5m) → commit.
    const [, r2] = filletCommand.onInput(afterPick, { kind: "number", value: 0.5 }, ctx);
    expect(r2.done).toBe(true);
    expect(r2.commit).toBeDefined();

    const next = r2.commit!(p);
    const poly = next.drawings2d.find((d) => d.id === "poly")!;
    expect(poly.geom.shape).toBe("polyline");
    if (poly.geom.shape !== "polyline") return;
    const pts = poly.geom.pts;
    // Die scharfe Ecke (2,0) darf nicht mehr exakt in den Punkten vorkommen —
    // sie wurde durch den Bogen ersetzt.
    expect(pts.some((p) => p.x === 2 && p.y === 0)).toBe(false);
    // Anfangs-/Endpunkt der ganzen Kette bleiben unverändert.
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 2, y: 2 });
    // Die Tangentenpunkte (0.5m vom Eck entlang jedes Schenkels) müssen vorkommen.
    const hasNear = (x: number, y: number) =>
      pts.some((p) => Math.hypot(p.x - x, p.y - y) < 1e-6);
    expect(hasNear(1.5, 0)).toBe(true); // Tangente auf dem ersten Schenkel
    expect(hasNear(2, 0.5)).toBe(true); // Tangente auf dem zweiten Schenkel
    // Echter Bogen (kein tessellierter Punkthaufen): genau 4 Punkte, mit
    // einem von 0 verschiedenen bulge-Wert an der Tangente↔Tangente-Kante.
    expect(pts.length).toBe(4);
    expect(poly.geom.bulge?.[1]).toBeDefined();
    expect(Math.abs(poly.geom.bulge![1])).toBeGreaterThan(0.1);
  });

  it("Polylinie mit echtem bulge-Segment gilt als nicht fillet-fähig (Datenverlust-Schutz)", () => {
    const p = project();
    p.drawings2d[0].geom = {
      shape: "polyline",
      pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }],
      closed: false,
      bulge: [0.4, 0],
    };
    const ctx = makeCtx(p);
    const [state, result] = filletCommand.onInput(
      filletCommand.init(),
      { kind: "point", point: { x: 2, y: 0 } },
      ctx,
    );
    expect(result.commit).toBeUndefined();
    expect((state as { phase: string }).phase).toBe("pick");
  });

  it("daneben geklickt → Befehl bleibt im pick-Zustand (kein Treffer)", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [state, result] = filletCommand.onInput(
      filletCommand.init(),
      { kind: "point", point: { x: 50, y: 50 } },
      ctx,
    );
    expect(result.commit).toBeUndefined();
    expect(result.done).toBeFalsy();
    expect((state as { phase: string }).phase).toBe("pick");
  });
});
