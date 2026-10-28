import { describe, expect, it } from "vitest";
import { ProjectDocument } from "./document";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";

const plain = (p: Project): unknown => JSON.parse(JSON.stringify(p));

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

describe("ProjectDocument (Kern-Spiegel)", () => {
  it("öffnet das Projekt unverändert", () => {
    const d = new ProjectDocument(sampleProject);
    expect(JSON.parse(d.json())).toEqual(plain(sampleProject));
    d.close();
  });

  it("folgt beliebigen Änderungen über Ops", () => {
    const d = new ProjectDocument(sampleProject);
    let cur = sampleProject;
    for (let seed = 1; seed <= 300; seed++) {
      cur = mutate(cur, seed);
      d.sync(cur);
      const got = JSON.parse(d.json()) as Record<string, unknown>;
      const want = plain(cur) as Record<string, unknown>;
      const bad = [...new Set([...Object.keys(got), ...Object.keys(want)])].filter((k) => JSON.stringify(got[k]) !== JSON.stringify(want[k]));
      expect(bad, `seed ${seed}`).toEqual([]);
    }
    d.close();
  });

  it("heilt sich bei doppelten ids (Neuöffnen)", () => {
    const d = new ProjectDocument(sampleProject);
    const dup = { ...sampleProject, walls: [...sampleProject.walls, sampleProject.walls[0]] };
    d.sync(dup);
    expect(JSON.parse(d.json())).toEqual(plain(dup));
    d.close();
  });
});
