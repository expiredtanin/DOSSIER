// Fang-Geometrie abgeleiteter Blätter (Schnitt/Ansicht). Deren Linien entstehen
// erst in der Ansicht (Schnitt-Extraktor bzw. Ansichts-Generator) und stehen
// NICHT im Projekt — `computeSnap` kennt sonst nur Projekt-Elemente der Ebene
// (im Schnitt also nur die 2D-Zeichnungen), man konnte an keine Schnitt- oder
// Ansichtskante fangen. Die Ansicht legt ihre Strecken hier je Ebenen-ID ab,
// `computeSnap` liest sie für die aktive Ebene mit.

import type { Vec2 } from "../model/types";
import type { Primitive } from "../plan/generatePlan";

export type SnapSeg = [Vec2, Vec2];

const byLevel = new Map<string, SnapSeg[]>();
/** Je Ebene: Umriss-Polygone je Bauteil (`wall:<id>` / `ceiling:<id>`) — Vorschau beim Ziehen im Schnitt. */
const outlinesByLevel = new Map<string, Map<string, Vec2[][]>>();

/** Strecken der Ebene `levelId` setzen (leeres Array/`null` = entfernen). */
export function setSheetSnapSegments(levelId: string, segs: SnapSeg[] | null): void {
  if (!segs || segs.length === 0) byLevel.delete(levelId);
  else byLevel.set(levelId, segs);
}

/** Strecken der Ebene `levelId` (leer, wenn keine abgeleitete Ansicht). */
export function sheetSnapSegments(levelId: string): readonly SnapSeg[] {
  return byLevel.get(levelId) ?? [];
}

const KEY_EPS = 1e-6;
const keyOf = (a: Vec2, b: Vec2): string => {
  const r = (v: number) => Math.round(v / KEY_EPS);
  const ka = `${r(a.x)},${r(a.y)}`;
  const kb = `${r(b.x)},${r(b.y)}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

/**
 * Fangstrecken aus Plan-Primitiven: Polygon-Kanten + Linien (ohne
 * Schraffur-Musterlinien, die gar nicht als Primitive existieren). Doppelte
 * Kanten (benachbarte Schicht-Bänder teilen ihre Fugen) fallen weg.
 */
export function snapSegmentsFromPrimitives(prims: readonly Primitive[]): SnapSeg[] {
  const out: SnapSeg[] = [];
  const seen = new Set<string>();
  const push = (a: Vec2, b: Vec2) => {
    if (Math.abs(a.x - b.x) < KEY_EPS && Math.abs(a.y - b.y) < KEY_EPS) return;
    const k = keyOf(a, b);
    if (seen.has(k)) return;
    seen.add(k);
    out.push([a, b]);
  };
  for (const p of prims) {
    if (p.kind === "polygon") {
      const n = p.pts.length;
      for (let i = 0; i < n; i++) push(p.pts[i], p.pts[(i + 1) % n]);
    } else if (p.kind === "line") {
      push(p.a, p.b);
    }
  }
  return out;
}

/** Bauteil-Art, deren Schnittflächen im Blatt gezogen werden können. */
export type SheetOwnerKind = "wall" | "ceiling" | "opening";

/**
 * Schnittflächen der Ebene `levelId` je Quell-Bauteil ablegen (aus den Plan-
 * Primitiven: `wallId`/`ceilingId` an Polygonen). `null` = entfernen.
 */
export function setSheetOwnerOutlines(levelId: string, prims: readonly Primitive[] | null): void {
  if (!prims) {
    outlinesByLevel.delete(levelId);
    return;
  }
  const map = new Map<string, Vec2[][]>();
  const add = (key: string, pts: Vec2[]) => {
    const list = map.get(key);
    if (list) list.push(pts);
    else map.set(key, [pts]);
  };
  for (const p of prims) {
    if (p.kind !== "polygon") continue;
    if (p.openingId) add(`opening:${p.openingId}`, p.pts);
    else if (p.wallId) add(`wall:${p.wallId}`, p.pts);
    else if (p.ceilingId) add(`ceiling:${p.ceilingId}`, p.pts);
  }
  outlinesByLevel.set(levelId, map);
}

/** Schnittflächen eines Bauteils im Blatt der Ebene `levelId` (leer, wenn nicht geschnitten). */
export function sheetOwnerOutlines(levelId: string, kind: SheetOwnerKind, id: string): readonly Vec2[][] {
  return outlinesByLevel.get(levelId)?.get(`${kind}:${id}`) ?? [];
}
