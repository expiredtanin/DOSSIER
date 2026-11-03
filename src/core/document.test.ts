import { describe, expect, it } from "vitest";
import { ProjectDocument, detachedLoadCount, documentFor, setPrimaryDocument, withDocument } from "./document";
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

  it("documentFor: ohne Store ein eigenes, ganz geladenes Dokument je Projekt-Stand (kein Abgleich)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const cur = mutate(sampleProject, seed);
      const before = detachedLoadCount();
      const d = documentFor(cur);
      expect(documentFor(cur)).toBe(d);
      expect(detachedLoadCount()).toBe(before + 1);
      expect(JSON.parse(d.json())).toEqual(plain(cur));
    }
  });

  it("withDocument: kurzlebiges Dokument, documentFor trifft es, danach geschlossen", async () => {
    const p = mutate(sampleProject, 7);
    const before = detachedLoadCount();
    let held: ProjectDocument | null = null;
    const n = withDocument(p, (d) => {
      held = d;
      expect(documentFor(p)).toBe(d);
      return d.current.walls.length;
    });
    expect(n).toBe(p.walls.length);
    expect(held!.id).toBe(0);
    await withDocument(p, async (d) => {
      await Promise.resolve();
      expect(documentFor(p)).toBe(d);
    });
    expect(detachedLoadCount()).toBe(before);
  });

  it("mit Store-Dokument wirft ein fremdes Projekt (Entwicklung/Tests)", () => {
    const store = new ProjectDocument(sampleProject);
    setPrimaryDocument(store);
    try {
      expect(documentFor(sampleProject)).toBe(store);
      expect(() => documentFor({ ...sampleProject, name: "anders" })).toThrow(/withDocument/);
      const other = { ...sampleProject, name: "anders" };
      expect(withDocument(other, (d) => documentFor(other) === d)).toBe(true);
    } finally {
      setPrimaryDocument(null);
      store.close();
    }
  });
});
