// Griff-Geometrie eines 2D-Elements — gemeinsam genutzt von BEIDEN 3D-Sichten
// (ThreeViewport3D UND Wasm3DViewport), deshalb ein eigenes, neutrales Modul
// statt einer Definition in einer der beiden Viewport-Dateien (die sich sonst
// gegenseitig importieren müssten — Viewport3D.tsx rendert Wasm3DViewport,
// ein Re-Import in die Gegenrichtung wäre ein zyklischer Import).

import type { Drawing2D, Vec2 } from "../model/types";

/**
 * Editierbare Eckpunkte eines 2D-Elements für die 3D-Vertex-Griffe — in genau
 * derselben Reihenfolge/Indizierung wie `drawingVertices`/`moveGripOf` im
 * Store, damit ein gezogener Griff den richtigen Vertex mutiert. line/polyline/
 * rect liefern Punkte; andere Formen (circle/arc/text) → keine Vertex-Griffe.
 */
export function drawingGripVertices(d: Drawing2D): Vec2[] {
  const g = d.geom;
  if (g.shape === "line") return [g.a, g.b];
  if (g.shape === "polyline") return [...g.pts];
  if (g.shape === "rect" || g.shape === "image") {
    return [
      g.min,
      { x: g.max.x, y: g.min.y },
      g.max,
      { x: g.min.x, y: g.max.y },
    ];
  }
  if (g.shape === "bezier" || g.shape === "spline" || g.shape === "dimension") return [...g.pts];
  return [];
}

/**
 * Ankerpunkt für den Verschiebe-Griff eines 2D-Elements (Schwerpunkt der
 * Vertex-Griffe). Formen ohne Vertex-Griffe (circle/arc/text) liefern ihren
 * Geometrie-Ursprung (Mittelpunkt bzw. Textanker), damit auch sie einen
 * Verschiebe-Griff bekommen. null, wenn kein sinnvoller Anker existiert.
 */
export function drawingMoveAnchor(d: Drawing2D, verts: Vec2[]): Vec2 | null {
  if (verts.length > 0) {
    let sx = 0;
    let sy = 0;
    for (const v of verts) {
      sx += v.x;
      sy += v.y;
    }
    return { x: sx / verts.length, y: sy / verts.length };
  }
  const g = d.geom;
  if (g.shape === "circle" || g.shape === "arc" || g.shape === "ellipse") return g.center;
  if (g.shape === "text" || g.shape === "kote" || g.shape === "detailref" || g.shape === "scalebar" || g.shape === "pointmarker") return g.at;
  if (g.shape === "grid") return g.origin;
  return null;
}
