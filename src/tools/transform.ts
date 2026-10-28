// Transformations-System (Bewegen/Spiegeln/Drehen) auf der Auswahl, im Stil von
// Vectorworks: Geste „Basispunkt → Ziel", Live-Vorschau, und eine Modusleiste
// U/I/O/P, die die Vervielfältigung steuert:
//   U move       — nur das Original transformieren.
//   I copy       — Original bleibt + eine transformierte Kopie.
//   O array      — Original bleibt + N Kopien, je um den vollen Schritt versetzt.
//   P distribute — Original bleibt + N Kopien gleichmäßig zwischen Original und Ziel.
//
// Bezeichner englisch, UI-Text via t() (CONVENTIONS.md). Reine Funktionen + Geometrie;
// die App hält den State und wendet die Ops aus `transformOps` an ([K4] S3).

import { transformSolid } from "../core";
import type {
  Ceiling,
  Column,
  Drawing2D,
  Drawing2DGeom,
  ExtrudedSolid,
  Project,
  Roof,
  Room,
  Stair,
  Vec2,
  Wall,
} from "../model/types";
import { wallTypeThickness } from "../model/types";
import { wallCorners } from "../model/geometry";
import { columnFootprint } from "../core";
import { stairOutline } from "../core";
import type { DraftShape } from "./types";
import { drawingPreviewShapes } from "./drawingPreview";
import { mvGeom, reversesOrientation, scaleFactor, scaleGeom } from "../core";
import { uniqueId } from "./types";
import type { CommandSelection } from "../commands/types";
import { applyOps } from "../core";
import type { CoreOp } from "../core";
import { addItems, opsMutation, patchItems } from "../core";
import type { ProjectMutation } from "../core";

export type TransformOp = "move" | "rotate" | "mirror" | "scale";
export type CopyMode = "move" | "copy" | "array" | "distribute"; // U / I / O / P

/** Welche Auswahl transformiert wird. */
export interface TransformSelection {
  wallIds: string[];
  /**
   * Einzeln gewähltes 2D-Element (Legacy-Feld, s. `CommandSelection.drawingId`).
   * `drawingIds` (Mehrfachauswahl) wird bevorzugt ausgewertet; beide zusammen
   * ergeben die MENGE der zu transformierenden 2D-Elemente (Union, dedupliziert).
   */
  drawingId: string | null;
  /** ALLE gewählten 2D-Elemente (Mehrfachauswahl) — s. `CommandSelection.drawingIds`. */
  drawingIds?: string[];
  /** Gewählter extrudierter Körper (truck-Integration); nur move.ts setzt ihn. */
  extrudedSolidId?: string | null;
  /** Gewählte Stütze (Tragwerk); von move/copy/mirror gesetzt. */
  columnId?: string | null;
  /** Gewählte Decken (Mehrfachauswahl). */
  ceilingIds?: string[];
  /**
   * Gewählte Dächer (Mehrfachauswahl). Der Umriss ist geometrisch an die
   * Weltachsen gebunden (immer ein Rechteck, First folgt `ridgeAxis` „x"/„y")
   * — Rotate/Mirror würden diese Invariante brechen (First bliebe trotz
   * gedrehtem Umriss achsparallel stehen). `gatherItems` nimmt Dächer daher
   * NUR bei move/scale mit, nicht bei rotate/mirror.
   */
  roofIds?: string[];
  /** Gewählte Treppen (Mehrfachauswahl). */
  stairIds?: string[];
  /** Gewählte Räume (Mehrfachauswahl). */
  roomIds?: string[];
}

/** Auswahl (Befehlskontext) → TransformSelection (gleiche Form, alle Elementarten). */
export function toTransformSel(sel: CommandSelection): TransformSelection {
  return {
    wallIds: sel.wallIds,
    drawingId: sel.drawingId,
    drawingIds: sel.drawingIds,
    extrudedSolidId: sel.extrudedSolidId,
    columnId: sel.columnId,
    ceilingIds: sel.ceilingIds,
    roofIds: sel.roofIds,
    stairIds: sel.stairIds,
    roomIds: sel.roomIds,
  };
}

/** Hat die Auswahl überhaupt etwas Transformierbares? */
export function hasTransformSelection(sel: CommandSelection): boolean {
  return (
    sel.wallIds.length > 0 ||
    sel.drawingId !== null ||
    (sel.drawingIds?.length ?? 0) > 0 ||
    !!sel.extrudedSolidId ||
    !!sel.columnId ||
    (sel.ceilingIds?.length ?? 0) > 0 ||
    (sel.roofIds?.length ?? 0) > 0 ||
    (sel.stairIds?.length ?? 0) > 0 ||
    (sel.roomIds?.length ?? 0) > 0
  );
}

/** Vereinigt `drawingId`/`drawingIds` zu einer eindeutigen ID-Menge (dedupliziert). */
function drawingIdSet(sel: TransformSelection): Set<string> {
  const ids = new Set(sel.drawingIds ?? []);
  if (sel.drawingId) ids.add(sel.drawingId);
  return ids;
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
  if (op === "scale") {
    // Gleichmässige Skalierung um pts[0]; der Faktor ist das Längenverhältnis
    // Referenz→Ziel (getippter Faktor wird vom Befehl in solche Punkte
    // übersetzt). `t` interpoliert für die Vorschau/Reihen-Kopien.
    const c = pts[0];
    const f = scaleFactor(pts, t);
    return (p) => ({ x: c.x + (p.x - c.x) * f, y: c.y + (p.y - c.y) * f });
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
interface SelCeilingItem {
  kind: "ceiling";
  ceiling: Ceiling;
}
interface SelRoofItem {
  kind: "roof";
  roof: Roof;
}
interface SelStairItem {
  kind: "stair";
  stair: Stair;
}
interface SelRoomItem {
  kind: "room";
  room: Room;
}
type AnyItem =
  | SelItem
  | SelDrawingItem
  | SelExtrudedItem
  | SelColumnItem
  | SelCeilingItem
  | SelRoofItem
  | SelStairItem
  | SelRoomItem;

// Dach: s. Doku bei TransformSelection.roofIds — Rotate/Mirror ausgenommen
// (Umriss-Achsen-Invariante). EINZIGE Stelle, die das entscheidet — sowohl
// `gatherItems` als auch der „Original bewegen"-Zweig in `commitTransform`
// (der NICHT über `items` läuft, s. dort) müssen dieselbe Funktion befragen,
// sonst bricht die Ausnahme an einer der beiden Stellen unbemerkt wieder.
function roofTransformAllowed(op: TransformOp): boolean {
  return op !== "rotate" && op !== "mirror";
}

function gatherItems(project: Project, sel: TransformSelection, op: TransformOp): AnyItem[] {
  const items: AnyItem[] = [];
  // Objekt-Sperre (`locked`, s. state/objectLock.ts): gesperrte Elemente
  // bleiben anwählbar, aber move/copy/mirror/rotate/scale/array lassen sie
  // unangetastet — dieselbe Semantik wie beim Griff-Ziehen (moveGrip/
  // moveElementBy in projectSlice.ts).
  const ids = new Set(sel.wallIds);
  for (const w of project.walls) if (ids.has(w.id) && !w.locked) items.push({ kind: "wall", wall: w });
  const drawIds = drawingIdSet(sel);
  for (const d of project.drawings2d)
    if (drawIds.has(d.id) && !d.locked) items.push({ kind: "drawing", drawing: d });
  if (sel.extrudedSolidId) {
    const s = (project.extrudedSolids ?? []).find((x) => x.id === sel.extrudedSolidId);
    if (s) items.push({ kind: "extrudedSolid", solid: s });
  }
  if (sel.columnId) {
    const c = (project.columns ?? []).find((x) => x.id === sel.columnId);
    if (c && !c.locked) items.push({ kind: "column", column: c });
  }
  const ceilingIds = new Set(sel.ceilingIds ?? []);
  for (const c of project.ceilings ?? [])
    if (ceilingIds.has(c.id) && !c.locked) items.push({ kind: "ceiling", ceiling: c });
  if (roofTransformAllowed(op)) {
    const roofIds = new Set(sel.roofIds ?? []);
    for (const r of project.roofs ?? [])
      if (roofIds.has(r.id) && !r.locked) items.push({ kind: "roof", roof: r });
  }
  const stairIds = new Set(sel.stairIds ?? []);
  for (const s of project.stairs ?? [])
    if (stairIds.has(s.id) && !s.locked) items.push({ kind: "stair", stair: s });
  const roomIds = new Set(sel.roomIds ?? []);
  for (const r of project.rooms ?? [])
    if (roomIds.has(r.id) && !r.locked) items.push({ kind: "room", room: r });
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

/** Bildet Umriss + Aussparungen einer Decke unter `fn` ab. */
function mvCeiling(c: Ceiling, fn: (p: Vec2) => Vec2): Ceiling {
  return {
    ...c,
    outline: c.outline.map(fn),
    ...(c.openings ? { openings: c.openings.map((hole) => hole.map(fn)) } : {}),
  };
}

/**
 * Bildet den Umriss eines Dachs unter `fn` ab. NUR für Move/Scale aufgerufen
 * (s. `TransformSelection.roofIds`) — beide erhalten die Rechteck-/Achsen-
 * Invariante des Umrisses, daher genügt reines Punkte-Mapping.
 */
function mvRoof(r: Roof, fn: (p: Vec2) => Vec2): Roof {
  return { ...r, outline: r.outline.map(fn) };
}

/** Bildet Umriss + Stempel-Anker eines Raums unter `fn` ab. */
function mvRoom(r: Room, fn: (p: Vec2) => Vec2): Room {
  return {
    ...r,
    boundary: r.boundary.map(fn),
    ...(r.stampAnchor ? { stampAnchor: fn(r.stampAnchor) } : {}),
  };
}

/**
 * Transformiert eine Treppe unter `fn` (Skalierungsfaktor `f`, wie bei
 * {@link scaleGeom}): Antritt (+ Wendel-Zentrum) wandert mit; die Laufrichtung
 * folgt wie bei {@link mvColumn} über einen mit-transformierten Richtungs-
 * punkt. `turn` (L-Treppe) und `sweep` (Wendel) sind umlaufsinn-abhängig und
 * kippen daher unter einer Spiegelung ({@link reversesOrientation}), bleiben
 * aber unter Drehung/Verschiebung/Skalierung unverändert. Lauflänge/-breite/
 * Radius skalieren mit `f`; `totalRise` (eine Gebäudehöhe, Z) bleibt unberührt.
 */
function mvStair(s: Stair, fn: (p: Vec2) => Vec2, f: number): Stair {
  const start = fn(s.start);
  const tip = fn({ x: s.start.x + s.dir.x, y: s.start.y + s.dir.y });
  const dx = tip.x - start.x, dy = tip.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const flips = reversesOrientation(fn);
  return {
    ...s,
    start,
    dir: { x: dx / len, y: dy / len },
    runLength: s.runLength * f,
    width: s.width * f,
    ...(s.run2Length !== undefined ? { run2Length: s.run2Length * f } : {}),
    ...(s.turn !== undefined ? { turn: (flips ? -s.turn : s.turn) as 1 | -1 } : {}),
    ...(s.center ? { center: fn(s.center) } : {}),
    ...(s.radius !== undefined ? { radius: s.radius * f } : {}),
    ...(s.sweep !== undefined ? { sweep: flips ? -s.sweep : s.sweep } : {}),
  };
}

/**
 * Vorschau-Umriss einer Treppe unter `fn`. Gerade/L nutzen den echten
 * `stairOutline`-Kern; Wendel liefert dort Bogensegmente statt eines
 * Polygons — für die Live-Vorschau genügt ein grob abgetasteter Innen-/
 * Aussenring (kein Anspruch auf die exakte Stufenkontur).
 */
function stairPreviewShapes(stair: Stair, fn: (p: Vec2) => Vec2): DraftShape[] {
  if (stair.shape !== "spiral") {
    const { polygon } = stairOutline(stair, 0);
    return polygon ? [{ kind: "poly", pts: polygon.map(fn), closed: true }] : [];
  }
  const center = stair.center ?? stair.start;
  const rIn = Math.max(0, stair.radius ?? 0);
  const rOut = rIn + stair.width;
  const sweepDeg = stair.sweep ?? 360;
  const a0 = Math.atan2(stair.start.y - center.y, stair.start.x - center.x);
  const steps = Math.max(4, Math.round(Math.abs(sweepDeg) / 15));
  const outer: Vec2[] = [], inner: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((sweepDeg * Math.PI) / 180) * (i / steps);
    outer.push(fn({ x: center.x + Math.cos(a) * rOut, y: center.y + Math.sin(a) * rOut }));
    inner.push(fn({ x: center.x + Math.cos(a) * rIn, y: center.y + Math.sin(a) * rIn }));
  }
  return [{ kind: "poly", pts: [...outer, ...inner.reverse()], closed: true }];
}

/** Vorschau-Formen für ein Element unter der Punkt-Transformation `fn`. */
/** Vorschau eines einzelnen Flächen-Elements (Decke/Raum/Treppe) unter einer Verschiebung. */
export function areaMovePreview(
  project: Project,
  kind: "ceiling" | "room" | "stair" | "wall",
  id: string,
  delta: Vec2,
): DraftShape[] {
  const fn = (p: Vec2): Vec2 => ({ x: p.x + delta.x, y: p.y + delta.y });
  if (kind === "wall") {
    const w = project.walls.find((x) => x.id === id);
    return w ? itemPreview(project, { kind: "wall", wall: w } as AnyItem, fn) : [];
  }
  if (kind === "ceiling") {
    const c = (project.ceilings ?? []).find((x) => x.id === id);
    return c ? itemPreview(project, { kind: "ceiling", ceiling: c } as AnyItem, fn) : [];
  }
  if (kind === "room") {
    const r = (project.rooms ?? []).find((x) => x.id === id);
    return r ? itemPreview(project, { kind: "room", room: r } as AnyItem, fn) : [];
  }
  const st = (project.stairs ?? []).find((x) => x.id === id);
  return st ? itemPreview(project, { kind: "stair", stair: st } as AnyItem, fn) : [];
}

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
  if (item.kind === "ceiling") {
    return [{ kind: "poly", pts: item.ceiling.outline.map(fn), closed: true }];
  }
  if (item.kind === "roof") {
    return [{ kind: "poly", pts: item.roof.outline.map(fn), closed: true }];
  }
  if (item.kind === "room") {
    return [{ kind: "poly", pts: item.room.boundary.map(fn), closed: true }];
  }
  if (item.kind === "stair") {
    return stairPreviewShapes(item.stair, fn);
  }
  const g = mvGeom(item.drawing.geom, fn);
  // Allgemein: dieselbe Primitiv-Erzeugung wie im Plan (alle Formen, inkl. Bögen
  // in Polylinien, Text, Bemassung, Kreis …). Fallback unten nur, falls daraus
  // nichts entsteht.
  const generic = drawingPreviewShapes(project, { ...item.drawing, geom: g });
  if (generic.length) return generic;
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
  const items = gatherItems(project, sel, op);
  const shapes: DraftShape[] = [];
  const instances: number[] = [...copyTs(op, mode, count)];
  if (movesOriginal(mode)) instances.push(1); // U: Original an Endlage zeigen
  for (const t of instances) {
    const fn = transformFn(op, pts, t);
    for (const item of items) shapes.push(...itemPreview(project, item, fn));
  }
  return shapes;
}

/** Anzahl Segmente des Radius-Kreises in {@link rotateGizmoShapes} — grob
 * genug für eine flüssige Draft-Vorschau, fein genug, um rund zu wirken. */
const ROTATE_GIZMO_CIRCLE_SEGMENTS = 48;

/**
 * Dreh-Gizmo (ArchiCAD/Vectorworks-Stil, Nutzer-Wunsch „bei Drehen auch eine
 * Darstellung"): eine Linie vom Zentrum zum FESTEN Referenzpunkt (0°-Basis),
 * eine Linie vom Zentrum zum aktuellen Cursor (laufender Winkel) und ein
 * Kreis mit Radius = Abstand Zentrum→Referenzpunkt. Der Kreis besteht bewusst
 * aus einzelnen `"line"`-Segmenten statt EINES geschlossenen `"poly"` — Letzeres
 * rendert im 2D-SVG-Overlay (`plan/planView/overlays.tsx`) IMMER gefüllt
 * (`.tool-preview-fill`, auch bei `closed:false` — ein `<polygon>` kennt keine
 * offene Variante) und wäre optisch nicht mehr von der transformierten
 * Vorschau-Kontur (ebenfalls oft eine gefüllte Fläche) zu unterscheiden; als
 * Liniensegmente bleibt der Kreis ein dünner Ring (`.tool-preview-line`).
 * Läuft über denselben `draft.preview`-Kanal wie die transformierte
 * Vorschau-Kontur (App.tsx `transformMove` hängt das Ergebnis an), zeichnet
 * sich also automatisch in BEIDEN Ansichten (2D-SVG-Overlay UND 3D-Weltraum-
 * Linien, s. `plan/toWalls3d.ts::draftWorldLines`) — kein eigener Render-Pfad
 * nötig. Leeres Array, wenn Zentrum und Referenzpunkt zusammenfallen (kein
 * Radius).
 */
export function rotateGizmoShapes(center: Vec2, refPoint: Vec2, cursor: Vec2): DraftShape[] {
  const radius = Math.hypot(refPoint.x - center.x, refPoint.y - center.y);
  if (radius < 1e-6) return [];
  const circle: Vec2[] = [];
  for (let i = 0; i < ROTATE_GIZMO_CIRCLE_SEGMENTS; i++) {
    const a = (i / ROTATE_GIZMO_CIRCLE_SEGMENTS) * Math.PI * 2;
    circle.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius });
  }
  const shapes: DraftShape[] = [
    { kind: "line", a: center, b: refPoint },
    { kind: "line", a: center, b: cursor },
  ];
  for (let i = 0; i < circle.length; i++) {
    shapes.push({ kind: "line", a: circle[i], b: circle[(i + 1) % circle.length] });
  }
  return shapes;
}

// ── Commit ───────────────────────────────────────────────────────────────────

/**
 * Die Transformation als Ops ([K4] S3): `replace` je bewegtem Original (nur bei „move"), `add` der
 * Kopien je Liste. Liest nur die gewählten Elemente — keine Projekt-Differenz über alle Wände.
 */
export function transformOps(
  project: Project,
  sel: TransformSelection,
  op: TransformOp,
  pts: Vec2[],
  mode: CopyMode,
  count: number,
): CoreOp[] {
  const items = gatherItems(project, sel, op);
  if (items.length === 0) return [];
  const wallIds = new Set(sel.wallIds);
  // Bei einer Skalierung müssen auch Grössenfelder (Radius/Schrifthöhe/…)
  // mitziehen — dafür `scaleGeom` statt `mvGeom` (s. dort); analog für
  // Treppen `mvStair` mit dem Skalierungsfaktor statt Faktor 1.
  const geomAt = (geom: Drawing2DGeom, fn: (p: Vec2) => Vec2, t: number): Drawing2DGeom =>
    op === "scale" ? scaleGeom(geom, fn, scaleFactor(pts, t)) : mvGeom(geom, fn);
  const stairAt = (s: Stair, fn: (p: Vec2) => Vec2, t: number): Stair =>
    mvStair(s, fn, op === "scale" ? scaleFactor(pts, t) : 1);

  const ceilingIds = new Set(sel.ceilingIds ?? []);
  const roofIds = new Set(sel.roofIds ?? []);
  const stairIds = new Set(sel.stairIds ?? []);
  const roomIds = new Set(sel.roomIds ?? []);
  const ops: CoreOp[] = [];

  // U (move): Original an die Endlage (t=1) transformieren. Objekt-Sperre
  // (`locked`) überall mitgeprüft — dieselbe Semantik wie `gatherItems`
  // oben (das hier ist ein SEPARATER Pfad, der `items` nicht durchläuft,
  // s. Kommentar bei `roofTransformAllowed`-Nutzung als Präzedenzfall für
  // genau diese Art von Doppel-Pflege).
  if (movesOriginal(mode)) {
    const fn = transformFn(op, pts, 1);
    ops.push(
      ...patchItems(project, "walls", (w) => wallIds.has(w.id) && !w.locked, (w) => ({
        ...w,
        start: fn(w.start),
        end: fn(w.end),
      })),
    );
    const moveDrawIds = drawingIdSet(sel);
    if (moveDrawIds.size > 0) {
      ops.push(
        ...patchItems(project, "drawings2d", (d) => moveDrawIds.has(d.id) && !d.locked, (d) => ({
          ...d,
          geom: geomAt(d.geom, fn, 1),
        })),
      );
    }
    if (sel.extrudedSolidId) {
      // Skalierung: `points` (2D-Tesselierung fürs Grundriss-Polygon) UND der
      // echte Radius `circle.r` (den `toWalls3d.ts` für die runde 3D-Extrusion
      // nutzt) müssen mitziehen — sonst weicht das 3D-Volumen sichtbar von
      // der Grundriss-Kontur ab (nur `center` mitzuführen genügt nicht).
      const f1 = op === "scale" ? scaleFactor(pts, 1) : 1;
      const solidId = sel.extrudedSolidId;
      ops.push(...patchItems(project, "extrudedSolids", (s) => s.id === solidId, (s) => transformSolid(s, fn, f1)));
    }
    if (sel.columnId) {
      const columnId = sel.columnId;
      ops.push(...patchItems(project, "columns", (c) => c.id === columnId && !c.locked, (c) => mvColumn(c, fn)));
    }
    if (ceilingIds.size > 0)
      ops.push(...patchItems(project, "ceilings", (c) => ceilingIds.has(c.id) && !c.locked, (c) => mvCeiling(c, fn)));
    if (roofIds.size > 0 && roofTransformAllowed(op))
      ops.push(...patchItems(project, "roofs", (r) => roofIds.has(r.id) && !r.locked, (r) => mvRoof(r, fn)));
    if (stairIds.size > 0)
      ops.push(...patchItems(project, "stairs", (s) => stairIds.has(s.id) && !s.locked, (s) => stairAt(s, fn, 1)));
    if (roomIds.size > 0)
      ops.push(...patchItems(project, "rooms", (r) => roomIds.has(r.id) && !r.locked, (r) => mvRoom(r, fn)));
  }

  // Kopien anhängen (I/O/P bzw. mirror copy).
  const newWalls: Wall[] = [];
  const newDrawings: Drawing2D[] = [];
  const newSolids: ExtrudedSolid[] = [];
  const newColumns: Column[] = [];
  const newCeilings: Ceiling[] = [];
  const newRoofs: Roof[] = [];
  const newStairs: Stair[] = [];
  const newRooms: Room[] = [];
  for (const t of copyTs(op, mode, count)) {
    const fn = transformFn(op, pts, t);
    for (const item of items) {
      switch (item.kind) {
        case "wall": {
          const w = item.wall;
          newWalls.push({ ...w, id: uniqueId("W"), start: fn(w.start), end: fn(w.end) });
          break;
        }
        case "drawing": {
          const d = item.drawing;
          newDrawings.push({ ...d, id: uniqueId("dr2d"), geom: geomAt(d.geom, fn, t) });
          break;
        }
        case "column":
          newColumns.push({ ...mvColumn(item.column, fn), id: uniqueId("column") });
          break;
        case "ceiling":
          newCeilings.push({ ...mvCeiling(item.ceiling, fn), id: uniqueId("C") });
          break;
        case "roof":
          newRoofs.push({ ...mvRoof(item.roof, fn), id: uniqueId("RF") });
          break;
        case "stair":
          newStairs.push({ ...stairAt(item.stair, fn, t), id: uniqueId("ST") });
          break;
        case "room":
          newRooms.push({ ...mvRoom(item.room, fn), id: uniqueId("RM") });
          break;
        case "extrudedSolid": {
          const s = item.solid;
          const f = op === "scale" ? scaleFactor(pts, t) : 1;
          newSolids.push({ ...transformSolid(s, fn, f), id: uniqueId("extrude") });
          break;
        }
      }
    }
  }
  ops.push(
    ...addItems("walls", newWalls),
    ...addItems("drawings2d", newDrawings),
    ...addItems("extrudedSolids", newSolids),
    ...addItems("columns", newColumns),
    ...addItems("ceilings", newCeilings),
    ...addItems("roofs", newRoofs),
    ...addItems("stairs", newStairs),
    ...addItems("rooms", newRooms),
  );
  return ops;
}

/** Wendet die Transformation immutabel auf das Projekt an (Original + Kopien), über {@link transformOps}. */
export function commitTransform(
  project: Project,
  sel: TransformSelection,
  op: TransformOp,
  pts: Vec2[],
  mode: CopyMode,
  count: number,
): Project {
  return applyOps(project, transformOps(project, sel, op, pts, mode, count));
}

/**
 * Wie {@link commitTransform}, als Projekt → Projekt-Funktion mit mitgeführten Ops (`opsMutation`) —
 * für `CommandResult.commit`: `setProject` übergibt die Ops ohne Projekt-Differenz an den Kern.
 */
export function transformMutation(
  sel: TransformSelection,
  op: TransformOp,
  pts: Vec2[],
  mode: CopyMode,
  count: number,
): ProjectMutation {
  return opsMutation((p) => transformOps(p, sel, op, pts, mode, count));
}
