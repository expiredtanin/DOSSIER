// Abzugskörper im 3D: jede Wandschicht und Decke, die ein Abzugskörper durchdringt, bestimmt der
// Kern samt Spezifikation (`solid_specs.rs`, Abfrage `model3dParts` mit `voids`); hier wird sie
// über truck als Boolean-Differenz gebaut (B-Rep, bei bündigen Flächen automatisch Mesh-CSG) und
// statt des Prismas als Mesh gezeigt.
//
// Wie die Extrusionen (`extrusions.ts`) asynchron mit modulweitem Cache: solange das Ergebnis
// lädt, bleibt das ungeschnittene Prisma stehen; ist es fertig, feuert
// `TRUCK_MESH_READY_EVENT` und der Viewer pusht das Modell neu.

import { buildSolidMesh } from "../../engine/truckSolid";
import type { SolidSpec } from "../../engine/truckSolid";
import { TRUCK_MESH_READY_EVENT } from "./extrusions";
import type { RMesh, RModel3d, RSlab, RWall } from "./shared";

/** Vom Kern getroffene Bauteile: (Index in `walls` bzw. `slabs`, Bauteil − Körper). */
export interface VoidCuts {
  walls: Array<[number, SolidSpec]>;
  slabs: Array<[number, SolidSpec]>;
}

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
export function applyVoids3d(model: RModel3d, cuts: VoidCuts): void {
  if (typeof window === "undefined") return;
  const live = new Set<string>();
  const wallCut = new Map(cuts.walls);
  const walls: RWall[] = [];
  model.walls.forEach((w, i) => {
    const spec = wallCut.get(i);
    if (!spec) {
      walls.push(w);
      return;
    }
    const key = `w:${w.wallId}:${i}`;
    live.add(key);
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

  const slabCut = new Map(cuts.slabs);
  const slabs: RSlab[] = [];
  model.slabs.forEach((s, i) => {
    const spec = slabCut.get(i);
    if (!spec) {
      slabs.push(s);
      return;
    }
    const key = `s:${s.ceilingId}:${i}`;
    live.add(key);
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
