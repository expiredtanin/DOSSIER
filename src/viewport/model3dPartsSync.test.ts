/**
 * [58] Teil-Updates des 3D-Viewers: `projectToModel3dParts` enthält dasselbe wie `projectToModel3d`, und
 * `Model3dPartsSync` schickt nach einer Wand-Änderung nur deren Teile (plus die Entfernung der alten).
 */
import { describe, it, expect } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { withDocument } from "../core/document";
import { patchItem } from "../core/opsBuild";
import { projectToModel3d, projectToModel3dParts, type Model3dPart } from "../core";
import { Model3dPartsSync } from "./model3dPartsSync";

/** Inhalt als sortierte JSON-Liste je Feld (Reihenfolge der Teile egal). */
function bag(m: { walls?: unknown[]; slabs?: unknown[]; meshes?: unknown[]; roofLayers?: unknown[] }[]) {
  const out: Record<string, string[]> = { walls: [], slabs: [], meshes: [], roofLayers: [] };
  for (const p of m) for (const k of Object.keys(out)) for (const x of (p as Record<string, unknown[]>)[k] ?? []) out[k].push(JSON.stringify(x));
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

describe("3D-Viewer Teil-Updates", () => {
  it("Teile = ganzes Modell; nach 1 Wand-Änderung reist nur diese", () => {
    let cur: Project = structuredClone(sampleProject);
    withDocument(cur, (doc) => {
      const parts = projectToModel3dParts(cur)!;
      expect(parts).not.toBeNull();
      expect(bag(parts)).toEqual(bag([projectToModel3d(cur)]));
      expect(new Set(parts.map((p) => p.id)).size).toBe(parts.length);

      const sync = new Model3dPartsSync();
      const first = sync.diff(parts)!;
      expect(first.reset).toBe(true);
      expect(first.upserted).toBe(parts.length);
      const msg = JSON.parse(first.json) as { upsert: { id: string }[] };
      expect(msg.upsert.map((u) => u.id)).toEqual(parts.map((p) => p.id));
      expect(sync.diff(projectToModel3dParts(cur)!)).toBeNull();

      const w = cur.walls[3];
      const r = doc.commit(cur, patchItem(cur, "walls", w.id, { height: (w.height ?? 2.6) + 0.2 }), undefined, Date.now());
      if (!("project" in r)) throw new Error(r.problems.join("; "));
      cur = r.project;
      const after = projectToModel3dParts(cur)!;
      expect(bag(after)).toEqual(bag([projectToModel3d(cur)]));
      const d = sync.diff(after)!;
      expect(d.reset).toBe(false);
      // Die Wand (ggf. mit Nachbarn über Verschneidung) und ihre Öffnungs-Einbauteile; keine Rest-Gruppe.
      expect(d.upserted).toBeGreaterThan(0);
      expect(d.upserted).toBeLessThanOrEqual(6);
      expect(d.removed).toBe(d.upserted);
      const ids = (JSON.parse(d.json) as { upsert: { id: string }[] }).upsert.map((u) => u.id);
      expect(ids.every((id) => /^[wo]/.test(id))).toBe(true);
    });
  });

  it("Rest-Gruppen nach Inhalt, unveränderliche Teile nach id; Entfernen; Reset", () => {
    const sync = new Model3dPartsSync();
    const wall = { start: [0, 0], end: [1, 0], thickness: 0.2, height: 3 } as unknown as NonNullable<Model3dPart["walls"]>[number];
    const a: Model3dPart[] = [
      { id: "w1", fixed: true, walls: [wall] },
      { id: "slabs", fixed: false, slabs: [] },
    ];
    expect(sync.diff(a)!.upserted).toBe(2);
    // Gleiche id eines unveränderlichen Teils: nicht nochmals, auch mit anderem Objekt.
    expect(sync.diff([{ ...a[0], walls: [{ ...wall }] }, a[1]])).toBeNull();
    const d = sync.diff([a[0], { id: "slabs", fixed: false, meshes: [] }])!;
    expect(JSON.parse(d.json)).toEqual({ reset: false, remove: [], upsert: [{ id: "slabs", meshes: [] }] });
    const e = sync.diff([{ id: "w2", fixed: true, walls: [wall] }])!;
    expect(JSON.parse(e.json)).toEqual({ reset: false, remove: ["w1", "slabs"], upsert: [{ id: "w2", walls: [wall] }] });
    sync.reset();
    expect(JSON.parse(sync.diff([{ id: "w2", fixed: true }])!.json)).toEqual({ reset: true, remove: [], upsert: [{ id: "w2" }] });
  });
});
