// Stützen-Domäne der 3D-Ableitung (Tragwerk): extrudiert `project.columns` zu
// parametrischen Prisma-Meshes (Rechteck-Box bzw. tesselliertes Kreis-Prisma).
//
// Das Prisma (Mantel-Quads, Deckel als Dreiecksfächer) rechnet Rust
// (`src-tauri/core/src/columns3d.rs`); hier nur Querschnitt und Höhen sammeln und einfärben.

import type { Column, Project, Vec2 } from "../../model/types";
import { getComponent } from "../../model/types";
import { columnFootprint } from "../../geometry/column";
import { columnVerticalExtent } from "../../model/wall";
import { core } from "../../engine/coreWasm";
import { hexToRgb, type RMesh, type RRgb } from "./shared";

/** Neutraler Beton-/Tragwerks-Grauton für Stützen (Fallback ohne Bauteil-Farbe). */
const COLUMN_RGB: RRgb = [0.7, 0.7, 0.72];

/**
 * 3D-Farbe einer Stütze: die Bauteil-Albedo (`Component.color`), falls ein
 * `componentId` auflösbar ist, sonst der neutrale Tragwerks-Grauton {@link
 * COLUMN_RGB}. Eine explizite `column.color` (Grundriss-Umrissfarbe) wirkt
 * bewusst NICHT auf die 3D-Fläche (nur der 2D-Umriss), damit die 3D-Darstellung
 * material-/neutral bleibt — analog Wand (Umrissfarbe ≠ 3D-Albedo).
 */
function columnColor3d(project: Project, col: Column): RRgb {
  if (col.componentId) {
    try {
      return hexToRgb(getComponent(project, col.componentId).color, COLUMN_RGB);
    } catch {
      return COLUMN_RGB;
    }
  }
  return COLUMN_RGB;
}

/**
 * Extrudiert `project.columns` (Tragwerk) zu parametrischen Prisma-Meshes —
 * Rechteck-Box bzw. tesselliertes Kreis-Prisma, je Profil. SYNCHRON (anders als
 * die truck-Extrusion der `ExtrudedSolid`s, s. `../extrusions.ts`): die
 * Kontur kommt aus `columnFootprint`, die vertikale Lage aus
 * `columnVerticalExtent` (UK/OK-Anker bzw. Geschoss-UK + Höhe). `positions` in MODELL-Metern
 * (x, y, z=Höhe); render3d rendert Kontext-Meshes doppelseitig, die Winding-Reihenfolge ist
 * unerheblich. Rust/render3d bleibt unverändert (Kontext-Mesh-Pfad).
 */
export function emitColumns(project: Project): RMesh[] {
  const cols: Column[] = [];
  const feet: Vec2[][] = [];
  const zs: number[] = [];
  let doubles = 1;
  for (const col of project.columns ?? []) {
    if (col.height <= 0) continue;
    const { zBottom, zTop } = columnVerticalExtent(project, col);
    const foot = columnFootprint(col);
    cols.push(col);
    feet.push(foot);
    zs.push(zBottom, zTop);
    doubles += 3 + 2 * foot.length;
  }
  if (cols.length === 0) return [];
  const buf = new Float64Array(doubles);
  buf[0] = cols.length;
  let w = 1;
  for (let k = 0; k < cols.length; k++) {
    const foot = feet[k];
    buf[w++] = zs[2 * k];
    buf[w++] = zs[2 * k + 1];
    buf[w++] = foot.length;
    for (const p of foot) {
      buf[w++] = p.x;
      buf[w++] = p.y;
    }
  }
  const f = core().columns3d_flat(buf);

  const out: RMesh[] = [];
  let i = 1;
  for (let n = f.length ? f[0] : 0; n > 0; n--) {
    const col = cols[f[i]];
    const nPos = f[i + 1];
    const nIdx = f[i + 2];
    i += 3;
    const positions: number[] = [];
    for (let k = 0; k < nPos; k++) positions.push(f[i + k]);
    i += nPos;
    const indices: number[] = [];
    for (let k = 0; k < nIdx; k++) indices.push(f[i + k]);
    i += nIdx;
    out.push({ positions, indices, kind: "extrusion", color: columnColor3d(project, col) });
  }
  return out;
}
