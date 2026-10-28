// Op-Bauhelfer ([K4] S3): Ergebnis = das bisherige Projekt → Projekt-Muster (`map`/`filter`/Anhängen)
// über `diffToOps`, auf Zufallsprojekten; unveränderte Elemente bleiben identisch.
import { describe, expect, it } from "vitest";
import { applyOps, diffToOps } from "./ops";
import {
  addItems,
  fieldOps,
  findItem,
  isOpsMutation,
  opsMutation,
  patchItem,
  patchItems,
  removeItems,
  replaceWithMany,
  setField,
  setFieldIfChanged,
} from "./opsBuild";
import { sampleProject } from "../model/sampleProject";
import type { Project, Wall } from "../model/types";

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function project(seed: number): Project {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 40);
  const base = sampleProject.walls;
  const walls: Wall[] = Array.from({ length: n }, (_, i) => ({ ...base[i % base.length], id: `w${i}`, height: r() * 3 }));
  return { ...sampleProject, walls };
}

/** Alter Weg: Projekt → Projekt, dann über die Differenz. */
const viaDiff = (p: Project, next: Project): Project => applyOps(p, diffToOps(p, next));

describe("Op-Bauhelfer", () => {
  it("patchItem = map über die Liste (Teilobjekt und Funktion), Zufall", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const p = project(seed);
      const r = rng(seed + 1000);
      const id = `w${Math.floor(r() * (p.walls.length + 3))}`; // auch fehlende ids
      const h = r();
      const a = applyOps(p, patchItem(p, "walls", id, { height: h }));
      const b = viaDiff(p, { ...p, walls: p.walls.map((w) => (w.id === id ? { ...w, height: h } : w)) });
      expect(a).toEqual(b);
      const f = (w: Wall): Wall => ({ ...w, start: { x: w.start.x + h, y: w.start.y } });
      expect(applyOps(p, patchItem(p, "walls", id, f))).toEqual(viaDiff(p, { ...p, walls: p.walls.map((w) => (w.id === id ? f(w) : w)) }));
      // Unveränderte Elemente identisch.
      const out = applyOps(p, patchItem(p, "walls", "w0", { height: 9 }));
      if (p.walls.length > 1) expect(out.walls[1]).toBe(p.walls[1]);
    }
  });

  it("patchItem: fehlendes Element oder gleiches Objekt → keine Op", () => {
    expect(patchItem(sampleProject, "walls", "gibt-es-nicht", { height: 1 })).toEqual([]);
    expect(patchItem(sampleProject, "walls", sampleProject.walls[0].id, (w) => w)).toEqual([]);
  });

  it("patchItems / removeItems / addItems = map / filter / Anhängen, Zufall", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const p = project(seed);
      const r = rng(seed + 7);
      const ids = p.walls.filter(() => r() < 0.3).map((w) => w.id);
      const set = new Set(ids);
      const mv = (w: Wall): Wall => ({ ...w, start: { x: w.start.x, y: w.start.y + 1 }, end: { x: w.end.x, y: w.end.y + 1 } });
      expect(applyOps(p, patchItems(p, "walls", ids, mv))).toEqual(viaDiff(p, { ...p, walls: p.walls.map((w) => (set.has(w.id) ? mv(w) : w)) }));
      expect(applyOps(p, removeItems(p, "walls", set))).toEqual(viaDiff(p, { ...p, walls: p.walls.filter((w) => !set.has(w.id)) }));
      const extra: Wall[] = [{ ...p.walls[0], id: `neu${seed}` }];
      expect(applyOps(p, addItems("walls", extra))).toEqual(viaDiff(p, { ...p, walls: [...p.walls, ...extra] }));
      const at = Math.floor(r() * p.walls.length);
      expect(applyOps(p, addItems("walls", extra, at))).toEqual(
        viaDiff(p, { ...p, walls: [...p.walls.slice(0, at), ...extra, ...p.walls.slice(at)] }),
      );
    }
  });

  it("leere Änderungen ergeben keine Ops; Prädikat statt ids", () => {
    expect(removeItems(sampleProject, "walls", [])).toEqual([]);
    expect(addItems("walls", [])).toEqual([]);
    expect(patchItems(sampleProject, "walls", () => false, (w) => ({ ...w }))).toEqual([]);
    const first = sampleProject.walls[0].id;
    expect(removeItems(sampleProject, "walls", (w) => w.id === first)).toEqual([{ kind: "remove", collection: "walls", ids: [first] }]);
    expect(findItem(sampleProject, "walls", first)).toBe(sampleProject.walls[0]);
  });

  it("replaceWithMany = flatMap über die Liste (Teile an der Stelle des Originals), Zufall", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const p = project(seed);
      const r = rng(seed + 7);
      const map = new Map<string, Wall[]>();
      for (const w of p.walls) {
        const k = r();
        if (k < 0.25) map.set(w.id, []); // entfernen
        else if (k < 0.5) map.set(w.id, [{ ...w, id: `${w.id}a` }, { ...w, id: `${w.id}b`, height: 9 }]); // teilen
        else if (k < 0.6) map.set(w.id, [w]); // unverändert
        else if (k < 0.7) map.set(w.id, [{ ...w, height: 1 }]); // ersetzen
      }
      const expected = { ...p, walls: p.walls.flatMap((w) => map.get(w.id) ?? [w]) };
      const out = applyOps(p, replaceWithMany(p, "walls", map));
      expect(out.walls).toEqual(expected.walls);
      // Unveränderte Elemente behalten ihre Identität.
      for (const w of p.walls) if (!map.has(w.id) || map.get(w.id)![0] === w) expect(out.walls.includes(w)).toBe(true);
    }
    expect(replaceWithMany(project(1), "walls", new Map())).toEqual([]);
  });

  it("setField / setFieldIfChanged", () => {
    expect(setField("name", "X")).toEqual({ kind: "setField", key: "name", value: "X" });
    expect(setField("geoAnchor", undefined)).toEqual({ kind: "setField", key: "geoAnchor" });
    expect(setFieldIfChanged(sampleProject, "name", sampleProject.name)).toEqual([]);
    expect(applyOps(sampleProject, setFieldIfChanged(sampleProject, "name", "Y")).name).toBe("Y");
  });

  it("fieldOps: Differenz nur über ein Feld = volle Differenz, Zufall", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const p = project(seed);
      const r = rng(seed + 99);
      const levels = p.drawingLevels.filter(() => r() < 0.8).map((z) => (r() < 0.3 ? { ...z, visible: !z.visible } : z));
      if (r() < 0.3) levels.reverse();
      const next = { ...p, drawingLevels: levels };
      expect(fieldOps(p, "drawingLevels", levels)).toEqual(diffToOps(p, next));
      expect(applyOps(p, fieldOps(p, "drawingLevels", levels))).toEqual(next);
    }
    expect(fieldOps(sampleProject, "layers", sampleProject.layers)).toEqual([]);
    expect(fieldOps(sampleProject, "geoAnchor", undefined)).toEqual(diffToOps(sampleProject, { ...sampleProject, geoAnchor: undefined }));
  });

  it("opsMutation: wirkt wie eine Projekt → Projekt-Funktion und trägt die Ops mit", () => {
    const id = sampleProject.walls[0].id;
    const m = opsMutation((p) => patchItem(p, "walls", id, { height: 4.2 }));
    expect(isOpsMutation(m)).toBe(true);
    expect(isOpsMutation((p: Project) => p)).toBe(false);
    expect(m(sampleProject).walls[0].height).toBe(4.2);
    expect(m.toOps(sampleProject)).toHaveLength(1);
  });
});

describe("patchItem ohne Änderung", () => {
  it("gleicher Wert ergibt keine Op (kein leerer Undo-Schritt)", () => {
    const p = sampleProject;
    const w = p.walls[0];
    expect(patchItem(p, "walls", w.id, { height: w.height })).toEqual([]);
    expect(patchItems(p, "walls", [w.id], (e) => ({ ...e }))).toEqual([]);
    expect(patchItem(p, "walls", w.id, { height: w.height + 1 })).toHaveLength(1);
  });
});
