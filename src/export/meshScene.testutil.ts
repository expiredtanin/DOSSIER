// Testhilfe: liest die Mesh-Szene des Kerns (`meshExportData`, Kodierung `mesh_export.rs`) — z. B. das
// öffnungsgenaue Wand-Volumen je Wand als Vergleichswert für IFC-Export und -Import.

import type { Project } from "../model/types";
import { documentFor } from "../core/document";
import { decodeExportFlat } from "./exportIfc";

export interface SceneGroup {
  name: string;
  kind: string;
  id: string;
  prims: { positions: Float64Array; indices: Float64Array }[];
}

/** Knoten der Mesh-Szene (Welt x, Höhe, y; Wicklung nach aussen im Modell). */
export function meshSceneGroups(project: Project): SceneGroup[] {
  const [b, text] = decodeExportFlat(documentFor(project).queryBin("meshExportData", [1, 1, 0]));
  const s = text.split("\0");
  let i = 2;
  i += 1 + b[i] * 7;
  i += 1 + b[i] * 2;
  const n = b[i++];
  const out: SceneGroup[] = [];
  for (let g = 0; g < n; g++) {
    const group: SceneGroup = { name: s[b[i]], kind: s[b[i + 1]], id: s[b[i + 2]], prims: [] };
    const np = b[i + 4];
    i += 5;
    for (let k = 0; k < np; k++) {
      const nv = b[i + 1];
      const positions = b.subarray(i + 2, i + 2 + nv * 3);
      i += 2 + nv * 3;
      const nt = b[i];
      const indices = b.subarray(i + 1, i + 1 + nt * 3);
      i += 1 + nt * 3;
      group.prims.push({ positions, indices });
    }
    out.push(group);
  }
  return out;
}

/** Volumen je Wand (Summe der Beträge je Schicht-Band, Öffnungen samt Laibungen ausgestanzt). */
export function wallMeshVolumes(project: Project): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of meshSceneGroups(project)) {
    if (g.kind !== "wall") continue;
    let sum = 0;
    for (const { positions: p, indices: x } of g.prims) {
      let v6 = 0;
      for (let t = 0; t + 2 < x.length; t += 3) {
        const [a, b, c] = [x[t] * 3, x[t + 1] * 3, x[t + 2] * 3];
        v6 += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
      }
      sum += Math.abs(v6) / 6;
    }
    out.set(g.id, sum);
  }
  return out;
}
