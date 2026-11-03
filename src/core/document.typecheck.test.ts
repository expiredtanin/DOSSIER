// [124] Ops werden gegen das typisierte Modell geprüft: die Beispielprojekte (Musterhaus, Musterhaus
// komplex — dieses entsteht zum Teil über Kern-Befehle) gehen als Op-Folge durch, Element für Element;
// ein falsch typisierter Wert wird mit Meldung (id, Feld, Fehler) zurückgewiesen.

import { describe, expect, it } from "vitest";
import { ProjectDocument } from "./document";
import type { CoreOp } from "./ops";
import type { Project } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";

const empty = (): Project => ({ id: "p", name: "leer", lineStyles: [], hatches: [], components: [], wallTypes: [], drawingLevels: [], layers: [], walls: [], drawings2d: [] });

/** Das ganze Projekt als Ops: Listen mit ids elementweise (`add` je Element), sonst `setField`. */
function projectOps(p: Project): CoreOp[] {
  const ops: CoreOp[] = [];
  for (const [key, value] of Object.entries(p)) {
    if (value === undefined) continue;
    const isIdList = Array.isArray(value) && value.length > 0 && value.every((e) => e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string");
    if (isIdList) for (const item of value as { id: string }[]) ops.push({ kind: "add", collection: key, items: [item] });
    else ops.push({ kind: "setField", key, value });
  }
  return ops;
}

describe("Op-Prüfung gegen das Modell ([124])", () => {
  for (const [name, build] of [["Musterhaus", () => sampleProject], ["Musterhaus komplex", buildComplexSampleProject]] as const) {
    it(`${name}: alle Elemente als Ops angenommen`, () => {
      const p = build();
      const base = empty();
      const doc = new ProjectDocument(base);
      const res = doc.commit(base, projectOps(p), undefined, 0);
      expect("problems" in res ? res.problems : []).toEqual([]);
      if ("project" in res) expect(res.project.walls.length).toBe(p.walls.length);
      doc.close();
    });
  }

  it("falsch typisierte Werte werden mit id, Feld und Fehler zurückgewiesen", () => {
    const p: Project = { ...empty(), walls: [{ ...sampleProject.walls[0], id: "w1" }] };
    const doc = new ProjectDocument(p);
    const bad = { ...p.walls[0], height: "hoch" as unknown as number };
    const res = doc.commit(p, [{ kind: "replace", collection: "walls", entity: bad }], undefined, 0);
    expect("problems" in res).toBe(true);
    const text = "problems" in res ? res.problems.join(" ") : "";
    expect(text).toContain("w1");
    expect(text).toContain("height");
    const enumBad = doc.commit(p, [{ kind: "add", collection: "drawings2d", items: [{ id: "d", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "klecks" } } as never] }], undefined, 0);
    expect("problems" in enumBad && enumBad.problems.join(" ")).toContain("unknown variant");
    doc.close();
  });
});
