/**
 * [58] Inkrementelle 3D-Ableitung: `ProjectDocument.model3dParts` (Änderungs-Antworten, nur neue Einträge
 * je Wand) ergibt nach Änderungen, Undo und Redo dasselbe wie die volle Abfrage `model3dParts`.
 */
import { describe, it, expect } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { withDocument } from "../core/document";
import { addItems, patchItem, removeItems } from "../core/opsBuild";
import { ghostFilter3d, projectToModel3d, projectToModel3dParts, type Filter3d, type Model3dPart } from "./toWalls3d";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { Model3dPartsSync } from "../viewport/model3dPartsSync";

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

  // [214] Übrige Gruppen (Decken, Dächer, Kontext …) und Öffnungs-Rest reisen mit Laufnummer: Was der Viewer nach
  // einer Folge von Teil-Updates hält (Hauptmodell und Geisterschicht im Wechsel), ist dasselbe wie ein Neubau.
  it("[214] Teil-Updates für den Viewer = Neubau, Hauptmodell und Geisterschicht im Wechsel", () => {
    const start = buildComplexSampleProject();
    const floors = start.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId);
    const active = floors.find((f) => start.walls.some((w) => w.floorId === f.id))!;
    const hide: Filter3d = { greyFloors: floors.filter((f) => f.id !== active.id).map((f) => f.id) };
    const ghost = ghostFilter3d(hide)!;
    const content = (parts: Model3dPart[]) => parts.map(({ id: _id, fixed: _f, ...c }) => JSON.stringify(c)).sort();
    /** Was der Viewer nach den `set_parts`-Antworten hält (id → Inhalt). */
    class Viewer {
      sync = new Model3dPartsSync();
      held = new Map<string, string>();
      apply(parts: Model3dPart[]) {
        const d = this.sync.diff(parts);
        if (!d) return null;
        const j = JSON.parse(d.json) as { reset: boolean; remove: string[]; upsert: Array<{ id: string } & Record<string, unknown>> };
        if (j.reset) this.held.clear();
        for (const id of j.remove) this.held.delete(id);
        for (const { id, ...c } of j.upsert) this.held.set(id, JSON.stringify(c));
        return d;
      }
      content() {
        return [...this.held.values()].map((c) => JSON.stringify(JSON.parse(c))).sort();
      }
    }
    const views = [new Viewer(), new Viewer()];
    const filters = [hide, ghost];
    withDocument(start, (doc) => {
      let cur: Project = start;
      const commit = (ops: ReturnType<typeof patchItem>) => {
        const r = doc.commit(cur, ops, undefined, Date.now());
        if ("project" in r) cur = r.project;
        else throw new Error(r.problems.join("; "));
      };
      const check = (step: string, sent: Array<string | null>) => {
        views.forEach((v, i) => {
          const d = v.apply(projectToModel3dParts(cur, { detail: "mittel", voids: true, hide: filters[i] })!);
          sent[i] = d ? d.json : null;
        });
        const copy = structuredClone(cur);
        withDocument(copy, () => {
          views.forEach((v, i) => {
            expect(v.content(), `${step} (${i ? "Geisterschicht" : "Hauptmodell"})`).toEqual(content(projectToModel3dParts(copy, { detail: "mittel", voids: true, hide: filters[i] })!));
          });
        });
      };
      const sent: Array<string | null> = [null, null];
      check("Start", sent);
      const ctx = (cur.context ?? []).length;
      // Wand verschieben: Kontext, Dächer, Körper reisen nicht noch einmal.
      const w = cur.walls.find((x) => x.floorId === active.id)!;
      commit(patchItem(cur, "walls", w.id, { start: { x: w.start.x + 0.02, y: w.start.y }, end: { x: w.end.x + 0.02, y: w.end.y } }));
      check("Wand verschoben", sent);
      const groups = (json: string | null) => (json ? (JSON.parse(json) as { upsert: Array<{ id: string }> }).upsert.map((u) => u.id.split(":")[0]) : []);
      expect(groups(sent[0]).filter((g) => ["context", "roofs", "solids", "columns"].includes(g))).toEqual([]);
      // Geisterschicht: höchstens die Decken (die Platte über dem Geschoss liegt auf der verschobenen Wand auf).
      expect(groups(sent[1]).filter((g) => g !== "slabs"), "Geisterschicht").toEqual([]);
      // Ohne Änderung: nichts.
      check("unverändert", sent);
      expect(sent).toEqual([null, null]);
      // Öffnung ändern, Decke ändern (Cache verworfen), Kontext ergänzen.
      const o = (cur.openings ?? [])[0];
      commit(patchItem(cur, "openings", o.id, { width: o.width * 0.9 }));
      check("Öffnung", sent);
      const c = (cur.ceilings ?? [])[0];
      commit(patchItem(cur, "ceilings", c.id, { thickness: (c.thickness ?? 0.25) + 0.02 } as never));
      check("Decke", sent);
      commit(addItems("context", [{ type: "importedMesh", id: "nachbar-214", name: "Nachbar", categoryCode: "12", positions: [30, 0, 0, 36, 0, 0, 36, 6, 0, 30, 0, 5], indices: [0, 1, 2, 0, 2, 3] }]));
      check("Kontext", sent);
      expect((cur.context ?? []).length).toBe(ctx + 1);
      const u = doc.undo(cur);
      if (u) cur = u;
      check("Undo", sent);
    });
  }, 120_000); // unter Last (parallele Builds) dauert der Wechsel über 30 s
});

