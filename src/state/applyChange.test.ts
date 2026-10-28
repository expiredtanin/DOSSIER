// [K4] S3 zweite Etappe: Store-Aktionen erzeugen Ops direkt (`applyChange`, `opsMutation`) statt
// Projekt → Projekt + `diffToOps`. Geprüft: Ops gehen unverändert an den Kern (Verlauf, Prüfung),
// Leseansicht und Kern-Dokument bleiben gleich — auch über Zufallsfolgen der umgestellten
// Aktionen mit Undo bis zum Anfang und Redo bis zum Ende.
import { beforeEach, describe, expect, it } from "vitest";
import { getState, setState } from "./appStore";
import { storeDocument } from "./historySlice";
import { sampleProject } from "../model/sampleProject";
import type { Drawing2D, Project, Vec2 } from "../model/types";
import { applyOps } from "../core/ops";
import { opsMutation, patchItem, removeItems } from "../core/opsBuild";

const st = () => getState();

function rng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function drawings(r: () => number): Drawing2D[] {
  const v = (): Vec2 => ({ x: Math.round(r() * 100) / 10, y: Math.round(r() * 100) / 10 });
  const base = { type: "drawing2d" as const, levelId: "eg", categoryCode: "20" };
  const geoms = [
    { shape: "line", a: v(), b: v() },
    { shape: "polyline", pts: [v(), v(), v(), v()], closed: true, bulge: [0, 0.3, 0, 0] },
    { shape: "polyline", pts: [v(), v(), v(), v()], closed: false },
    { shape: "rect", min: { x: 0, y: 0 }, max: { x: 2, y: 1 } },
    { shape: "circle", center: v(), r: 1.5 },
    { shape: "arc", center: v(), r: 1, a0: 0.2, a1: 2 },
    { shape: "text", at: v(), text: "A", height: 0.3, angle: 0 },
    { shape: "dimension", pts: [v(), v(), v()], offset: 0.5 },
  ] as Drawing2D["geom"][];
  return geoms.map((geom, i) => ({ ...base, id: `d${i}`, geom }) as Drawing2D);
}

/** Kern-Dokument == TS-Leseansicht (JSON). */
function expectMirror(): void {
  const p = st().project;
  expect(JSON.parse(storeDocument(p).json())).toEqual(JSON.parse(JSON.stringify(p)));
}

beforeEach(() => {
  st().setProject(structuredClone(sampleProject));
  st().clearHistory();
});

describe("applyChange", () => {
  it("Ops gehen ohne Differenz an den Kern: ein Undo-Schritt, Protokoll = genau diese Ops", () => {
    const before = st().project;
    const w = before.walls[0];
    const ops = patchItem(before, "walls", w.id, { height: 3.3 });
    st().applyChange(ops);
    expect(st().project.walls[0].height).toBe(3.3);
    // Unveränderte Elemente und Listen behalten ihre Identität.
    expect(st().project.walls[1]).toBe(before.walls[1]);
    expect(st().project.drawingLevels).toBe(before.drawingLevels);
    expect(st().recentOps().at(-1)).toEqual(ops);
    expect(st().undoDepth).toBe(1);
    st().undo();
    expect(st().project.walls[0].height).toBe(w.height);
    expectMirror();
  });

  it("leere Ops: kein Schritt; NaN: abgelehnt, Projekt unverändert", () => {
    const before = st().project;
    st().applyChange([]);
    st().applyChange((p) => patchItem(p, "walls", "gibt-es-nicht", { height: 1 }));
    expect(st().project).toBe(before);
    expect(st().undoDepth).toBe(0);
    st().applyChange((p) => patchItem(p, "walls", p.walls[0].id, { height: NaN }));
    expect(st().project).toBe(before);
    expect(st().undoDepth).toBe(0);
  });

  it("coalesceKey: Serie = ein Schritt; setProject(opsMutation) nimmt die Ops direkt", () => {
    const id = st().project.walls[0].id;
    for (let i = 0; i < 50; i++) st().applyChange((p) => patchItem(p, "walls", id, { height: 2 + i / 100 }), "drag");
    expect(st().undoDepth).toBe(1);
    const m = opsMutation((p) => removeItems(p, "walls", [id]));
    st().setProject(m);
    expect(st().recentOps().at(-1)).toEqual([{ kind: "remove", collection: "walls", ids: [id] }]);
    expect(st().undoDepth).toBe(2);
    st().undo();
    st().undo();
    expect(st().project.walls[0].height).toBe(sampleProject.walls[0].height);
    expectMirror();
  });

  it("groupChanges: mehrere Aktionen = ein Undo-Schritt", () => {
    const p0 = st().project;
    st().groupChanges(() => {
      st().patchLevel(p0.drawingLevels[0].id, { linePoints: undefined, name: "X" });
      st().setProject(opsMutation((p) => removeItems(p, "walls", [p.walls[0].id, p.walls[1].id])));
    });
    expect(st().undoDepth).toBe(1);
    st().undo();
    expect(st().project).toEqual(p0);
  });
});

describe("groupChanges mit Schlüssel", () => {
  it("Griff-Zug mit mitgeführten Ecken: alle Mausschritte = ein Undo-Schritt", () => {
    const p0 = st().project;
    const [a, b] = p0.walls;
    for (let i = 0; i < 30; i++) {
      st().groupChanges(() => {
        st().moveElementByOf(null, a.id, { x: 0.01, y: 0 });
        st().moveGripOf(null, b.id, 0, { x: b.start.x + (i + 1) * 0.01, y: b.start.y });
      }, `bodyDrag::${a.id}`);
    }
    expect(st().undoDepth).toBe(1);
    st().undo();
    expect(st().project).toEqual(p0);
    expectMirror();
  });
});

describe("Zufallsfolgen der umgestellten Aktionen", () => {
  it("Leseansicht = Kern, jede Aktion = applyOps(vorher, ihre Ops), Undo/Redo exakt", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      const start: Project = { ...structuredClone(sampleProject), drawings2d: drawings(r) };
      setState({ project: start });
      st().clearHistory();
      const v = (): Vec2 => ({ x: r() * 10, y: r() * 10 });
      let committed = 0;
      for (let k = 0; k < 60; k++) {
        const s = st();
        const p = s.project;
        const wid = p.walls[Math.floor(r() * p.walls.length)]?.id ?? "x";
        const did = p.drawings2d[Math.floor(r() * p.drawings2d.length)]?.id ?? "x";
        const lid = p.drawingLevels[Math.floor(r() * p.drawingLevels.length)]?.id ?? "x";
        const cid = p.ceilings?.[0]?.id ?? "x";
        const rmid = p.rooms?.[0]?.id ?? "x";
        const idx = Math.floor(r() * 4);
        const n = Math.floor(r() * 14);
        const depth = s.undoDepth;
        try {
          switch (n) {
            case 0: s.moveGripOf(null, wid, idx % 2, v()); break;
            case 1: s.moveGripOf(did, null, idx % 2, v()); break;
            case 2: s.moveElementByOf(did, null, v()); break;
            case 3: s.moveEdgeOf(null, wid, 0, 1, v()); break;
            case 4: s.updateWall(wid, { height: 2 + r() }); break;
            case 5: s.setElementColor("drawing2d", did, "#abcdef"); break;
            case 6: s.commitTransformOn({ wallIds: [wid], drawingId: did }, idx % 2 ? "move" : "rotate", [v(), v(), v()], idx < 2 ? "move" : "copy", 1); break;
            case 7: s.moveCeilingBy(cid, v()); break;
            case 8: s.moveRoomGrip(rmid, idx, v()); break;
            case 9: s.toggleLevelVisible(lid); break;
            case 10: s.patchLevel(lid, { floorHeight: 2.5 + r() }); break;
            case 11: s.setWallThickness(wid, 0.1 + r() * 0.3); break;
            case 12: s.resizeElement("drawing2d", did, 1 + r(), 1 + r(), { fx: 0, fy: 0 }); break;
            case 13: s.setProject(opsMutation((q) => removeItems(q, "drawings2d", [did]))); break;
          }
        } catch {
          continue; // ungültige Griff-Indizes (z. B. Kante einer kurzen Polylinie) — wie bisher
        }
        if (st().project !== p) {
          committed++;
          // Ein Schritt mehr — oder gleich viele, wenn dieselbe Griff-Serie verschmolzen wurde.
          expect(st().undoDepth - depth).toBeGreaterThanOrEqual(0);
          expect(st().undoDepth - depth).toBeLessThanOrEqual(1);
          expect(st().project).toEqual(applyOps(p, st().recentOps().at(-1)!));
        }
      }
      expect(committed).toBeGreaterThan(30);
      expectMirror();
      const end = JSON.stringify(st().project);
      while (st().canUndo) st().undo();
      expect(JSON.stringify(st().project)).toBe(JSON.stringify(start));
      expectMirror();
      while (st().canRedo) st().redo();
      expect(JSON.stringify(st().project)).toBe(end);
      expectMirror();
    }
  });
});
