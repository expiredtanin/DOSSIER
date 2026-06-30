// Gelände-Generierung (TIN) aus Konturen (Höhenlinien).
//
// Prinzip: Die Stütz-Vertices der Konturen werden als Punktmenge genommen
// (sie liegen direkt auf den Höhenlinien = bevorzugte „Breaklines"). Über deren
// (x,y)-Projektion wird eine 2D-Delaunay-Triangulation gelegt; die Z-Höhe je
// Vertex stammt aus der jeweiligen Kontur. Daraus entsteht ein TIN (Triangulated
// Irregular Network) als rohes positions/indices-Mesh (three-frei).
//
// Gelände ist NICHT semantisch — es ist Kontext-Geometrie (Project.context).

import Delaunator from "delaunator";
import type { Contour, TerrainMesh } from "./types";

let terrainSeq = 0;

/**
 * Erzeugt ein TIN aus Konturen.
 *
 * Algorithmus:
 *  1. Sampling: jeder Stützpunkt jeder Kontur wird ein 3D-Vertex (x, y, z) mit
 *     z = Kontur-Höhe. Es wird KEIN zusätzliches Resampling betrieben — die
 *     Kontur-Vertices selbst sind die Breaklines.
 *  2. Delaunay: 2D-Triangulation über die (x,y)-Projektion aller Vertices
 *     (Delaunator). Die Z-Höhe je Vertex bleibt erhalten → echtes Gelände-TIN.
 *  3. Degenerate-Filter: Dreiecke mit (nahezu) null Fläche in der (x,y)-Ebene
 *     bzw. mit nicht-endlichen Koordinaten werden verworfen.
 *
 * Robustheit:
 *  • offene UND geschlossene Konturen werden gleich behandelt (nur die Punkte
 *    zählen; closed/offen beeinflusst die TIN-Fläche nicht).
 *  • leere/zu kleine Eingabe (< 3 Punkte) → leeres Mesh (kein Crash).
 *  • NaN/Infinity-Punkte werden vor der Triangulation aussortiert.
 */
export function generateTerrainFromContours(contours: Contour[]): TerrainMesh {
  const id = `terrain-${Date.now()}-${terrainSeq++}`;
  const name = "Gelände";

  // 1. Sampling: alle Kontur-Stützpunkte als (x,y,z)-Vertices sammeln, ungültige
  //    (nicht-endliche) Punkte überspringen.
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const c of contours) {
    const z = Number.isFinite(c.z) ? c.z : 0;
    for (const p of c.pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      xs.push(p.x);
      ys.push(p.y);
      zs.push(z);
    }
  }

  // Zu wenige Punkte für ein Dreieck → triviales leeres Mesh.
  if (xs.length < 3) {
    return { id, type: "terrainMesh", name, positions: [], indices: [] };
  }

  // 2. Delaunay über die (x,y)-Projektion. Delaunator erwartet ein flaches
  //    [x0,y0, x1,y1, …]-Koordinatenarray.
  const coords2d = new Float64Array(xs.length * 2);
  for (let i = 0; i < xs.length; i++) {
    coords2d[i * 2] = xs[i];
    coords2d[i * 2 + 1] = ys[i];
  }
  // Bei kollinearen Punkten liefert Delaunator eine leere Triangulation — das ist
  // korrekt (kein Crash). Trotzdem schützen wir gegen einen möglichen Wurf.
  let triangles: Uint32Array;
  try {
    triangles = new Delaunator(coords2d).triangles;
  } catch {
    return { id, type: "terrainMesh", name, positions: [], indices: [] };
  }

  // 3. positions (x,y,z) aufbauen; Z aus zs je Vertex.
  const positions: number[] = new Array(xs.length * 3);
  for (let i = 0; i < xs.length; i++) {
    positions[i * 3] = xs[i];
    positions[i * 3 + 1] = ys[i];
    positions[i * 3 + 2] = zs[i];
  }

  // Degenerierte Dreiecke (Null-Fläche in (x,y)) herausfiltern, damit das TIN
  // keine entarteten Faces enthält.
  const indices: number[] = [];
  const EPS_AREA = 1e-9;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t];
    const b = triangles[t + 1];
    const c = triangles[t + 2];
    const ax = xs[a], ay = ys[a];
    const bx = xs[b], by = ys[b];
    const cx = xs[c], cy = ys[c];
    // doppelte Dreiecksfläche (Kreuzprodukt) in der (x,y)-Ebene.
    const area2 = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
    if (area2 <= EPS_AREA) continue;
    indices.push(a, b, c);
  }

  return { id, type: "terrainMesh", name, positions, indices };
}
