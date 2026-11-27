// 3D-Griffe für Treppen, Wandöffnungen und Stützen ([333]): reine Lagen-Berechnung (Welt-Koordinaten
// x, Höhe, y) und Arbeitsebene je Griff. Die Griff-Punkte selbst und die Änderungen rechnet der Kern
// (`stairParamPoints`/`stairMoveHandle`, `columnGripPoints`, `openingGripPoint`; Anfragen `stairBy`,
// `stairParam`, `columnGrip`, `openingSlide`) — hier nur die Höhe, auf der der Griff sitzt.

import type { Column, Opening, Project, Stair, Vec2, Wall } from "../model/types";
import { columnGripPoints, openingGripPoint, stairMoveHandle, stairParamPoints, verticalExtents } from "../core";
import type { Vec3 } from "../core";

/** Ziel eines Element-Griffs (genau eines gesetzt). */
export interface ElemGripTarget {
  stairId?: string;
  openingId?: string;
  columnId?: string;
}

/** Ein Element-Griff: `index` = Griff-Index der Anfrage (Treppe: 0 = Bewegpunkt, n = Parameter n−1). */
export interface ElemGrip {
  kind: "move" | "vertex";
  target: ElemGripTarget;
  index: number;
  pos: Vec3;
  /** Arbeitsebene (Höhe, Welt-y), auf der der Griff gezogen wird. */
  planeY: number;
}

/** Geschoss-OK (m), 0 ohne Angabe. */
function floorBaseZ(project: Project, floorId: string): number {
  const z = project.drawingLevels.find((l) => l.id === floorId)?.baseElevation;
  return typeof z === "number" && Number.isFinite(z) ? z : 0;
}

/** Höhe einer vertikalen Bindung; ohne Bindung `fallback`. */
function anchorZ(project: Project, a: Column["bottom"], fallback: number): number {
  if (!a) return fallback;
  return a.mode === "custom" ? a.z : floorBaseZ(project, a.floorId) + (a.offset ?? 0);
}

/** Unterkante (absolutes Z) einer Stütze. */
export function columnBottomZ(project: Project, c: Column): number {
  return anchorZ(project, c.bottom, floorBaseZ(project, c.floorId));
}

/** Oberkante (absolutes Z) einer Stütze. */
export function columnTopZ(project: Project, c: Column): number {
  return anchorZ(project, c.top, columnBottomZ(project, c) + c.height);
}

/** Brüstungshöhe (absolutes Z) einer Wandöffnung: Wand-UK + `sillHeight`. */
export function openingSillZ(project: Project, op: Opening, wall: Wall): number {
  return verticalExtents(project, [wall]).walls[0].zBottom + (op.sillHeight ?? 0);
}

const world = (p: Vec2, y: number): Vec3 => [p.x, y, p.y];

/**
 * Griffe der gewählten Treppen, Wandöffnungen und Stützen. Gesperrte Elemente (`locked`) haben keine.
 * Treppe: Bewegpunkt + Parameter-Griffe auf der Antrittsebene; Öffnung: ein Gleit-Griff auf Brüstungshöhe;
 * Stütze: Mitte (verschieben) knapp über der Oberkante, Ecken/Radius/Dreh-Griff auf der Oberkante.
 */
export function elementGrips3d(project: Project, stairs: readonly Stair[], openings: readonly Opening[], columns: readonly Column[]): ElemGrip[] {
  const out: ElemGrip[] = [];
  for (const st of stairs) {
    if (st.locked) continue;
    const y = floorBaseZ(project, st.floorId) + 0.05;
    const target = { stairId: st.id };
    out.push({ kind: "move", target, index: 0, pos: world(stairMoveHandle(st), y), planeY: y });
    stairParamPoints(st).forEach((p, i) => out.push({ kind: "vertex", target, index: i + 1, pos: world(p, y), planeY: y }));
  }
  for (const op of openings) {
    if (op.locked || op.hostRoofId || op.hostCeilingId) continue;
    const w = project.walls.find((x) => x.id === op.hostWallId);
    if (!w) continue;
    const y = openingSillZ(project, op, w) + 0.05;
    out.push({ kind: "move", target: { openingId: op.id }, index: 0, pos: world(openingGripPoint(w, op), y), planeY: y });
  }
  for (const c of columns) {
    if (c.locked) continue;
    const top = columnTopZ(project, c);
    const target = { columnId: c.id };
    columnGripPoints(c).forEach((p, i) => {
      const y = top + (i === 0 ? 0.25 : 0.02);
      out.push({ kind: i === 0 ? "move" : "vertex", target, index: i, pos: world(p, y), planeY: y });
    });
  }
  return out;
}

/** Höhenversatz der Explosionsaxonometrie ([65]) eines Element-Griffs (Geschoss des Elements). */
export function elemExplodeDz(project: Project, offsets: Readonly<Record<string, number>>, target: ElemGripTarget): number {
  let floorId: string | undefined;
  if (target.stairId) floorId = project.stairs?.find((s) => s.id === target.stairId)?.floorId;
  else if (target.columnId) floorId = project.columns?.find((c) => c.id === target.columnId)?.floorId;
  else if (target.openingId) {
    const op = project.openings?.find((o) => o.id === target.openingId);
    floorId = project.walls.find((w) => w.id === op?.hostWallId)?.floorId;
  }
  return (floorId && offsets[floorId]) || 0;
}
