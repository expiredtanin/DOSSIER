import { describe, expect, it } from "vitest";
import { applyOps, diffToOps, validateProject } from "./ops";
import type { CoreOp } from "./ops";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";

const roundtrip = (ops: CoreOp[]): CoreOp[] => JSON.parse(JSON.stringify(ops));

/** Zufällige, aber deterministische Änderung eines Projekts. */
function mutate(p: Project, seed: number): Project {
  let x = seed;
  const rnd = () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
  let out = { ...p };
  const walls = [...out.walls];
  if (rnd() < 0.5 && walls.length) walls.splice(Math.floor(rnd() * walls.length), 1);
  if (rnd() < 0.7 && walls.length) {
    const i = Math.floor(rnd() * walls.length);
    walls[i] = { ...walls[i], height: (walls[i].height ?? 2.6) + rnd() };
  }
  if (rnd() < 0.6) walls.splice(Math.floor(rnd() * (walls.length + 1)), 0, { ...p.walls[0], id: `new-${seed}-a` }, { ...p.walls[0], id: `new-${seed}-b` });
  if (rnd() < 0.4) walls.reverse();
  out = { ...out, walls };
  if (rnd() < 0.5) out = { ...out, name: `n${seed}` };
  if (rnd() < 0.3) out = { ...out, referenceElevationMasl: rnd() * 500 };
  if (rnd() < 0.3) out = { ...out, geoAnchor: undefined };
  if (rnd() < 0.5) out = { ...out, drawings2d: [] };
  return out;
}

describe("CoreOps", () => {
  it("keine Änderung: keine Ops", () => {
    expect(diffToOps(sampleProject, sampleProject)).toEqual([]);
  });

  it("Roundtrip: apply(JSON(diff)) ergibt das Zielprojekt, für viele zufällige Änderungen", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = mutate(sampleProject, seed);
      const ops = roundtrip(diffToOps(sampleProject, next));
      expect(applyOps(sampleProject, ops)).toEqual(next);
    }
  });

  it("unveränderte Elemente behalten ihre Objekt-Identität", () => {
    const next = { ...sampleProject, walls: [...sampleProject.walls, { ...sampleProject.walls[0], id: "x-neu" }] };
    const out = applyOps(sampleProject, diffToOps(sampleProject, next));
    expect(out.walls[0]).toBe(sampleProject.walls[0]);
    expect(out.walls).toHaveLength(sampleProject.walls.length + 1);
  });

  it("jede Op-Art übersteht JSON ohne Unterschied", () => {
    const w = sampleProject.walls[0];
    const ops: CoreOp[] = [
      { kind: "add", collection: "walls", items: [{ ...w, id: "z1" }], at: 0 },
      { kind: "replace", collection: "walls", entity: { ...w, height: 9 } },
      { kind: "reorder", collection: "walls", ids: [w.id] },
      { kind: "remove", collection: "walls", ids: ["z1"] },
      { kind: "setField", key: "name", value: "J" },
      { kind: "setField", key: "geoAnchor" },
    ];
    expect(applyOps(sampleProject, roundtrip(ops))).toEqual(applyOps(sampleProject, ops));
  });

  it("Feld entfernen und Listen ohne ids als ganzes Feld", () => {
    const withAnchor = { ...sampleProject, referenceElevationMasl: 400 } as Project;
    const next = { ...withAnchor, referenceElevationMasl: undefined } as Project;
    const ops = diffToOps(withAnchor, next);
    expect(ops).toEqual([{ kind: "setField", key: "referenceElevationMasl" }]);
    expect("referenceElevationMasl" in applyOps(withAnchor, ops)).toBe(false);
  });

  it("Fuzz: beliebige Op-Folgen (auch Unsinn) werfen nicht und lassen das Original unberührt", () => {
    const snapshot = JSON.stringify(sampleProject);
    const junk: CoreOp[] = [
      { kind: "replace", collection: "doesNotExist", entity: { id: "q" } },
      { kind: "remove", collection: "walls", ids: ["gibt-es-nicht"] },
      { kind: "reorder", collection: "walls", ids: ["nope", "nada"] },
      { kind: "add", collection: "walls", items: [], at: -5 },
      { kind: "add", collection: "walls", items: [{ id: "q" }], at: 99999 },
      { kind: "setField", key: "walls", value: "kaputt" },
    ];
    for (let i = 0; i < junk.length; i++) expect(() => applyOps(sampleProject, junk.slice(0, i + 1))).not.toThrow();
    expect(JSON.stringify(sampleProject)).toBe(snapshot);
  });

  it("Validierung: gültiges Beispielprojekt ok; NaN und doppelte ids werden gemeldet", () => {
    expect(validateProject(sampleProject)).toEqual([]);
    const w = sampleProject.walls[0];
    const bad = { ...sampleProject, walls: [...sampleProject.walls, { ...w }] };
    expect(validateProject(bad).join()).toMatch(/Doppelte ids/);
    const nan = { ...sampleProject, walls: [{ ...w, height: NaN }, ...sampleProject.walls.slice(1)] };
    expect(validateProject(nan).join()).toMatch(/nicht endlich/);
  });
});
