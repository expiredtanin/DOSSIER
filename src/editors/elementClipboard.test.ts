/**
 * `elementClipboard` — Kopieren/Einfügen für ALLE Bauteil-Arten (Wand/Decke/
 * Dach/Öffnung/Treppe/Raum/Extrusion/Stütze), nicht nur 2D-Zeichenelemente.
 * Deckt insbesondere die Öffnung↔Wand-Paarkopplung ab (s. Kopfkommentar in
 * `elementClipboard.ts`).
 */
import { describe, it, expect } from "vitest";
import { collectElementClipboard, pasteElementClipboard, isClipboardEmpty } from "./elementClipboard";
import { applyOps } from "../core/ops";
import type { ElementSelectionIds } from "./elementClipboard";
import type { Project, Wall, Opening, Ceiling } from "../model/types";

function emptySel(): ElementSelectionIds {
  return {
    wallIds: [],
    drawingIds: [],
    ceilingIds: [],
    roofIds: [],
    openingIds: [],
    stairIds: [],
    roomIds: [],
    extrudedSolidIds: [],
    columnIds: [],
  };
}

function wall(id: string, floorId = "eg"): Wall {
  return {
    id,
    type: "wall",
    floorId,
    categoryCode: "20",
    start: { x: 0, y: 0 },
    end: { x: 5, y: 0 },
    wallTypeId: "wt1",
    height: 2.6,
  };
}

function opening(id: string, hostWallId: string): Opening {
  return {
    id,
    type: "opening",
    hostWallId,
    categoryCode: "21",
    kind: "window",
    position: 1,
    width: 1.2,
    height: 1.2,
    sillHeight: 0.9,
  };
}

function ceiling(id: string, floorId = "eg"): Ceiling {
  return {
    id,
    type: "ceiling",
    floorId,
    categoryCode: "30",
    outline: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }],
    wallTypeId: "wt1",
    thickness: 0.24,
  };
}

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
      { id: "og", name: "OG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 2.6 },
    ],
    layers: [{ code: "20", name: "Wand", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [wall("w1")],
    openings: [opening("o1", "w1")],
    ceilings: [ceiling("c1")],
    stairs: [],
    rooms: [],
    context: [],
    drawings2d: [],
  };
}

describe("collectElementClipboard", () => {
  it("liefert null, wenn nichts gewählt ist", () => {
    const p = project();
    expect(collectElementClipboard(p, emptySel())).toBeNull();
  });

  it("kopiert eine gewählte Wand samt ihrer Öffnung automatisch mit (Kaskade)", () => {
    const p = project();
    const sel = { ...emptySel(), wallIds: ["w1"] };
    const clip = collectElementClipboard(p, sel)!;
    expect(clip.walls.length).toBe(1);
    expect(clip.openings.length).toBe(1);
    expect(clip.openings[0].hostWallId).toBe("w1");
  });

  it("überspringt eine Öffnung, deren Wirtswand NICHT mitkopiert wird", () => {
    const p = project();
    const sel = { ...emptySel(), openingIds: ["o1"] }; // nur Öffnung, nicht die Wand
    const clip = collectElementClipboard(p, sel);
    // Ohne Wirtswand: leere Zwischenablage (isClipboardEmpty → null).
    expect(clip).toBeNull();
  });

  it("kopiert eine gewählte Decke unabhängig von Wänden", () => {
    const p = project();
    const sel = { ...emptySel(), ceilingIds: ["c1"] };
    const clip = collectElementClipboard(p, sel)!;
    expect(clip.ceilings.length).toBe(1);
    expect(isClipboardEmpty(clip)).toBe(false);
  });
});

describe("pasteElementClipboard", () => {
  it("fügt Wand + Öffnung mit NEUEN, verknüpften IDs auf dem aktiven Geschoss ein", () => {
    const p = project();
    const clip = collectElementClipboard(p, { ...emptySel(), wallIds: ["w1"] })!;
    const { ops, pastedIds } = pasteElementClipboard(clip, "og");
    const next = applyOps(p, ops);
    expect(next.walls.length).toBe(2);
    expect(next.openings!.length).toBe(2);
    const newWall = next.walls.find((w) => w.id === pastedIds.wallIds[0])!;
    expect(newWall.floorId).toBe("og");
    expect(newWall.id).not.toBe("w1");
    const newOpening = next.openings!.find((o) => o.id === pastedIds.openingIds[0])!;
    expect(newOpening.hostWallId).toBe(newWall.id); // umgehängt, nicht mehr "w1"
    // Koordinaten bleiben identisch (Einfügen „in place", wie beim 2D-Verhalten).
    expect(newWall.start).toEqual({ x: 0, y: 0 });
    expect(newWall.end).toEqual({ x: 5, y: 0 });
  });

  it("Originale bleiben unverändert (immutabel)", () => {
    const p = project();
    const clip = collectElementClipboard(p, { ...emptySel(), wallIds: ["w1"] })!;
    pasteElementClipboard(clip, "og");
    expect(p.walls.length).toBe(1);
    expect(p.walls[0].id).toBe("w1");
  });
});
