/**
 * [58] Inkrementelle 3D-Ableitung: `ProjectDocument.model3dParts` (Änderungs-Antworten, nur neue Einträge
 * je Wand) ergibt nach Änderungen, Undo und Redo dasselbe wie die volle Abfrage `model3dParts`.
 */
import { describe, it, expect } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { withDocument } from "../core/document";
import { addItems, patchItem, removeItems } from "../core/opsBuild";
import { projectToModel3d } from "./toWalls3d";

const ARGS = [
  [1, 2, 0, 0, 0],
  [1, 0, 0, 0, 0],
  [0, 1, 1, 0, 0],
];

describe("3D-Modell inkrementell", () => {
  it("gleich wie voll nach Änderungen, Undo und Redo", () => {
    withDocument(sampleProject, (doc) => {
      let cur: Project = sampleProject;
      const check = (step: string) => {
        for (const a of ARGS) {
          expect(doc.model3dParts(a), `${step} ${a}`).toEqual(JSON.parse(doc.queryJson("model3dParts", a)));
        }
      };
      const commit = (ops: ReturnType<typeof patchItem>) => {
        const r = doc.commit(cur, ops, undefined, Date.now());
        if ("project" in r) cur = r.project;
        else throw new Error(r.problems.join("; "));
      };
      check("Start");
      const openings = cur.openings ?? [];
      expect(openings.length).toBeGreaterThan(0);
      for (let i = 0; i < 12; i++) {
        const w = cur.walls[(i * 5) % cur.walls.length];
        switch (i % 6) {
          case 0:
            commit(patchItem(cur, "walls", w.id, { height: (w.height ?? 2.6) + 0.1 }));
            break;
          case 1:
            commit(patchItem(cur, "walls", w.id, { end: { x: w.end.x + 0.05, y: w.end.y } }));
            break;
          case 2: {
            const o = (cur.openings ?? [])[i % openings.length];
            commit(patchItem(cur, "openings", o.id, { width: o.width * 0.9 }));
            break;
          }
          case 3:
            commit(addItems("walls", [{ ...w, id: `neu${i}`, start: { x: w.start.x, y: w.start.y + 0.4 } }]));
            break;
          case 4:
            commit(removeItems(cur, "walls", [w.id]));
            break;
          default: {
            const u = doc.undo(cur);
            if (u) cur = u;
            check(`Undo ${i}`);
            const r = doc.redo(cur);
            if (r) cur = r;
          }
        }
        check(`Schritt ${i}`);
      }
      // Die Fassade liefert dasselbe Modell wie ein frisch geöffnetes Dokument.
      const inc = JSON.stringify(projectToModel3d(cur));
      const copy = structuredClone(cur);
      const fresh = withDocument(copy, () => JSON.stringify(projectToModel3d(copy)));
      expect(inc).toBe(fresh);
    });
  });
});
