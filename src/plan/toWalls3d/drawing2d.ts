// Freie-2D-Geometrie-Domäne der 3D-Ableitung: zeigt jede 2D-Zeichnung
// (line/polyline/rect) als dünnes Boden-Ribbon-Mesh knapp über ihrer
// Geschossebene — die "2D-Referenz im 3D", die der drei.js-Fallback
// (`addDrawing2DLines` in Viewport3D.tsx) zeigt.

import type { Drawing2D, Project, Vec2 } from "../../model/types";
import { flattenCategories, getFloor } from "../../model/types";
import { DRAWING_LINE_FALLBACK_RGB, hexToRgb, type RMesh, type RRgb } from "./shared";

/** Halbe Linienbreite der 2D-Boden-Spuren im 3D (Meter) — liest sich als dünne Linie. */
const DRAWING_LINE_HALF_WIDTH = 0.008;
/** Höhen-Offset über der Geschossebene gegen Z-Fighting (wie addDrawing2DLines in Viewport3D.tsx). */
const DRAWING_LINE_ELEVATION_EPS = 0.01;

/**
 * Strecken eines 2D-Zeichenelements für die Boden-Spur im 3D — exakt dieselbe
 * Teilmenge wie `drawing2DSegments` im drei.js-Fallback (`Viewport3D.tsx`):
 * line/polyline/rect. Kreis/Bogen/Text bleiben aussen vor (keine neue
 * Fähigkeit gegenüber dem Fallback, nur Parität).
 */
function drawingSegments3d(d: Drawing2D): [Vec2, Vec2][] {
  const g = d.geom;
  const out: [Vec2, Vec2][] = [];
  if (g.shape === "line") out.push([g.a, g.b]);
  else if (g.shape === "polyline") {
    for (let i = 0; i < g.pts.length - 1; i++) out.push([g.pts[i], g.pts[i + 1]]);
    if (g.closed && g.pts.length > 2) out.push([g.pts[g.pts.length - 1], g.pts[0]]);
  } else if (g.shape === "rect") {
    const c1 = g.min, c3 = g.max;
    const c2 = { x: g.max.x, y: g.min.y }, c4 = { x: g.min.x, y: g.max.y };
    out.push([c1, c2], [c2, c3], [c3, c4], [c4, c1]);
  }
  return out;
}

/** Modellfarbe einer 2D-Zeichnung (color → LineStyle → Kategorie), analog `drawing2DColor`. */
function drawingColor3d(project: Project, d: Drawing2D): RRgb {
  if (d.color) return hexToRgb(d.color, DRAWING_LINE_FALLBACK_RGB);
  const ls = d.lineStyleId ? project.lineStyles.find((l) => l.id === d.lineStyleId) : undefined;
  if (ls?.color) return hexToRgb(ls.color, DRAWING_LINE_FALLBACK_RGB);
  const cat = flattenCategories(project.layers).find((c) => c.code === d.categoryCode);
  return cat?.color ? hexToRgb(cat.color, DRAWING_LINE_FALLBACK_RGB) : DRAWING_LINE_FALLBACK_RGB;
}

/**
 * Emittiert je 2D-Zeichnung ein dünnes Ribbon-Mesh knapp über ihrer
 * Geschossebene — die "2D-Referenz im 3D" (z. B. ein Boden-Raster), die der
 * drei.js-Fallback (`addDrawing2DLines`) zeigt, bisher aber im nativen
 * render3d/wgpu-Pfad fehlte (`RModel3d` kannte nur walls/slabs/meshes).
 * `positions` in MODELL-Metern (x, y, z=Höhe) wie `emitOpeningGlass`; render3d
 * rendert Kontext-Meshes ohnehin doppelseitig (`append_context_mesh`), daher
 * genügt ein flaches Ribbon (kein Quader) pro Strecke.
 */
export function emitDrawingLines(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const d of project.drawings2d) {
    const segs = drawingSegments3d(d);
    if (segs.length === 0) continue;
    let baseZ = 0;
    try {
      baseZ = getFloor(project, d.levelId).baseElevation ?? 0;
    } catch {
      // Geschoss nicht (mehr) auflösbar: bei UK 0 zeichnen (Fallback).
    }
    const elev = baseZ + DRAWING_LINE_ELEVATION_EPS;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const [a, b] of segs) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const nx = (-dy / len) * DRAWING_LINE_HALF_WIDTH;
      const ny = (dx / len) * DRAWING_LINE_HALF_WIDTH;
      const base = positions.length / 3;
      positions.push(
        a.x + nx, a.y + ny, elev,
        a.x - nx, a.y - ny, elev,
        b.x - nx, b.y - ny, elev,
        b.x + nx, b.y + ny, elev,
      );
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    if (positions.length === 0) continue;
    out.push({ positions, indices, kind: "imported", color: drawingColor3d(project, d) });
  }
  return out;
}
