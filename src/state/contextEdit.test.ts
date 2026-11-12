// [193] Gelände & Co.: Höhenversatz/Höhe je Höhenlinie (Kern `cmd_context.rs`), Punkte einer Höhenlinie per Griff
// (Kern `grips.rs::contour_edit`), Verschieben über den Kern, Bezugspunkt für den Fang beim Ziehen im Plan.

import { describe, expect, it } from "vitest";
import { documentFor } from "../core/document";
import { sampleProject } from "../model/sampleProject";
import type { ContextObject, ContourSet, Excavation, Project } from "../model/types";
import { contextAnchor } from "./contextDrag";
import { transformOps } from "../tools/transform";

const hl = {
  id: "hl",
  type: "contourSet",
  categoryCode: "02",
  name: "Höhenlinien",
  contours: [
    { z: 500, closed: false, pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }] },
    { z: 501, closed: true, pts: [{ x: 0, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 3 }] },
  ],
} as ContourSet;
const pit = { id: "bg", type: "excavation", categoryCode: "07", name: "Baugrube", outline: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }], bottom: -2 } as Excavation;
const project = (): Project => ({ ...sampleProject, context: [hl, pit] as ContextObject[] });

function commit<T extends ContextObject>(base: Project, req: object, id: string): T {
  const r = documentFor(base).commitGrip(base, req, undefined, 1);
  if ("problems" in r) throw new Error(r.problems.join(";"));
  return r.project.context!.find((c) => c.id === id) as T;
}

describe("Höhen über den Kern", () => {
  it("Höhenversatz und Höhe je Linie als Ops", () => {
    const p = project();
    expect(documentFor(p).cmdOps({ cmd: "contextOffset", id: "bg", dz: 1.5 })).toHaveLength(1);
    expect(documentFor(p).cmdOps({ cmd: "contextOffset", id: "bg", dz: 0 })).toEqual([]);
    const z = documentFor(p).cmdOps({ cmd: "contourZ", id: "hl", index: 1, z: 510 });
    expect(JSON.stringify(z)).toContain("510");
    expect(documentFor(p).cmdOps({ cmd: "contourZ", id: "hl", index: 1, z: 501 })).toEqual([]);
  });
});

describe("Höhenlinien: Punkte per Griff", () => {
  it("Punkt ziehen (flacher Index über alle Linien) und Punkt einfügen", () => {
    const p = project();
    expect(commit<ContourSet>(p, { op: "contourGrip", id: "hl", index: 4, pt: [9, 9] }, "hl").contours[1].pts[1]).toEqual({ x: 9, y: 9 });
    const ins = commit<ContourSet>(p, { op: "contourInsert", id: "hl", seg: 1, pt: [3, 1] }, "hl");
    expect(ins.contours[0].pts).toHaveLength(4);
    expect(ins.contours[0].pts[2]).toEqual({ x: 3, y: 1 });
  });
  it("Punkt löschen und Aufräumen laufen über ringDelete/ringTidy", () => {
    const p = project();
    expect(commit<ContourSet>(p, { op: "ringDelete", kind: "contours", id: "hl", index: 1 }, "hl").contours[0].pts).toHaveLength(2);
    expect(commit<ContourSet>(p, { op: "ringTidy", kind: "contours", id: "hl", index: 1, tol: 0.01 }, "hl").contours[0].pts).toHaveLength(2);
  });
});

describe("Kontext verschieben (Maus-Ziehen im Plan)", () => {
  it("ein Op-Satz verschiebt alle gewählten Elemente; Bezugspunkt je Art", () => {
    const p = project();
    const ops = transformOps(p, { wallIds: [], drawingId: null, contextIds: ["bg", "hl"] }, "move", [{ x: 0, y: 0 }, { x: 3, y: -1 }], "move", 1);
    expect(ops).toHaveLength(2);
    expect(contextAnchor(p, "bg")).toEqual({ x: 0, y: 0 });
    expect(contextAnchor(p, "hl")).toEqual({ x: 0, y: 0 });
    expect(contextAnchor(p, "nix")).toBeNull();
  });
});

describe("Gelände-Netz: Punkte und Zuschnitt [193]", () => {
  const mesh = {
    id: "tm", type: "terrainMesh", categoryCode: "02", name: "Gelände",
    positions: [0, 0, 1, 2, 0, 2, 2, 2, 3, 0, 2, 4], indices: [0, 1, 2, 0, 2, 3],
  } as unknown as ContextObject;
  const proj = (): Project => ({ ...sampleProject, context: [mesh] });
  it("Netzpunkt per Griff verschieben, Höhe setzen, auf Polygon zuschneiden", () => {
    const p = proj();
    const m = commit<ContextObject & { positions: number[] }>(p, { op: "meshGrip", id: "tm", index: 1, pt: [5, 6] }, "tm");
    expect(m.positions.slice(3, 6)).toEqual([5, 6, 2]);
    const z = documentFor(p).cmdOps({ cmd: "meshPointZ", id: "tm", index: 2, z: 9 });
    expect(JSON.stringify(z)).toContain("9");
    const crop = documentFor(p).cmdOps({ cmd: "meshCrop", id: "tm", poly: [-1, -1, 1, -1, 1, 3, -1, 3] });
    expect(JSON.stringify(crop)).toContain('"indices":[0,1,2]');
  });
});
