// Griff-Zug-Rechnung ([128]): dünne Fassade über den Rust-Kern (`src-tauri/core/src/grip_drag.rs`,
// Bindungen `web/grip_drag.rs`). Wohin ein gezogener Griff fällt (Länge/Winkel-Felder, Shift-Achsen-Lock,
// Kanten-Griffe, Höhen-Griffe im Schnitt, Öffnung entlang der Wand, koinzidente Ecken) rechnet der Kern;
// `state/useGripEditing.ts` hält nur Zustand und Vorschau.

import type { EdgeGrip, Excavation, Opening, Stair, Vec2, Wall } from "../model/types";
import { core } from "../engine/coreWasm";
import { encodeStair } from "./stair";

const v = (f: ArrayLike<number>, i = 0): Vec2 => ({ x: f[i], y: f[i + 1] });

function flat(pts: readonly Vec2[]): Float64Array {
  const f = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    f[2 * i] = pts[i].x;
    f[2 * i + 1] = pts[i].y;
  }
  return f;
}

function points(f: ArrayLike<number>): Vec2[] {
  const out: Vec2[] = new Array(f.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = v(f, 2 * i);
  return out;
}

/** Gelockte Länge (m) / Winkel (Grad) des Feld-Controllers; fehlend = folgt dem Cursor. */
export interface GripLocks {
  length?: number;
  angle?: number;
}

/** Länge, Winkel (Grad, [0, 360)) und Abstand entlang `normal` von `anchor` nach `p` (Felder, HUD). */
export function gripPolar(anchor: Vec2, p: Vec2, normal: Vec2 = { x: 0, y: 0 }): { length: number; angleDeg: number; offset: number } {
  const f = core().grip_polar(anchor.x, anchor.y, p.x, p.y, normal.x, normal.y);
  return { length: f[0], angleDeg: f[1], offset: f[2] };
}

/** Punkt aus Anker + gelockter Länge/Winkel; ungelockte Werte folgen dem rohen Cursor `raw`. */
export function gripPolarPoint(anchor: Vec2, locks: GripLocks, raw: Vec2): Vec2 {
  return v(core().grip_polar_point(anchor.x, anchor.y, locks.length ?? NaN, locks.angle ?? NaN, raw.x, raw.y));
}

/**
 * [T2] Endpunkt-Griff einer Bogenwand (`index` 0 = Start, 1 = Ende): Zielpunkt auf dem Kreis (Mittelpunkt und
 * Radius bleiben) und die Bogenlänge der Wand danach. `length` = getippte Bogenlänge ab dem festen Ende,
 * sonst folgt der Punkt dem Cursor `raw`. `null` bei Unsinn.
 */
export function gripArcWallTarget(w: Pick<Wall, "start" | "end" | "bulge">, index: 0 | 1, length: number | undefined, raw: Vec2): { pt: Vec2; arcLength: number } | null {
  const f = core().grip_arc_wall_target(w.start.x, w.start.y, w.end.x, w.end.y, w.bulge ?? 0, index, length ?? NaN, raw.x, raw.y);
  return f.length >= 3 ? { pt: v(f), arcLength: f[2] } : null;
}

/**
 * [T2] Endpunkt-Griff einer Bogenwand: die ganze Wand danach (Start, Ende, Bulge). `arcLength` = getippte Bogenlänge
 * ab dem festen Ende (auch über dem Halbkreis; der Cursor `raw` bestimmt nur die Seite), sonst der auf den Kreis
 * projizierte Cursor. `null` bei Unsinn.
 */
export function gripArcWallResize(w: Pick<Wall, "start" | "end" | "bulge">, index: 0 | 1, arcLength: number | undefined, raw: Vec2): { start: Vec2; end: Vec2; bulge: number } | null {
  const f = core().grip_arc_wall_resize(w.start.x, w.start.y, w.end.x, w.end.y, w.bulge ?? 0, index, arcLength ?? NaN, raw.x, raw.y);
  return f.length >= 5 ? { start: { x: f[0], y: f[1] }, end: { x: f[2], y: f[3] }, bulge: f[4] } : null;
}

/**
 * [T2] Scheitel-Griff einer Bogenwand: Zielpunkt und Radius der Wand danach. `fixedCenter` (Shift) = Radius um den
 * festen Mittelpunkt (Enden wandern radial), sonst Endpunkte fest. `radius` = getippter Radius, sonst folgt der
 * Punkt dem Cursor `raw`. `null` bei Unsinn (z. B. Radius unter der halben Sehne).
 */
export function gripArcWallRadius(w: Pick<Wall, "start" | "end" | "bulge">, fixedCenter: boolean, radius: number | undefined, raw: Vec2): { pt: Vec2; radius: number } | null {
  const f = core().grip_arc_wall_radius(w.start.x, w.start.y, w.end.x, w.end.y, w.bulge ?? 0, fixedCenter, radius ?? NaN, raw.x, raw.y);
  return f.length >= 3 ? { pt: v(f), radius: f[2] } : null;
}

/**
 * Shift-Achsen-Lock eines Punkt-Griffs: Welt-H/V durch den Nachbar-Griff `anchor`, bei einem Vielecks-
 * Eckpunkt (`ring` = Punkte des Elements, `index` darin, `origin` = Lage vor dem Zug) zusätzlich die Flucht
 * der beiden fixen Nachbarkanten. Die nächstliegende Achse gewinnt.
 */
export function gripAxisLock(raw: Vec2, anchor: Vec2, origin: Vec2 | null, ring: readonly Vec2[] | null, index: number, closed: boolean): Vec2 {
  const f = ring && origin ? flat(ring) : new Float64Array();
  return v(core().grip_axis_lock(raw.x, raw.y, anchor.x, anchor.y, origin?.x ?? NaN, origin?.y ?? NaN, f, index, closed));
}

/** Führung eines Kanten-Zugs (s. {@link gripEdgeTarget}). */
export interface EdgeDrive {
  /** Feld-Controller offen: Ziel aus Anker + Locks, ohne Raster/Ortho. */
  locks?: GripLocks | null;
  shift?: boolean;
  /** Rasterweite (0 = aus). */
  grid?: number;
  /** Gefangener Geometrie-Snap (nur geführte Kanten). */
  snapped?: Vec2 | null;
}

/**
 * Zielpunkt eines Kanten-Zugs relativ zum Anker `edge.mid`: geführte Kante nur entlang der Normale
 * (Geometrie-Snap vor Raster), freie Kante (`edge.free`) voller Cursor mit Ortho/Raster.
 */
export function gripEdgeTarget(edge: EdgeGrip, raw: Vec2, d: EdgeDrive = {}): Vec2 {
  const { mid, normal } = edge;
  const l = d.locks;
  const s = d.snapped;
  return v(
    core().grip_edge_target(
      mid.x, mid.y, normal.x, normal.y, !!edge.free, raw.x, raw.y,
      !!l, l?.length ?? NaN, l?.angle ?? NaN, !!d.shift, d.grid ?? 0, s?.x ?? NaN, s?.y ?? NaN,
    ),
  );
}

/** Art eines Höhen-Griffs im Schnitt/in der Ansicht. */
export type SheetHeightKind = "wallTop" | "openingTop" | "openingBottom";

/**
 * Höhen-Griff auf die Blatt-Höhe `y` ziehen (1-cm-Raster, `free` = ohne): neue Ober-/Unterkante im Blatt und
 * der Patch fürs Bauteil (`height`, Fenster-Unterkante zusätzlich `sillHeight`; mm-genau).
 */
export function sheetHeightDrag(
  kind: SheetHeightKind,
  g: { base: number; top: number; bottom: number },
  y: number,
  free: boolean,
): { top: number; bottom: number; patch: Record<string, number> } {
  const k = kind === "wallTop" ? 0 : kind === "openingTop" ? 1 : 2;
  const f = core().grip_sheet_height(k, g.base, g.top, g.bottom, y, free);
  const patch: Record<string, number> = kind === "openingBottom" ? { sillHeight: f[3], height: f[2] } : { height: f[2] };
  return { top: f[0], bottom: f[1], patch };
}

/**
 * Mittelpunkt-Griff einer Öffnung auf der Achse ihrer Wirtswand (Bogenwand [T2]: auf dem Bogen, `position`
 * = Bogenlänge). Den Zug selbst rechnet der Kern (`slideOpening`, Griff-Anfrage `openingSlide`).
 */
export function openingGripPoint(w: Pick<Wall, "start" | "end" | "bulge">, op: Pick<Opening, "position" | "width">): Vec2 {
  return v(core().grip_opening_point(w.start.x, w.start.y, w.end.x, w.end.y, w.bulge ?? 0, op.position, op.width));
}

/**
 * [144] Getippte Länge beim Griff-Zug einer Öffnung in einer Bogenwand: neue `position` = Lage beim Greifen
 * `pos0` ± `length` als BOGENLÄNGE (nicht entlang der Sehne). Richtung aus dem Zielpunkt `pt` des
 * Feld-Controllers relativ zum Bezug `anchor`, gemessen an der Wandrichtung `wallDir`.
 */
export function openingTypedPosition(pos0: number, length: number, anchor: Vec2, pt: Vec2, wallDir: Vec2): number {
  const along = (pt.x - anchor.x) * wallDir.x + (pt.y - anchor.y) * wallDir.y;
  return pos0 + (along < 0 ? -length : length);
}

/**
 * Öffnung im Schnitt-Blatt waagrecht ziehen: Blatt-Delta `du` (gesamt, entlang `uAxis`) → neue `position`
 * und das wirksame Delta (nach dem Klemmen); null, wenn die Wand fast quer zur Schnittlinie steht.
 * Bogenwand ([144]): `position` = Bogenlänge, die Öffnungsmitte folgt dem Delta auf dem Bogen.
 */
export function openingSheetSlide(
  w: Pick<Wall, "start" | "end" | "bulge">,
  op: Pick<Opening, "position" | "width">,
  uAxis: Vec2,
  du: number,
): { position: number; du: number } | null {
  const f = core().grip_opening_slide_sheet(w.start.x, w.start.y, w.end.x, w.end.y, w.bulge ?? 0, uAxis.x, uAxis.y, op.position, op.width, du);
  return f.length ? { position: f[0], du: f[1] } : null;
}

/**
 * Punkt im Umriss lassen (Dach-/Deckenöffnung): ausserhalb → nächster Randpunkt, 5 cm nach innen gerückt.
 * Gerechnet im Kern (`opening_slide::clamp_inside`), derselbe Wert wie beim Verschieben-Befehl.
 */
export function clampInside(pt: Vec2, ring: readonly Vec2[]): Vec2 {
  const flat = new Float64Array(ring.length * 2);
  ring.forEach((q, i) => { flat[2 * i] = q.x; flat[2 * i + 1] = q.y; });
  return v(core().grip_clamp_inside(pt.x, pt.y, flat));
}

/** Bewegpunkt einer Treppe (Mitte des ersten Laufs, Wendeltreppe im Zentrum). */
export function stairMoveHandle(st: Stair): Vec2 {
  const c = st.center;
  return v(core().grip_stair_handle(st.shape === "spiral", c?.x ?? NaN, c?.y ?? NaN, st.start.x, st.start.y, st.dir?.x ?? 0, st.dir?.y ?? 0, st.runLength));
}

/**
 * [151] Parameter-Griffe einer Podesttreppe (L, U, gerade mit Podest): Ende Lauf 1, Ende letzter Lauf, bei
 * U / gerade mit Podest der Podestrand. Andere Formen: keine. Den Zug rechnet der Kern (Griff `stairParam`).
 */
export function stairParamPoints(st: Stair): Vec2[] {
  return points(core().grip_stair_param_points(encodeStair(st)));
}

/** Griffe einer Wand: Start, Ende, bei einer Bogenwand ([T2]) der Bogenscheitel. */
export function wallGripPoints(w: Pick<Wall, "start" | "end" | "bulge">): Vec2[] {
  return points(core().grip_wall_points(w.start.x, w.start.y, w.end.x, w.end.y, w.bulge ?? 0));
}

/** Griff-Punkte einer Baugrube: Umriss-Ecken, dann der Sohlen-Griff (Schwerpunkt, y + Sohlenhöhe). */
export function excavationGripPoints(e: Excavation): Vec2[] {
  return points(core().grip_excavation_points(flat(e.outline), e.bottom));
}

/**
 * Koinzidente Punkte anderer Elemente (`groups`, je Element seine Griff-Punkte) an den Ecken `corners` des
 * verschobenen Elements (Toleranz 5 cm): `{group, index}` je Punkt, ohne Doppel.
 */
export function coincidentGripPoints(corners: readonly Vec2[], groups: readonly (readonly Vec2[])[]): { group: number; index: number }[] {
  if (corners.length === 0 || groups.length === 0) return [];
  const n = groups.reduce((a, g) => a + 1 + 2 * g.length, 0);
  const f = new Float64Array(n);
  let k = 0;
  for (const g of groups) {
    f[k++] = g.length;
    for (const p of g) {
      f[k++] = p.x;
      f[k++] = p.y;
    }
  }
  const r = core().grip_coincident(flat(corners), f);
  const out: { group: number; index: number }[] = [];
  for (let i = 0; i + 1 < r.length; i += 2) out.push({ group: r[i], index: r[i + 1] });
  return out;
}
