// [68] Baugrube: Griffe für Umriss-Ecken, Kanten und Sohlenhöhe (Kern `grips.rs`, Griff-Lage `excavationGripPoints`).

import { describe, expect, it } from "vitest";
import { documentFor } from "../core/document";
import { sampleProject } from "../model/sampleProject";
import type { Excavation, Project } from "../model/types";
import { excavationGripPoints } from "./useGripEditing";

const pit: Excavation = {
  id: "bg",
  type: "excavation",
  name: "Baugrube",
  outline: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
  bottom: -2,
};
const project = (): Project => ({ ...sampleProject, context: [pit] });

function commit(base: Project, req: object): Excavation {
  const r = documentFor(base).commitGrip(base, req, undefined, 1);
  if ("problems" in r) throw new Error(r.problems.join(";"));
  return r.project.context!.find((c) => c.id === "bg") as Excavation;
}

describe("Baugrube: Griffe", () => {
  it("Griff-Punkte: Ecken plus Sohlen-Griff (Schwerpunkt, y + Sohle)", () => {
    const pts = excavationGripPoints(pit);
    expect(pts).toHaveLength(5);
    expect(pts[4]).toEqual({ x: 2, y: 0 });
  });

  it("Ecke, Kante und Sohle ziehen", () => {
    const p = project();
    expect(commit(p, { op: "excavationGrip", id: "bg", index: 2, pt: [5, 6] }).outline[2]).toEqual({ x: 5, y: 6 });
    const edge = commit(p, { op: "excavationEdge", id: "bg", a: 0, b: 1, delta: [0, -1] });
    expect([edge.outline[0].y, edge.outline[1].y]).toEqual([-1, -1]);
    // Sohlen-Griff liegt bei (2, 2 + bottom); auf y = −1 ziehen → bottom = −3.
    expect(commit(p, { op: "excavationGrip", id: "bg", index: 4, pt: [2, -1] }).bottom).toBe(-3);
  });
});
