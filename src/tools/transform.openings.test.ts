// [144] Öffnungen allein verschieben, am komplexen Musterhaus: jede Tür/jedes Fenster in einer geraden
// Wand gleitet um die Projektion des Verschiebevektors auf die Wandachse (geklemmt), Wirt bleibt.
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { transformMutation } from "./transform";
import { getState } from "../state/appStore";

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

// [144] Store-Fluss: Befehl (cmdMutation), Objekt-Info/Griff (`slideOpening`) — Bemassung folgt, Bogenwand,
// Nachbaröffnung mit Hinweis, Dachöffnung allein.
describe("Öffnungen verschieben (Store, Musterhaus komplex)", () => {
  const load = () => getState().loadProject(buildComplexSampleProject());
  const opening = (id: string) => getState().project.openings!.find((o) => o.id === id)!;
  const dimPts = () => (getState().project.drawings2d.find((d) => d.id === "mass-fenster-eg")!.geom as { pts: { x: number }[] }).pts;

  it("Bemassung auf die Leibungen folgt Befehl und Objekt-Info", () => {
    load();
    const x0 = dimPts()[0].x;
    getState().setProject(transformMutation({ wallIds: [], drawingId: null, openingIds: ["eg-f1"] }, "move", [{ x: 0, y: 0 }, { x: 0.5, y: 0 }], "move", 1));
    expect(opening("eg-f1").position).toBeCloseTo(2.1, 9);
    expect(dimPts()[0].x).toBeCloseTo(x0 + 0.5, 9);
    expect(dimPts()[1].x).toBeCloseTo(x0 + 0.5 + opening("eg-f1").width, 9);
    getState().slideOpening("eg-f1", { position: 1 });
    expect(dimPts()[0].x).toBeCloseTo(x0 - 0.6, 9);
    getState().undo();
    expect(dimPts()[0].x).toBeCloseTo(x0 + 0.5, 9);
  });

  it("Bogenwand: Lage = Bogenlänge, Anschlag an der Nachbaröffnung mit Hinweis", () => {
    load();
    const before = getState().notifications.length;
    // Erker EG (Halbkreis r = 2): f5 bei 1.2 (1 m breit), f6 bei 3.6 — f5 hält bei 3.6 − 0.05 − 1 = 2.55.
    getState().slideOpening("eg-f5", { position: 3 });
    expect(opening("eg-f5").position).toBeCloseTo(2.55, 9);
    expect(getState().notifications.length).toBe(before + 1);
    expect(getState().notifications.at(-1)?.kind).toBe("warning");
    getState().undo();
    expect(opening("eg-f5").position).toBe(1.2);
    // Griff-Zug ausserhalb des Scheitels (17, 5): Mitte auf der halben Bogenlänge π.
    getState().slideOpening("eg-f6", { pt: { x: 17.4, y: 5 } });
    expect(opening("eg-f6").position).toBeCloseTo(Math.PI - 0.5, 9);
    // Weiter zum Anfang: f5 endet bei 2.2 → Anschlag bei 2.25.
    getState().slideOpening("eg-f6", { pt: { x: 15, y: 3 } });
    expect(opening("eg-f6").position).toBeCloseTo(2.25, 9);
    // Befehl: f6 übers Bogenende hinaus → Bogenlänge 2π − Breite, gleiche Wand.
    getState().setProject(transformMutation({ wallIds: [], drawingId: null, openingIds: ["eg-f6"] }, "move", [{ x: 17, y: 5 }, { x: 13, y: 9 }], "move", 1));
    expect(opening("eg-f6").position).toBeCloseTo(2 * Math.PI - 1, 9);
    expect(opening("eg-f6").hostWallId).toBe("eg-aw-erker");
  });

  it("Dach-/Deckenöffnung allein verschieben", () => {
    load();
    const o = (getState().project.openings ?? []).find((x) => (x.hostRoofId || x.hostCeilingId) && !x.locked);
    expect(o).toBeDefined();
    const hp = o!.hostPoint!;
    getState().setProject(transformMutation({ wallIds: [], drawingId: null, openingIds: [o!.id] }, "move", [{ x: 0, y: 0 }, { x: 0.3, y: 0 }], "move", 1));
    expect(opening(o!.id).hostPoint!.x).toBeCloseTo(hp.x + 0.3, 9);
  });
});
