// Transformations-System (Bewegen/Spiegeln/Drehen) auf der Auswahl, im Stil von
// Vectorworks: Geste „Basispunkt → Ziel", Live-Vorschau, und eine Modusleiste
// U/I/O/P, die die Vervielfältigung steuert:
//   U move       — nur das Original transformieren.
//   I copy       — Original bleibt + eine transformierte Kopie.
//   O array      — Original bleibt + N Kopien, je um den vollen Schritt versetzt.
//   P distribute — Original bleibt + N Kopien gleichmäßig zwischen Original und Ziel.
//
// Bezeichner englisch, UI-Text via t() (CONVENTIONS.md). Reine Funktionen + Geometrie;
// die App hält den State und wendet `commitTransform` immutabel an.

import type {
  Column,
  Drawing2D,
  Drawing2DGeom,
  ExtrudedSolid,
  Project,
  Vec2,
  Wall,
} from "../model/types";
import { wallTypeThickness } from "../model/types";
import { wallCorners } from "../model/geometry";
import { columnFootprint } from "../geometry/column";
import type { DraftShape } from "./types";
import { uniqueId } from "./types";

export type TransformOp = "move" | "rotate" | "mirror";
export type CopyMode = "move" | "copy" | "array" | "distribute"; // U / I / O / P

/** Welche Auswahl transformiert wird. */
export interface TransformSelection {
  wallIds: string[];
  drawingId: string | null;
  /** Gewählter extrudierter Körper (truck-Integration); nur move.ts setzt ihn. */
  extrudedSolidId?: string | null;
  /** Gewählte Stütze (Tragwerk); von move/copy/mirror gesetzt. */
  columnId?: string | null;
}

/** Wie viele Klickpunkte die Operation braucht (Drehen = 3, sonst 2). */
export const requiredPoints = (op: TransformOp): number => (op === "rotate" ? 3 : 2);

/**
 * Punkt-Transformation einer Operation bei „Anteil" t (0..1 oder Vielfache):
 *  • move   — Verschiebung um t·Vektor (pts[0]→pts[1]).
 *  • rotate — Drehung um pts[0] um t·(Winkel(pts[2]) − Winkel(pts[1])).
 *  • mirror — Spiegelung an der Achse pts[0]→pts[1] (t wird ignoriert).
 */
export function transformFn(op: TransformOp, pts: Vec2[], t: number): (p: Vec2) => Vec2 {
  if (op === "move") {
    const vx = (pts[1].x - pts[0].x) * t;
    const vy = (pts[1].y - pts[0].y) * t;
    return (p) => ({ x: p.x + vx, y: p.y + vy });
  }
  if (op === "rotate") {
    const c = pts[0];
    const a0 = Math.atan2(pts[1].y - c.y, pts[1].x - c.x);
    const a1 = Math.atan2(pts[2].y - c.y, pts[2].x - c.x);
    const ang = (a1 - a0) * t;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    return (p) => {
      const dx = p.x - c.x, dy = p.y - c.y;
      return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
    };
  }
  // mirror: Spiegelung an der Geraden pts[0]→pts[1].
  const a = pts[0], b = pts[1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  return (p) => {
    // Projektion von p auf die Achse, dann gespiegelt.
    const tt = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    const fx = a.x + dx * tt, fy = a.y + dy * tt;
    return { x: 2 * fx - p.x, y: 2 * fy - p.y };
  };
}

/**
 * Die „Anteile" t der KOPIEN (ohne Original) je Modus. Beim Spiegeln ergeben
 * Array/Verteilen keine Reihe (Spiegelung ist selbstinvers) → genau eine Kopie.
 */
export function copyTs(op: TransformOp, mode: CopyMode, count: number): number[] {
  if (mode === "move") return [];
  if (op === "mirror") return [1]; // copy/array/distribute → eine gespiegelte Kopie
  if (mode === "copy") return [1];
  const n = Math.max(1, Math.floor(count));
  if (mode === "array") return Array.from({ length: n }, (_, k) => k + 1);
  // distribute: n Kopien gleichmäßig zwischen Original (0) und Ziel (1).
  return Array.from({ length: n }, (_, k) => (k + 1) / n);
}

/** Wird beim Modus „move" (U) das Original selbst transformiert? */
export const movesOriginal = (mode: CopyMode): boolean => mode === "move";

// ── Geometrie einer Auswahl ─────────────────────────────────────────────────

interface SelItem {
  kind: "wall";
  wall: Wall;
}
interface SelDrawingItem {
  kind: "drawing";
  drawing: Drawing2D;
}
interface SelExtrudedItem {
  kind: "extrudedSolid";
  solid: ExtrudedSolid;
}
interface SelColumnItem {
  kind: "column";
  column: Column;
}
type AnyItem = SelItem | SelDrawingItem | SelExtrudedItem | SelColumnItem;

function gatherItems(project: Project, sel: TransformSelection): AnyItem[] {
  const items: AnyItem[] = [];
  const ids = new Set(sel.wallIds);
  for (const w of project.walls) if (ids.has(w.id)) items.push({ kind: "wall", wall: w });
  if (sel.drawingId) {
    const d = project.drawings2d.find((x) => x.id === sel.drawingId);
    if (d) items.push({ kind: "drawing", drawing: d });
  }
  if (sel.extrudedSolidId) {
    const s = (project.extrudedSolids ?? []).find((x) => x.id === sel.extrudedSolidId);
    if (s) items.push({ kind: "extrudedSolid", solid: s });
  }
  if (sel.columnId) {
    const c = (project.columns ?? []).find((x) => x.id === sel.columnId);
    if (c) items.push({ kind: "column", column: c });
  }
  return items;
}

/**
 * Transformiert eine Stütze unter einer affinen Punkt-Abbildung `fn`
 * (Verschiebung/Drehung/Spiegelung): der Einfügepunkt wandert mit; die Profil-
 * Drehung folgt der Abbildung, indem ein Richtungsvektor (Länge 1 unter dem
 * aktuellen Winkel) mit-transformiert und der neue Winkel daraus gemessen wird
 * — das ergibt für alle drei Operationen die korrekte neue Ausrichtung.
 */
function mvColumn(col: Column, fn: (p: Vec2) => Vec2): Column {
  const base = col.position;
  const rot = col.rotation ?? 0;
  const tip = { x: base.x + Math.cos(rot), y: base.y + Math.sin(rot) };
  const nb = fn(base);
  const nt = fn(tip);
  return { ...col, position: nb, rotation: Math.atan2(nt.y - nb.y, nt.x - nb.x) };
}

const mvGeom = (geom: Drawing2DGeom, fn: (p: Vec2) => Vec2): Drawing2DGeom => {
  switch (geom.shape) {
    case "line":
      return { ...geom, a: fn(geom.a), b: fn(geom.b) };
    case "polyline":
      return { ...geom, pts: geom.pts.map(fn) };
    case "rect": {
      // Achsparallel nur bei reiner Verschiebung erhaltbar; sonst → Polylinie.
      const c = [
        geom.min,
        { x: geom.max.x, y: geom.min.y },
        geom.max,
        { x: geom.min.x, y: geom.max.y },
      ].map(fn);
      const axisAligned =
        Math.abs(c[0].y - c[1].y) < 1e-6 &&
        Math.abs(c[1].x - c[2].x) < 1e-6 &&
        Math.abs(c[2].y - c[3].y) < 1e-6;
      if (axisAligned) {
        const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
        return {
          shape: "rect",
          min: { x: Math.min(...xs), y: Math.min(...ys) },
          max: { x: Math.max(...xs), y: Math.max(...ys) },
        };
      }
      return { shape: "polyline", pts: c, closed: true };
    }
    case "circle":
      return { ...geom, center: fn(geom.center) };
    case "arc":
      return { ...geom, center: fn(geom.center) };
    case "ellipse":
      return { ...geom, center: fn(geom.center) };
    case "bezier":
      return { ...geom, pts: geom.pts.map(fn) };
    case "spline":
      return { ...geom, pts: geom.pts.map(fn) };
    case "text":
      return { ...geom, at: fn(geom.at) };
    case "image": {
      // Wie Text: nur die Position folgt der Transformation (Zentrum wandert
      // dorthin, wo `fn` es abbildet); die Box bleibt achsparallel/unverzerrt —
      // ein Bild kann nicht geschert/rotiert dargestellt werden (kein `angle`-Feld).
      const oldCenter = { x: (geom.min.x + geom.max.x) / 2, y: (geom.min.y + geom.max.y) / 2 };
      const newCenter = fn(oldCenter);
      const dx = newCenter.x - oldCenter.x;
      const dy = newCenter.y - oldCenter.y;
      return {
        ...geom,
        min: { x: geom.min.x + dx, y: geom.min.y + dy },
        max: { x: geom.max.x + dx, y: geom.max.y + dy },
      };
    }
  }
};

/** Vorschau-Formen für ein Element unter der Punkt-Transformation `fn`. */
function itemPreview(project: Project, item: AnyItem, fn: (p: Vec2) => Vec2): DraftShape[] {
  if (item.kind === "wall") {
    const w = item.wall;
    const wt = project.wallTypes.find((t) => t.id === w.wallTypeId);
    const th = wt ? wallTypeThickness(wt) : 0.2;
    const a = fn(w.start), b = fn(w.end);
    return [
      { kind: "poly", pts: wallCorners(a, b, th), closed: true },
      { kind: "line", a, b },
    ];
  }
  if (item.kind === "extrudedSolid") {
    return [{ kind: "poly", pts: item.solid.points.map(fn), closed: true }];
  }
  if (item.kind === "column") {
    return [{ kind: "poly", pts: columnFootprint(item.column).map(fn), closed: true }];
  }
  const g = mvGeom(item.drawing.geom, fn);
  switch (g.shape) {
    case "line":
      return [{ kind: "line", a: g.a, b: g.b }];
    case "polyline": {
      const out: DraftShape[] = [];
      for (let i = 0; i < g.pts.length - 1; i++) out.push({ kind: "line", a: g.pts[i], b: g.pts[i + 1] });
      if (g.closed && g.pts.length > 2) out.push({ kind: "line", a: g.pts[g.pts.length - 1], b: g.pts[0] });
      return out;
    }
    case "rect":
    case "image":
      return [{ kind: "poly", pts: [g.min, { x: g.max.x, y: g.min.y }, g.max, { x: g.min.x, y: g.max.y }], closed: true }];
    default:
      return [];
  }
}

/**
 * Vorschau aller transformierten Instanzen (bewegtes Original bei U + alle
 * Kopien). `pts` sind die bisher gesetzten Punkte inkl. Cursor (Länge =
 * requiredPoints). Liefert die Stütz-/Basis-Punkte separat für Marker.
 */
export function transformPreview(
  project: Project,
  sel: TransformSelection,
  op: TransformOp,
  pts: Vec2[],
  mode: CopyMode,
  count: number,
): DraftShape[] {
  const items = gatherItems(project, sel);
  const shapes: DraftShape[] = [];
  const instances: number[] = [...copyTs(op, mode, count)];
  if (movesOriginal(mode)) instances.push(1); // U: Original an Endlage zeigen
  for (const t of instances) {
    const fn = transformFn(op, pts, t);
    for (const item of items) shapes.push(...itemPreview(project, item, fn));
  }
  return shapes;
}

// ── Commit ───────────────────────────────────────────────────────────────────

/** Wendet die Transformation immutabel auf das Projekt an (Original + Kopien). */
export function commitTransform(
  project: Project,
  sel: TransformSelection,
  op: TransformOp,
  pts: Vec2[],
  mode: CopyMode,
  count: number,
): Project {
  const items = gatherItems(project, sel);
  if (items.length === 0) return project;
  const wallIds = new Set(sel.wallIds);

  let walls = project.walls;
  let drawings2d = project.drawings2d;
  let extrudedSolids = project.extrudedSolids ?? [];
  let columns = project.columns ?? [];

  // U (move): Original an die Endlage (t=1) transformieren.
  if (movesOriginal(mode)) {
    const fn = transformFn(op, pts, 1);
    walls = walls.map((w) => (wallIds.has(w.id) ? { ...w, start: fn(w.start), end: fn(w.end) } : w));
    if (sel.drawingId) {
      drawings2d = drawings2d.map((d) =>
        d.id === sel.drawingId ? { ...d, geom: mvGeom(d.geom, fn) } : d,
      );
    }
    if (sel.extrudedSolidId) {
      extrudedSolids = extrudedSolids.map((s) =>
        s.id === sel.extrudedSolidId
          ? {
              ...s,
              points: s.points.map(fn),
              circle: s.circle ? { ...s.circle, center: fn(s.circle.center) } : undefined,
            }
          : s,
      );
    }
    if (sel.columnId) {
      columns = columns.map((c) => (c.id === sel.columnId ? mvColumn(c, fn) : c));
    }
  }

  // Kopien anhängen (I/O/P bzw. mirror copy).
  const newWalls: Wall[] = [];
  const newDrawings: Drawing2D[] = [];
  const newSolids: ExtrudedSolid[] = [];
  const newColumns: Column[] = [];
  for (const t of copyTs(op, mode, count)) {
    const fn = transformFn(op, pts, t);
    for (const item of items) {
      if (item.kind === "wall") {
        const w = item.wall;
        newWalls.push({ ...w, id: uniqueId("W"), start: fn(w.start), end: fn(w.end) });
      } else if (item.kind === "drawing") {
        const d = item.drawing;
        newDrawings.push({ ...d, id: uniqueId("dr2d"), geom: mvGeom(d.geom, fn) });
      } else if (item.kind === "column") {
        newColumns.push({ ...mvColumn(item.column, fn), id: uniqueId("column") });
      } else {
        const s = item.solid;
        newSolids.push({
          ...s,
          id: uniqueId("extrude"),
          points: s.points.map(fn),
          circle: s.circle ? { ...s.circle, center: fn(s.circle.center) } : undefined,
        });
      }
    }
  }

  return {
    ...project,
    walls: newWalls.length ? [...walls, ...newWalls] : walls,
    drawings2d: newDrawings.length ? [...drawings2d, ...newDrawings] : drawings2d,
    extrudedSolids: newSolids.length ? [...extrudedSolids, ...newSolids] : extrudedSolids,
    columns: newColumns.length ? [...columns, ...newColumns] : columns,
  };
}
