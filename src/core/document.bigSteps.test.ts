// Undo/Redo grosser Schritte (Importe) ohne Ops-Rückgabe ([K4], `stepStates.ts`): TS setzt die
// berührten Felder auf die gemerkten Stände; Leseansicht == Kern-JSON, Identität bleibt.
import { describe, expect, it, vi } from "vitest";
import { core } from "../engine/coreWasm";
import { sampleProject } from "../model/sampleProject";
import type { Drawing2D, Project } from "../model/types";
import { ProjectDocument } from "./document";
import type { CoreOp } from "./ops";
import { BIG_STEP } from "./stepStates";

const plain = (p: unknown): unknown => JSON.parse(JSON.stringify(p));

function drawings(n: number, tag: string): Drawing2D[] {
  const levelId = sampleProject.drawingLevels[0].id;
  return Array.from({ length: n }, (_, i) => ({
    id: `${tag}-${i}`,
    type: "drawing2d",
    levelId,
    geom: { shape: "line", a: { x: i, y: 0 }, b: { x: i, y: 1 } },
  })) as unknown as Drawing2D[];
}

function commit(d: ProjectDocument, p: Project, ops: CoreOp[], key?: string, now = 0): Project {
  const r = d.commit(p, ops, key, now);
  if ("problems" in r) throw new Error(r.problems.join("; "));
  return r.project;
}

const same = (d: ProjectDocument, p: Project) => expect(plain(p)).toEqual(JSON.parse(d.json()));

describe("grosse Verlaufsschritte", () => {
  it("Undo/Redo eines grossen Imports: ohne Ops aus dem Kern, Identität der Elemente bleibt", () => {
    const d = new ProjectDocument(sampleProject);
    const big = drawings(BIG_STEP + 500, "imp");
    const p1 = commit(d, sampleProject, [
      { kind: "add", collection: "drawings2d", items: big },
      { kind: "setField", key: "name", value: "Mit Import" },
    ]);
    const spyU = vi.spyOn(core(), "doc_undo");
    const spyR = vi.spyOn(core(), "doc_redo");
    const u = d.undo(p1)!;
    same(d, u);
    expect(u.drawings2d).toBe(sampleProject.drawings2d);
    expect(u.name).toBe(sampleProject.name);
    const r = d.redo(u)!;
    same(d, r);
    expect(r.drawings2d).toBe(p1.drawings2d);
    // Noch einmal hin und her (Laufnummern wechseln je Richtung).
    const u2 = d.undo(r)!;
    const r2 = d.redo(u2)!;
    expect(r2.drawings2d).toBe(p1.drawings2d);
    expect(spyU).not.toHaveBeenCalled();
    expect(spyR).not.toHaveBeenCalled();
    spyU.mockRestore();
    spyR.mockRestore();
    d.close();
  });

  it("gemischt mit kleinen Änderungen, Koaleszenz und Gruppen: immer gleich dem Kern", () => {
    const d = new ProjectDocument(sampleProject);
    const states: Project[] = [sampleProject];
    let p = sampleProject;
    // Grosser Schritt, kleiner Schritt auf derselben Liste, grosses Entfernen, verschmolzene Serie.
    p = commit(d, p, [{ kind: "add", collection: "drawings2d", items: drawings(1200, "a") }]);
    states.push(p);
    const first = p.drawings2d[0];
    p = commit(d, p, [{ kind: "replace", collection: "drawings2d", entity: { ...first, categoryCode: "x" } as never }]);
    states.push(p);
    p = commit(d, p, [{ kind: "remove", collection: "drawings2d", ids: p.drawings2d.slice(100, 1300).map((e) => e.id) }]);
    states.push(p);
    p = commit(d, p, [{ kind: "add", collection: "drawings2d", items: drawings(1100, "k1") }], "serie", 1000);
    p = commit(d, p, [{ kind: "add", collection: "drawings2d", items: drawings(1100, "k2") }], "serie", 1010);
    states.push(p);
    d.beginGroup();
    p = commit(d, p, [{ kind: "add", collection: "drawings2d", items: drawings(1500, "g1") }]);
    p = commit(d, p, [{ kind: "setField", key: "name", value: "G" }]);
    d.endGroup();
    states.push(p);
    for (let round = 0; round < 2; round++) {
      for (let i = states.length - 2; i >= 0; i--) {
        p = d.undo(p)!;
        same(d, p);
        expect(plain(p)).toEqual(plain(states[i]));
      }
      expect(d.undo(p)).toBeNull();
      for (let i = 1; i < states.length; i++) {
        p = d.redo(p)!;
        same(d, p);
        expect(plain(p)).toEqual(plain(states[i]));
      }
    }
    // Nach einem Undo eine neue Änderung: der Redo-Stapel ist weg, gemerkte Stände stören nicht.
    p = d.undo(p)!;
    p = commit(d, p, [{ kind: "setField", key: "name", value: "Neu" }]);
    expect(d.redo(p)).toBeNull();
    p = d.undo(p)!;
    p = d.undo(p)!;
    same(d, p);
    expect(plain(p)).toEqual(plain(states[states.length - 3]));
    d.close();
  });
});
