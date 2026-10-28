// Undo/Redo im Kern ([K4] S3, [8]): Änderungen laufen über `ProjectDocument.commit` (Prüfung +
// Verlauf in Rust), Undo/Redo liefern Ops, mit denen die TS-Leseansicht nachgeführt wird.
import { describe, expect, it } from "vitest";
import { ProjectDocument } from "./document";
import { diffToOps, validateOps, validateProject } from "./ops";
import type { CoreOp } from "./ops";
import { sampleProject } from "../model/sampleProject";
import type { Project, Wall } from "../model/types";

const plain = (p: Project): unknown => JSON.parse(JSON.stringify(p));

/** Zufällige, deterministische Änderung (Wände, Felder, Reihenfolgen, Listen ersetzen). */
function mutate(p: Project, seed: number): Project {
  let x = seed;
  const rnd = () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let out = { ...p };
  const walls = [...out.walls];
  const r = rnd();
  if (r < 0.2 && walls.length) walls.splice(Math.floor(rnd() * walls.length), 1);
  else if (r < 0.55 && walls.length) {
    const i = Math.floor(rnd() * walls.length);
    walls[i] = { ...walls[i], height: Math.round(((walls[i].height ?? 2.6) + rnd()) * 1000) / 1000 };
  } else if (r < 0.75) {
    walls.splice(Math.floor(rnd() * (walls.length + 1)), 0, { ...sampleProject.walls[0], id: `n${seed}` });
  } else if (r < 0.82) walls.reverse();
  out = { ...out, walls };
  const f = rnd();
  if (f < 0.15) out = { ...out, name: `n${seed}` };
  else if (f < 0.25) out = { ...out, referenceElevationMasl: Math.round(rnd() * 500) };
  else if (f < 0.32) out = { ...out, referenceElevationMasl: undefined };
  else if (f < 0.38) out = { ...out, geoAnchor: out.geoAnchor ? undefined : sampleProject.geoAnchor };
  else if (f < 0.42) out = { ...out, drawings2d: out.drawings2d.length ? [] : sampleProject.drawings2d };
  return out;
}

describe("Undo/Redo im Kern-Dokument", () => {
  it("1000 Zufallsänderungen: Undo bis zum Anfang = Ausgangsprojekt, Redo bis zum Ende = Endprojekt", () => {
    const d = new ProjectDocument(sampleProject);
    d.setHistoryLimits(5000, 1 << 30);
    let cur: Project = sampleProject;
    let steps = 0;
    for (let seed = 1; seed <= 1000; seed++) {
      const next = mutate(cur, seed);
      const ops = diffToOps(cur, next);
      if (!ops.length) continue;
      const r = d.commit(cur, ops, undefined, seed * 1000);
      expect("project" in r, `seed ${seed}`).toBe(true);
      if ("project" in r) cur = r.project;
      steps++;
    }
    const end = cur;
    expect(d.historyState().undo).toBe(steps);
    expect(JSON.parse(d.json())).toEqual(plain(end));
    for (;;) {
      const prev = d.undo(cur);
      if (!prev) break;
      cur = prev;
    }
    expect(cur).toEqual(sampleProject);
    // Exakt, auch die Feld-Reihenfolge, und Kern == Leseansicht.
    expect(JSON.stringify(cur)).toBe(JSON.stringify(sampleProject));
    expect(JSON.parse(d.json())).toEqual(plain(sampleProject));
    for (;;) {
      const next = d.redo(cur);
      if (!next) break;
      cur = next;
    }
    expect(JSON.stringify(cur)).toBe(JSON.stringify(end));
    expect(JSON.parse(d.json())).toEqual(plain(end));
    d.close();
  });

  it("coalesceKey: Serie im Zeitfenster = ein Schritt, unveränderte Elemente bleiben identisch", () => {
    const d = new ProjectDocument(sampleProject);
    let cur: Project = sampleProject;
    for (let i = 0; i < 50; i++) {
      const w = cur.walls[0];
      const next = { ...cur, walls: [{ ...w, height: 3 + i / 100 }, ...cur.walls.slice(1)] };
      const r = d.commit(cur, diffToOps(cur, next), "drag:W", 1000 + i * 10);
      if ("project" in r) cur = r.project;
    }
    expect(d.historyState().undo).toBe(1);
    const back = d.undo(cur)!;
    expect(back).toEqual(sampleProject);
    expect(back.walls[1]).toBe(cur.walls[1]);
    // Nach Undo beginnt dieselbe Serie einen neuen Schritt.
    const again = d.redo(back)!;
    const r = d.commit(again, diffToOps(again, { ...again, name: "x" }), "drag:W", 1500);
    expect("project" in r).toBe(true);
    expect(d.historyState().undo).toBe(2);
    d.close();
  });

  it("Gruppe: mehrere Änderungen = ein Schritt", () => {
    const d = new ProjectDocument(sampleProject);
    let cur: Project = sampleProject;
    d.beginGroup();
    for (const name of ["a", "b", "c"]) {
      const r = d.commit(cur, diffToOps(cur, { ...cur, name }), undefined, 0);
      if ("project" in r) cur = r.project;
    }
    d.endGroup();
    expect(d.historyState().undo).toBe(1);
    expect(d.undo(cur)!.name).toBe(sampleProject.name);
    d.close();
  });

  it("NaN und doppelte ids: abgelehnt mit den Meldungen der TS-Fassung, kein Schritt", () => {
    const d = new ProjectDocument(sampleProject);
    const w = sampleProject.walls[0];
    const nan = { ...sampleProject, walls: [{ ...w, height: NaN }, ...sampleProject.walls.slice(1)] };
    const r1 = d.commit(sampleProject, diffToOps(sampleProject, nan), undefined, 0);
    expect(r1).toEqual({ problems: [`„walls" ${w.id}: NaN ist nicht endlich.`] });
    const dup = { ...sampleProject, walls: [...sampleProject.walls, { ...w }] };
    const r2 = d.commit(sampleProject, diffToOps(sampleProject, dup), undefined, 0);
    expect(r2).toEqual({ problems: [`Doppelte ids in „walls".`] });
    const inf = { ...sampleProject, referenceElevationMasl: -Infinity } as Project;
    const r3 = d.commit(sampleProject, diffToOps(sampleProject, inf), undefined, 0);
    expect(r3).toEqual({ problems: [`Feld „referenceElevationMasl": -Infinity ist nicht endlich.`] });
    expect(d.historyState().undo).toBe(0);
    expect(JSON.parse(d.json())).toEqual(plain(sampleProject));
    d.close();
  });

  it("Fassaden validateOps/validateProject (Kern) melden wie bisher", () => {
    const w = sampleProject.walls[0];
    const ops: CoreOp[] = [
      { kind: "add", collection: "walls", items: [{ ...w, start: { x: Infinity, y: 0 } }] as never },
      { kind: "setField", key: "scale", value: NaN },
    ];
    const after = { ...sampleProject, walls: [...sampleProject.walls, ops[0].kind === "add" ? (ops[0].items[0] as unknown as Wall) : w] };
    expect(validateOps(after, ops, sampleProject)).toEqual([
      `„walls" ${w.id}: Infinity ist nicht endlich.`,
      `Doppelte ids in „walls".`,
      `Feld „scale": NaN ist nicht endlich.`,
    ]);
    // Alt-Doppelungen bleiben änderbar.
    expect(validateOps(after, [{ kind: "add", collection: "walls", items: [{ id: "neu" }] }], after)).toEqual([]);
    expect(validateProject(sampleProject)).toEqual([]);
  });

  it("Messung: grosses Projekt, viele Undo-Schritte", () => {
    const base = sampleProject.walls;
    const walls: Wall[] = Array.from({ length: 3000 }, (_, i) => ({
      ...base[i % base.length],
      id: `w${i}`,
      start: { x: i, y: 0 },
      end: { x: i + 1, y: 0 },
    }));
    const big: Project = { ...sampleProject, walls };
    const d = new ProjectDocument(big);
    d.setHistoryLimits(1000, 1 << 30);
    let cur = big;
    const n = 500;
    let t = performance.now();
    for (let i = 0; i < n; i++) {
      const k = (i * 7) % walls.length;
      const next = { ...cur, walls: cur.walls.map((w, j) => (j === k ? { ...w, height: 2 + i / 1000 } : w)) };
      const r = d.commit(cur, diffToOps(cur, next), undefined, i * 1000);
      if ("project" in r) cur = r.project;
    }
    const commitMs = (performance.now() - t) / n;
    const end = cur;
    t = performance.now();
    for (let p = d.undo(cur); p; p = d.undo(cur)) cur = p;
    const undoMs = (performance.now() - t) / n;
    t = performance.now();
    for (let p = d.redo(cur); p; p = d.redo(cur)) cur = p;
    const redoMs = (performance.now() - t) / n;
    const kib = Math.round(d.historyState().bytes / 1024);
    process.stderr.write(
      `3000 Wände, ${n} Schritte: setProject-Weg ${commitMs.toFixed(2)} ms/Schritt (diff+commit+apply), Undo ${undoMs.toFixed(2)} ms, Redo ${redoMs.toFixed(2)} ms, Verlauf ≈ ${kib} KiB\n`,
    );
    expect(cur.walls.map((w) => w.height)).toEqual(end.walls.map((w) => w.height));
    // Grosszügige Grenze (Container unter Last); typische Werte s. TODO [K4].
    expect(commitMs + undoMs + redoMs).toBeLessThan(50);
    d.close();
  });
});
