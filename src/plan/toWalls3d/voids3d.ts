// Abzugskörper im 3D (s. `plan/voids.ts`): jede Wandschicht und Decke, die ein Abzugskörper
// durchdringt, wird über truck als Boolean-Differenz gebaut (B-Rep, bei bündigen Flächen
// automatisch Mesh-CSG) und statt des Prismas als Mesh gezeigt.
//
// Wie die Extrusionen (`extrusions.ts`) asynchron mit modulweitem Cache: solange das Ergebnis
// lädt, bleibt das ungeschnittene Prisma stehen; ist es fertig, feuert
// `TRUCK_MESH_READY_EVENT` und der Viewer pusht das Modell neu.

import type { Project } from "../../model/types";
import { buildSolidMesh } from "../../engine/truckSolid";
import type { SolidSpec } from "../../engine/truckSolid";
import { wallSpec } from "../wallSpec";
import { bbox, hittingVoids, subtractSpec, voidPrisms, wallCorners } from "../voids";
import { TRUCK_MESH_READY_EVENT } from "./extrusions";
import type { RMesh, RModel3d, RSlab, RVec2, RWall } from "./shared";

interface Entry {
  signature: string;
  /** null = lädt noch; "failed" = Boolean scheiterte (Prisma bleibt). */
  mesh: RMesh | null | "failed";
}
const cache = new Map<string, Entry>();

function request(key: string, signature: string, spec: SolidSpec, make: (m: { positions: number[]; indices: number[] }) => RMesh): Entry {
  let e = cache.get(key);
  if (e && e.signature === signature) return e;
  const entry: Entry = { signature, mesh: null };
  cache.set(key, entry);
  buildSolidMesh(spec, 0.005)
    .then((m) => {
      const cur = cache.get(key);
      if (cur !== entry) return;
      entry.mesh = make(m);
      window.dispatchEvent(new Event(TRUCK_MESH_READY_EVENT));
    })
    .catch((err) => {
      entry.mesh = "failed";
      console.warn("Abzugskörper-Boolean fehlgeschlagen:", err);
    });
  e = entry;
  return e;
}

/**
 * Ersetzt in `model` die von Abzugskörpern getroffenen Wandschichten/Decken durch ihre
 * Boolean-Meshes (sobald geladen). Ohne `window` (Tests/Node) bleibt das Modell unverändert.
 */
export function applyVoids3d(model: RModel3d, project: Project): void {
  if (typeof window === "undefined") return;
  const voids = voidPrisms(project);
  if (voids.length === 0) return;
  const live = new Set<string>();

  const walls: RWall[] = [];
  model.walls.forEach((w, i) => {
    const hits = hittingVoids(voids, bbox(wallCorners(w)), w.baseElevation, w.baseElevation + w.height);
    const base = hits.length ? wallSpec(w) : null;
    if (!base) {
      walls.push(w);
      return;
    }
    const key = `w:${w.wallId}:${i}`;
    live.add(key);
    const spec = subtractSpec(base, hits);
    const e = request(key, JSON.stringify(spec), spec, (m) => ({
      positions: m.positions,
      indices: m.indices,
      kind: "extrusion",
      color: w.color,
      ...(w.materialIndex !== undefined ? { materialIndex: w.materialIndex } : {}),
    }));
    if (e.mesh && e.mesh !== "failed") model.meshes.push(e.mesh);
    else walls.push(w);
  });
  model.walls = walls;

  const slabs: RSlab[] = [];
  model.slabs.forEach((s, i) => {
    const foot = bbox(s.outline.map((p: RVec2) => ({ x: p[0], y: p[1] })));
    const hits = s.outline.length >= 3 ? hittingVoids(voids, foot, s.zBottom, s.zTop) : [];
    if (hits.length === 0) {
      slabs.push(s);
      return;
    }
    const key = `s:${s.ceilingId}:${i}`;
    live.add(key);
    const base: SolidSpec = { kind: "extrude", points: s.outline.flatMap((p) => [p[0], p[1]]), height: s.zTop - s.zBottom, z0: s.zBottom };
    const spec = subtractSpec(base, hits);
    const e = request(key, JSON.stringify(spec), spec, (m) => ({
      positions: m.positions,
      indices: m.indices,
      kind: "extrusion",
      color: s.color,
    }));
    if (e.mesh && e.mesh !== "failed") model.meshes.push(e.mesh);
    else slabs.push(s);
  });
  model.slabs = slabs;

  for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
}
