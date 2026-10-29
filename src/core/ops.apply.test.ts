// [K4] S3: `applyOps` führt die Leseansicht mit Op-Serien nach (z. B. 300 `replace` beim Verschieben
// einer Auswahl). Die schnelle Fassung (Listen innerhalb eines Aufrufs nur einmal kopiert, id-Index
// je Liste) muss genau das Ergebnis der einfachen Fassung liefern — hier als Referenz festgehalten.
import { describe, expect, it } from "vitest";
import { applyOps } from "./ops";
import type { CoreOp } from "./ops";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";

type Entity = { id: string } & Record<string, unknown>;

/** Referenz: die einfache Fassung (je Op eine neue Liste, lineare Suche). */
function referenceApplyOps(project: Project, ops: readonly CoreOp[]): Project {
  let cur = project as unknown as Record<string, unknown>;
  const listOf = (c: string): Entity[] => (Array.isArray(cur[c]) ? (cur[c] as Entity[]) : []);
  for (const op of ops) {
    switch (op.kind) {
      case "setField": {
        if (op.value !== undefined && op.at !== undefined && !(op.key in cur)) {
          const entries = Object.entries(cur);
          entries.splice(Math.max(0, Math.min(entries.length, op.at)), 0, [op.key, op.value]);
          cur = Object.fromEntries(entries);
          break;
        }
        const next = { ...cur };
        if (op.value === undefined) delete next[op.key];
        else next[op.key] = op.value;
        cur = next;
        break;
      }
      case "add": {
        const list = listOf(op.collection);
        const at = op.at === undefined ? list.length : Math.max(0, Math.min(list.length, op.at));
        cur = { ...cur, [op.collection]: [...list.slice(0, at), ...op.items, ...list.slice(at)] };
        break;
      }
      case "replace": {
        const list = listOf(op.collection);
        const idx = list.findIndex((e) => e.id === op.entity.id);
        if (idx < 0) cur = { ...cur, [op.collection]: [...list, op.entity] };
        else {
          const out = list.slice();
          out[idx] = op.entity;
          cur = { ...cur, [op.collection]: out };
        }
        break;
      }
      case "remove": {
        const drop = new Set(op.ids);
        cur = { ...cur, [op.collection]: listOf(op.collection).filter((e) => !drop.has(e.id)) };
        break;
      }
      case "reorder": {
        const list = listOf(op.collection);
        const byId = new Map(list.map((e) => [e.id, e]));
        const ordered = op.ids.map((id) => byId.get(id)).filter((e): e is Entity => e !== undefined);
        const inOps = new Set(op.ids);
        cur = { ...cur, [op.collection]: [...ordered, ...list.filter((e) => !inOps.has(e.id))] };
        break;
      }
    }
  }
  return cur as unknown as Project;
}

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

/** Zufällige Op-Folge, auch Unsinn (fehlende ids, Doppelungen, Felder ohne Liste). */
function randomOps(p: Project, seed: number): CoreOp[] {
  const r = rng(seed);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const colls = ["walls", "drawings2d", "rooms", "nope", "name"];
  const ids = [...p.walls.map((w) => w.id), ...p.drawings2d.map((d) => d.id), "x1", "x2", "x3"];
  const ops: CoreOp[] = [];
  const n = 1 + Math.floor(r() * 25);
  for (let i = 0; i < n; i++) {
    const c = pick(colls);
    const k = r();
    if (k < 0.45) ops.push({ kind: "replace", collection: c, entity: { id: pick(ids), v: Math.floor(r() * 100) } });
    else if (k < 0.6) {
      const items = Array.from({ length: Math.floor(r() * 3) }, () => ({ id: pick(ids), a: r() }));
      ops.push(r() < 0.5 ? { kind: "add", collection: c, items } : { kind: "add", collection: c, items, at: Math.floor(r() * 20) - 3 });
    } else if (k < 0.72) ops.push({ kind: "remove", collection: c, ids: [pick(ids), pick(ids)] });
    else if (k < 0.82) ops.push({ kind: "reorder", collection: c, ids: [pick(ids), pick(ids), pick(ids)] });
    else if (k < 0.9) ops.push({ kind: "setField", key: pick(colls), value: r() < 0.5 ? [{ id: pick(ids) }] : r() });
    else if (k < 0.95) ops.push({ kind: "setField", key: pick(colls) });
    else ops.push({ kind: "setField", key: `neu${Math.floor(r() * 3)}`, value: r(), at: Math.floor(r() * 5) });
  }
  return ops;
}

describe("applyOps (schnelle Fassung) = Referenz", () => {
  it("2000 zufällige Op-Folgen: gleiches JSON, gleiche Feld-Reihenfolge, Original unberührt", () => {
    const snap = JSON.stringify(sampleProject);
    for (let seed = 1; seed <= 2000; seed++) {
      const ops = randomOps(sampleProject, seed);
      const a = applyOps(sampleProject, ops);
      const b = referenceApplyOps(sampleProject, ops);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
    expect(JSON.stringify(sampleProject)).toBe(snap);
  });

  it("unberührte Listen und Elemente behalten ihre Identität", () => {
    const w = sampleProject.walls;
    const out = applyOps(sampleProject, [
      { kind: "replace", collection: "walls", entity: { ...w[0], height: 7 } },
      { kind: "replace", collection: "walls", entity: { ...w[1], height: 8 } },
    ]);
    expect(out.drawings2d).toBe(sampleProject.drawings2d);
    expect(out.walls[2]).toBe(w[2]);
    expect(out.walls[0].height).toBe(7);
    expect(sampleProject.walls[0]).toBe(w[0]);
    expect(applyOps(sampleProject, [])).toBe(sampleProject);
  });

  it("vom Aufrufer übergebene Werte werden nicht verändert", () => {
    const list = [{ id: "a" }, { id: "b" }];
    const out = applyOps(sampleProject, [
      { kind: "setField", key: "walls", value: list },
      { kind: "replace", collection: "walls", entity: { id: "a", z: 1 } },
      { kind: "add", collection: "walls", items: [{ id: "c" }] },
    ]);
    expect(list).toEqual([{ id: "a" }, { id: "b" }]);
    expect(out.walls).toEqual([{ id: "a", z: 1 }, { id: "b" }, { id: "c" }]);
  });
});

describe("applyOps: id-Index über die Aufrufe hinweg", () => {
  it("Ketten und Verzweigungen grosser Listen (geteilter Index) = Referenz", () => {
    const walls = Array.from({ length: 200 }, (_, i) => ({ ...sampleProject.walls[0], id: `w${i}` }));
    const big: Project = { ...sampleProject, walls, drawings2d: [] };
    const r = rng(7);
    const history: Project[] = [big];
    for (let step = 0; step < 600; step++) {
      // Meist auf dem letzten Stand weiter, manchmal auf einem älteren (Undo-Basis, fremde Projekte).
      const base = r() < 0.7 ? history[history.length - 1] : history[Math.floor(r() * history.length)];
      const ids = ["w0", "w5", "w199", "w150", `n${Math.floor(r() * 40)}`, `n${Math.floor(r() * 40)}`];
      const ops: CoreOp[] = [];
      for (let k = 0, n = 1 + Math.floor(r() * 4); k < n; k++) {
        const x = r();
        const id = ids[Math.floor(r() * ids.length)];
        if (x < 0.6) ops.push({ kind: "replace", collection: "walls", entity: { id, v: step } });
        else if (x < 0.8) ops.push({ kind: "add", collection: "walls", items: [{ id: `n${Math.floor(r() * 40)}` }] });
        else if (x < 0.9) ops.push({ kind: "add", collection: "walls", items: [{ id }], at: Math.floor(r() * 300) });
        else ops.push({ kind: "remove", collection: "walls", ids: [id] });
      }
      // Positions-Hinweise des Kerns (erstes Vorkommen, wie `Document::last_hits`): richtig, auf ein
      // anderes Element, ausserhalb oder fehlend — das Ergebnis bleibt gleich.
      let hits: number[] | undefined;
      if (r() < 0.6) {
        hits = [];
        let cur = base;
        for (const op of ops) {
          const list = cur.walls as unknown as Entity[];
          const first = op.kind === "replace" ? list.findIndex((e) => e.id === op.entity.id) : -1;
          const other = list.findIndex((e, i) => i >= Math.floor(r() * list.length) && op.kind === "replace" && e.id !== op.entity.id);
          const x = r();
          hits.push(x < 0.6 ? first : x < 0.8 ? other : x < 0.9 ? list.length + 3 : -1);
          cur = referenceApplyOps(cur, [op]);
        }
      }
      const a = applyOps(base, ops, hits);
      expect(JSON.stringify(a.walls)).toBe(JSON.stringify(referenceApplyOps(base, ops).walls));
      history.push(a);
    }
  });
});
