import { describe, expect, it } from "vitest";
import type { CoreOp } from "../core";
import { importedElementPoints } from "./useModelImport";

describe("importedElementPoints", () => {
  // Nach dem IFC-Import „Als Bauteile“ passt der Ausschnitt auf alles Importierte, nicht nur auf die Wände:
  // eine Datei mit einer kurzen Wand und Archicad-Morphs (Netze) daneben zeigte die Morphs sonst nicht.
  it("nimmt Wände, Decken, Stützen und die als Mesh gebliebenen Teile", () => {
    const ops = [
      { kind: "add", collection: "walls", items: [{ id: "w", start: { x: 0, y: 0 }, end: { x: 3, y: 0 } }] },
      { kind: "setField", key: "ceilings", value: [{ id: "c", outline: [{ x: -2, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }] }] },
      { kind: "add", collection: "columns", items: [{ id: "k", position: { x: 5, y: 5 } }] },
      { kind: "add", collection: "context", items: [{ id: "m", type: "importedMesh", positions: [20, 8, 0, 21, 9, 2.5, 22, 10, 1] }] },
    ] as unknown as CoreOp[];
    const pts = importedElementPoints(ops);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([-2, 22, -1, 10]);
  });

  it("ohne Bauteile leer", () => {
    expect(importedElementPoints([])).toEqual([]);
  });
});
