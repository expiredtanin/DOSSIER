// Kanten-Griffe (je Seite ein Anfasser mit Aussennormale) eines gewählten Elements — reine
// Geometrie, ausgelagert aus `useGripEditing.ts`.

import { leftNormal, normalize, scale, sub } from "../model/geometry";
import type { Drawing2DGeom, EdgeGrip, Vec2 } from "../model/types";

type Owner = { drawingId?: string; wallId?: string };

/** Geschlossener Ring aus Vertices → Kanten-Griffe mit Aussennormale (vom Eckpunkt-Mittel weg). */
export function ringEdges(verts: Vec2[], owner: Owner): EdgeGrip[] {
  const n = verts.length;
  if (n < 3) return [];
  // Schwerpunkt (Mittel der Eckpunkte) als Innenbezug.
  let cx = 0, cy = 0;
  for (const v of verts) { cx += v.x; cy += v.y; }
  const centroid: Vec2 = { x: cx / n, y: cy / n };
  const out: EdgeGrip[] = [];
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const mid: Vec2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let nrm = normalize(leftNormal(sub(b, a)));
    // Nach aussen orientieren: Normale soll von centroid → mid weisen.
    const outward = sub(mid, centroid);
    if (nrm.x * outward.x + nrm.y * outward.y < 0) nrm = scale(nrm, -1);
    out.push({ mid, normal: nrm, aIndex: i, bIndex: (i + 1) % n, owner });
  }
  return out;
}

/**
 * Offene Kette (Linie/offene Polylinie) → ein Griff je Segment, OHNE Schlusskante. `normal` dient
 * nur der Darstellung (leftNormal der Kante); die Bewegung ist frei (`free: true`).
 */
export function openEdges(verts: Vec2[], owner: Owner): EdgeGrip[] {
  const n = verts.length;
  if (n < 2) return [];
  const out: EdgeGrip[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = verts[i];
    const b = verts[i + 1];
    const mid: Vec2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const nrm = normalize(leftNormal(sub(b, a)));
    out.push({ mid, normal: nrm, aIndex: i, bIndex: i + 1, free: true, owner });
  }
  return out;
}

/**
 * Kanten-Griffe einer Polylinie: nur über die Eckpunkte (`drawingVertices` hängt dahinter je
 * Segment einen Bogen-Mitten-Griff an — liefen die Kanten auch über diese, sassen Dreiecke quer im
 * Innern, Fund 29.10.) und nur an geraden Segmenten: ein Bogen hat seinen Bogen-Mitten-Griff, die
 * Sehnen-Mitte läge neben der Linie.
 */
export function polylineEdgeGrips(g: Extract<Drawing2DGeom, { shape: "polyline" }>, owner: Owner): EdgeGrip[] {
  const all = g.closed ? ringEdges(g.pts, owner) : openEdges(g.pts, owner);
  return all.filter((e) => Math.abs(g.bulge?.[e.aIndex] ?? 0) <= 1e-9);
}
