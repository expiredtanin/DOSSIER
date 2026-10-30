/**
 * Unit-Tests für das Cursor-HUD (Länge/Winkel) des `wall`-Befehls: nach dem
 * Startpunkt muss `onMove` im Draft `hud.length`/`hud.angleDeg` relativ zum
 * ZULETZT gesetzten Achspunkt liefern — auch nach mehreren Segmenten
 * (Chaining), damit ein mehrteiliger Wandzug je Segment ein frisches HUD zeigt.
 */

import { describe, it, expect } from "vitest";
import { wallCommand } from "./wall";
import type { CommandContext, Project, Vec2 } from "../types";

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [
      { id: "aw", name: "AW", layers: [{ componentId: "c", thickness: 0.2 }] },
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
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

function makeCtx(lastPoint: Vec2 | null): CommandContext {
  const p = project();
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint,
    selection: { wallIds: [], drawingId: null },
  };
}

describe("wallCommand — Cursor-HUD (Länge/Winkel)", () => {
  it("liefert hud.length/angleDeg relativ zum Startpunkt", () => {
    const start: Vec2 = { x: 0, y: 0 };
    const [afterStart] = wallCommand.onInput(
      wallCommand.init(),
      { kind: "point", point: start },
      makeCtx(null),
    );
    const [, res] = wallCommand.onMove(afterStart, { x: 4, y: 0 }, null, makeCtx(start));
    expect(res.draft?.hud?.length).toBeCloseTo(4, 9);
    expect(res.draft?.hud?.angleDeg).toBeCloseTo(0, 9);
  });

  it("HUD bezieht sich nach dem zweiten Punkt auf das NEUE (letzte) Segment", () => {
    const p0: Vec2 = { x: 0, y: 0 };
    const p1: Vec2 = { x: 4, y: 0 };
    const [s1] = wallCommand.onInput(wallCommand.init(), { kind: "point", point: p0 }, makeCtx(null));
    const [s2] = wallCommand.onInput(s1, { kind: "point", point: p1 }, makeCtx(p0));
    // Nächstes Segment ab p1 nach oben (0,3) → Länge 3, Winkel 90°.
    const [, res] = wallCommand.onMove(s2, { x: 4, y: 3 }, null, makeCtx(p1));
    expect(res.draft?.hud?.length).toBeCloseTo(3, 9);
    expect(res.draft?.hud?.angleDeg).toBeCloseTo(90, 9);
  });

  it("zeigt KEIN HUD vor dem Startpunkt (phase=start)", () => {
    const [, res] = wallCommand.onMove(wallCommand.init(), { x: 1, y: 1 }, null, makeCtx(null));
    expect(res.draft).toBeNull();
  });
});

describe("wallCommand — Bogen-Modus ([T2])", () => {
  /** Spielt Eingaben ab und liefert das committete Projekt. */
  function run(inputs: ({ pt: Vec2 } | { opt: string } | "confirm")[]): Project {
    let state = wallCommand.init();
    let p = project();
    const ctx = makeCtx(null);
    for (const step of inputs) {
      const [next, res] =
        step === "confirm"
          ? wallCommand.onConfirm(state, ctx)
          : "pt" in step
            ? wallCommand.onInput(state, { kind: "point", point: step.pt }, ctx)
            : wallCommand.onInput(state, { kind: "option", id: step.opt }, ctx);
      state = next;
      if (res.commit) p = res.commit(p);
    }
    return p;
  }

  it("Drei-Punkt-Bogen: Durchgangspunkt + Endpunkt ergeben EINE Bogenwand (Modell-Bulge)", () => {
    const p = run([{ opt: "arc" }, { pt: { x: 0, y: 0 } }, { pt: { x: 2, y: 2 } }, { pt: { x: 4, y: 0 } }, "confirm"]);
    expect(p.walls.length).toBe(1);
    // Scheitel links der Sehne (oben) → +1 (Halbkreis).
    expect(p.walls[0].bulge).toBeCloseTo(1, 9);
  });

  it("Vorschau zeigt den Bogen vor dem Endpunkt; Zurück verwirft erst den Durchgangspunkt", () => {
    const ctx = makeCtx(null);
    let [s] = wallCommand.onInput(wallCommand.init(), { kind: "option", id: "arc" }, ctx);
    [s] = wallCommand.onInput(s, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    expect(wallCommand.prompt(s)).toBe("cmd.polyline.arcThrough");
    [s] = wallCommand.onInput(s, { kind: "point", point: { x: 2, y: 2 } }, ctx);
    const [, res] = wallCommand.onMove(s, { x: 4, y: 0 }, null, ctx);
    expect((res.draft?.preview ?? []).length).toBeGreaterThan(0);
    [s] = wallCommand.onInput(s, { kind: "option", id: "undo" }, ctx);
    expect(wallCommand.prompt(s)).toBe("cmd.polyline.arcThrough");
  });

  it("ohne Bogen-Modus bleibt die Wand gerade und ohne bulge-Feld", () => {
    const p = run([{ pt: { x: 0, y: 0 } }, { pt: { x: 4, y: 0 } }, "confirm"]);
    expect(p.walls[0].bulge).toBeUndefined();
  });
});
