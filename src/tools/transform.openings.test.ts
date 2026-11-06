// [144] Öffnungen allein verschieben, am komplexen Musterhaus: jede Tür/jedes Fenster in einer geraden
// Wand gleitet um die Projektion des Verschiebevektors auf die Wandachse (geklemmt), Wirt bleibt.
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { transformMutation } from "./transform";

describe("Öffnungen verschieben (Musterhaus komplex)", () => {
  it("jede Wandöffnung gleitet entlang ihrer Wand", () => {
    const p = buildComplexSampleProject();
    const walls = new Map(p.walls.map((w) => [w.id, w]));
    const ops = (p.openings ?? []).filter((o) => {
      const w = walls.get(o.hostWallId);
      return w && !w.bulge && !o.locked && !o.hostRoofId && !o.hostCeilingId;
    });
    expect(ops.length).toBeGreaterThan(5);
    for (const o of ops) {
      const w = walls.get(o.hostWallId)!;
      const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
      const u = { x: (w.end.x - w.start.x) / len, y: (w.end.y - w.start.y) / len };
      // 0.3 m längs + 0.02 m quer (bleibt in der Wand).
      const d = { x: u.x * 0.3 - u.y * 0.02, y: u.y * 0.3 + u.x * 0.02 };
      const next = transformMutation({ wallIds: [], drawingId: null, openingIds: [o.id] }, "move", [{ x: 0, y: 0 }, d], "move", 1)(p);
      const m = next.openings!.find((x) => x.id === o.id)!;
      expect(m.hostWallId, o.id).toBe(o.hostWallId);
      expect(m.position, o.id).toBeCloseTo(Math.min(len - o.width, o.position + 0.3), 9);
    }
  });
});
