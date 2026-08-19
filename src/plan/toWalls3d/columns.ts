// Stützen-Domäne der 3D-Ableitung (Tragwerk): extrudiert `project.columns` zu
// parametrischen Prisma-Meshes (Rechteck-Box bzw. tesselliertes Kreis-Prisma).

import type { Column, Project, Vec2 } from "../../model/types";
import { getComponent } from "../../model/types";
import { columnFootprint } from "../../geometry/column";
import { columnVerticalExtent } from "../../model/wall";
import { EPS, hexToRgb, type RMesh, type RRgb } from "./shared";

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
 * Baut ein geschlossenes Prisma-Mesh aus einem konvexen Grundriss-Polygon
 * `foot` (≥3 Punkte, CCW) zwischen `zBottom` und `zTop`. `positions` in MODELL-
 * Metern (x, y, z=Höhe); render3d rendert Kontext-Meshes doppelseitig, daher
 * ist die Winding-Reihenfolge unerheblich. Die Deckel werden als Dreiecks-
 * Fächer ab dem ersten Vertex tesselliert (konvex → korrekt).
 */
function prismMesh(foot: Vec2[], zBottom: number, zTop: number, color: RRgb): RMesh {
  const n = foot.length;
  const positions: number[] = [];
  const indices: number[] = [];
  // 0..n-1 = untere Ring-Vertices, n..2n-1 = obere Ring-Vertices.
  for (const p of foot) positions.push(p.x, p.y, zBottom);
  for (const p of foot) positions.push(p.x, p.y, zTop);
  // Mantelflächen: je Kante ein Quad (2 Dreiecke).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = i, b1 = j, t0 = i + n, t1 = j + n;
    indices.push(b0, b1, t1, b0, t1, t0);
  }
  // Deckel (Fächer ab Vertex 0): unten + oben.
  for (let i = 1; i < n - 1; i++) {
    indices.push(0, i, i + 1); // unten
    indices.push(n, n + i, n + i + 1); // oben
  }
  return { positions, indices, kind: "extrusion", color };
}

/**
 * Extrudiert `project.columns` (Tragwerk) zu parametrischen Prisma-Meshes —
 * Rechteck-Box bzw. tesselliertes Kreis-Prisma, je Profil. SYNCHRON (anders als
 * die truck-Extrusion der `ExtrudedSolid`s, s. `../extrusions.ts`): die
 * Kontur kommt aus `columnFootprint`, die vertikale Lage aus
 * `columnVerticalExtent` (UK/OK-Anker bzw. Geschoss-UK + Höhe). Rust/render3d
 * bleibt unverändert (Kontext-Mesh-Pfad).
 */
export function emitColumns(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const col of project.columns ?? []) {
    if (col.height <= 0) continue;
    const foot = columnFootprint(col);
    if (foot.length < 3) continue;
    const { zBottom, zTop } = columnVerticalExtent(project, col);
    if (zTop - zBottom <= EPS) continue;
    out.push(prismMesh(foot, zBottom, zTop, columnColor3d(project, col)));
  }
  return out;
}
