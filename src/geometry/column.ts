// Stützen-Geometrie: leitet aus einer Stütze (Column) ihren Grundriss-Querschnitt
// (Poché-/Footprint-Polygon) ab. Reine Funktion, keine Modell-Mutation — sowohl
// der 2D-Grundriss (generatePlan) als auch die 3D-Extrusion (toWalls3d) und die
// Auswahl-/Transform-Vorschau (transform.ts) nutzen dieselbe Kontur.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Column, Vec2 } from "../model/types";

/** Tessellierungs-Segmentzahl eines runden Stützenprofils (Grundriss + 3D-Prisma). */
export const COLUMN_ROUND_SEGMENTS = 32;

/**
 * Grundriss-Querschnitt einer Stütze als geschlossenes Polygon (Modell-Meter,
 * CCW), um `position` platziert und (bei Rechteck) um `rotation` gedreht. Ein
 * rundes Profil wird als regelmäßiges {@link COLUMN_ROUND_SEGMENTS}-Eck
 * tesselliert; der Schlusspunkt wird NICHT dupliziert.
 */
export function columnFootprint(col: Column): Vec2[] {
  const { x: cx, y: cy } = col.position;
  if (col.profile.kind === "round") {
    const r = col.profile.radius;
    const pts: Vec2[] = [];
    for (let i = 0; i < COLUMN_ROUND_SEGMENTS; i++) {
      const t = (i / COLUMN_ROUND_SEGMENTS) * Math.PI * 2;
      pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
    }
    return pts;
  }
  // Rechteck: lokale Ecken ±w/2 (X) × ±d/2 (Y), um `rotation` gedreht.
  const hw = col.profile.width / 2;
  const hd = col.profile.depth / 2;
  const rot = col.rotation ?? 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const local: Vec2[] = [
    { x: -hw, y: -hd },
    { x: +hw, y: -hd },
    { x: +hw, y: +hd },
    { x: -hw, y: +hd },
  ];
  return local.map((p) => ({
    x: cx + p.x * cos - p.y * sin,
    y: cy + p.x * sin + p.y * cos,
  }));
}
