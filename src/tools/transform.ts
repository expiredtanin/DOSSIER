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
import { columnFootprint } from "../geometry/column";
import { stairOutline } from "../geometry/stair";
import type { DraftShape } from "./types";
import { drawingPreviewShapes } from "./drawingPreview";
import { uniqueId } from "./types";
import type { CommandSelection } from "../commands/types";

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
/**
 * Erkennt, ob `fn` die Umlauf-Orientierung umkehrt (Spiegelung) — via
 * Flächenvorzeichen eines Test-Dreiecks unter `fn` (negativ ⇒ Spiegelung).
 * Funktioniert für JEDE Isometrie/Similarity (Move/Rotate/Scale erhalten die
 * Orientierung, Mirror kehrt sie um), ohne dass eine Operation ihre Spiegel-
 * Eigenschaft explizit markieren müsste.
 */
function reversesOrientation(fn: (p: Vec2) => Vec2): boolean {
  const p0 = fn({ x: 0, y: 0 }), p1 = fn({ x: 1, y: 0 }), p2 = fn({ x: 0, y: 1 });
  return (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y) < 0;
}

function mvColumn(col: Column, fn: (p: Vec2) => Vec2): Column {
  const base = col.position;
  const rot = col.rotation ?? 0;
  const tip = { x: base.x + Math.cos(rot), y: base.y + Math.sin(rot) };
  const nb = fn(base);
  const nt = fn(tip);
  return { ...col, position: nb, rotation: Math.atan2(nt.y - nb.y, nt.x - nb.x) };
}

/** Bildet jeden Punkt einer 2D-Zeichengeometrie unter `fn` ab (Move/Mirror/Rotate/Array + Block-Rendering). */
/**
 * Wie {@link mvGeom}, zusätzlich für eine SKALIERUNG: `mvGeom` bildet nur
 * PUNKTE ab — Radien, Schrifthöhen und der Bemassungs-Abstand sind aber keine
 * Punkte und blieben sonst unverändert stehen (ein Kreis behielte unter einer
 * 2×-Skalierung seinen Radius). Diese Funktion zieht die betroffenen
 * Grössenfelder um denselben Faktor nach.
 *
 * Bewusst NICHT angefasst: `bulge` (ein Formverhältnis, skaleninvariant) und
 * die Papier-mm-Felder von Bemassung/Linienenden — die beziehen sich auf das
 * Blatt, nicht aufs Modell, und dürfen beim Skalieren des Objekts gleich
 * bleiben.
 */
/** Skalierungsfaktor eines `op:"scale"`-Punkte-Tripels bei Interpolation `t`. */
export function scaleFactor(pts: Vec2[], t: number): number {
  const c = pts[0];
  const ref = Math.hypot(pts[1].x - c.x, pts[1].y - c.y) || 1;
  const tgt = Math.hypot(pts[2].x - c.x, pts[2].y - c.y);
  return 1 + (tgt / ref - 1) * t;
}

export const scaleGeom = (geom: Drawing2DGeom, fn: (p: Vec2) => Vec2, f: number): Drawing2DGeom => {
  const g = mvGeom(geom, fn);
  switch (g.shape) {
    case "circle":
      return { ...g, r: g.r * f };
    case "arc":
      return { ...g, r: g.r * f };
    case "ellipse":
      return { ...g, rx: g.rx * f, ry: g.ry * f };
    case "dimension":
      // `offset` ist der Normalabstand der Masslinie in Modellmass.
      return { ...g, offset: g.offset * f };
    case "text":
      return {
        ...g,
        height: g.height * f,
        ...(g.width !== undefined ? { width: g.width * f } : {}),
      };
    case "scalebar":
      // Segmentlänge ist eine ECHTE Modell-Distanz (kein Papier-mm-Feld wie
      // bei Kote/Bemassung) — muss bei einer Modell-Skalierung mitwachsen,
      // sonst zeigt der Balken nach dem Skalieren die FALSCHE Distanz an.
      return { ...g, segmentLength: g.segmentLength * f };
    case "block":
      // Blockinstanz-Skalierung (s. Typ-Kommentar in model/types.ts) —
      // ohne diesen Fall wäre der `scale`-Befehl auf eine Blockinstanz ein
      // kompletter No-Op (kein Feld zum Multiplizieren).
      return { ...g, scale: (g.scale ?? 1) * f };
    default:
      return g;
  }
};

export const mvGeom = (geom: Drawing2DGeom, fn: (p: Vec2) => Vec2): Drawing2DGeom => {
  switch (geom.shape) {
    case "line":
    case "xline":
    case "ray":
      return { ...geom, a: fn(geom.a), b: fn(geom.b) };
    case "polyline": {
      const pts = geom.pts.map(fn);
      if (!geom.bulge) return { ...geom, pts };
      // Bulge-Vorzeichen ist rein relativ zur Zeichenrichtung definiert (links
      // von a→b) — eine Spiegelung kehrt die Umlauf-Orientierung um und muss
      // daher auch jeden Bogen umkehren, sonst wandert er auf die falsche Seite.
      const bulge = reversesOrientation(fn) ? geom.bulge.map((b) => -b) : geom.bulge;
      return { ...geom, pts, bulge };
    }
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
    case "dimension":
      return { ...geom, pts: geom.pts.map(fn) };
    case "kote":
      return { ...geom, at: fn(geom.at) };
    case "detailref":
      return { ...geom, at: fn(geom.at) };
    case "scalebar":
      return { ...geom, at: fn(geom.at) };
    case "pointmarker":
      return { ...geom, at: fn(geom.at) };
    case "text":
      // Leader-Ziel bzw. Pfadpunkte (Text-entlang-Pfad) müssen mitwandern,
      // sonst zeigt der Pfeil/Pfad nach einem Move/Mirror/Rotate/Array auf die
      // alte Position.
      return {
        ...geom,
        at: fn(geom.at),
        ...(geom.leaderTarget ? { leaderTarget: fn(geom.leaderTarget) } : {}),
        ...(geom.leaderBendPoints ? { leaderBendPoints: geom.leaderBendPoints.map(fn) } : {}),
        ...(geom.pathPts ? { pathPts: geom.pathPts.map(fn) } : {}),
      };
    case "block": {
      // Wie Column: Winkel aus einem transformierten Richtungspunkt zurück-
      // rechnen, damit Rotate/Mirror auch die Instanz-Ausrichtung mitnehmen
      // (nicht nur den Einfügepunkt) — reine Translation liesse die Symbole
      // beim Drehen der Auswahl in der alten Orientierung stehen.
      const tip = { x: geom.at.x + Math.cos(geom.rotation), y: geom.at.y + Math.sin(geom.rotation) };
      const nb = fn(geom.at);
      const nt = fn(tip);
      return { ...geom, at: nb, rotation: Math.atan2(nt.y - nb.y, nt.x - nb.x) };
    }
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

/** Wendet die Transformation immutabel auf das Projekt an (Original + Kopien). */
export function commitTransform(
  project: Project,
  sel: TransformSelection,
  op: TransformOp,
  pts: Vec2[],
  mode: CopyMode,
  count: number,
): Project {
  const items = gatherItems(project, sel, op);
  if (items.length === 0) return project;
  const wallIds = new Set(sel.wallIds);
  // Bei einer Skalierung müssen auch Grössenfelder (Radius/Schrifthöhe/…)
  // mitziehen — dafür `scaleGeom` statt `mvGeom` (s. dort); analog für
  // Treppen `mvStair` mit dem Skalierungsfaktor statt Faktor 1.
  const geomAt = (geom: Drawing2DGeom, fn: (p: Vec2) => Vec2, t: number): Drawing2DGeom =>
    op === "scale" ? scaleGeom(geom, fn, scaleFactor(pts, t)) : mvGeom(geom, fn);
  const stairAt = (s: Stair, fn: (p: Vec2) => Vec2, t: number): Stair =>
    mvStair(s, fn, op === "scale" ? scaleFactor(pts, t) : 1);

  let walls = project.walls;
  let drawings2d = project.drawings2d;
  let extrudedSolids = project.extrudedSolids ?? [];
  let columns = project.columns ?? [];
  let ceilings = project.ceilings ?? [];
  let roofs = project.roofs ?? [];
  let stairs = project.stairs ?? [];
  let rooms = project.rooms ?? [];
  const ceilingIds = new Set(sel.ceilingIds ?? []);
  const roofIds = new Set(sel.roofIds ?? []);
  const stairIds = new Set(sel.stairIds ?? []);
  const roomIds = new Set(sel.roomIds ?? []);

  // U (move): Original an die Endlage (t=1) transformieren. Objekt-Sperre
  // (`locked`) überall mitgeprüft — dieselbe Semantik wie `gatherItems`
  // oben (das hier ist ein SEPARATER Pfad, der `items` nicht durchläuft,
  // s. Kommentar bei `roofTransformAllowed`-Nutzung als Präzedenzfall für
  // genau diese Art von Doppel-Pflege).
  if (movesOriginal(mode)) {
    const fn = transformFn(op, pts, 1);
    walls = walls.map((w) =>
      wallIds.has(w.id) && !w.locked ? { ...w, start: fn(w.start), end: fn(w.end) } : w,
    );
    const moveDrawIds = drawingIdSet(sel);
    if (moveDrawIds.size > 0) {
      drawings2d = drawings2d.map((d) =>
        moveDrawIds.has(d.id) && !d.locked ? { ...d, geom: geomAt(d.geom, fn, 1) } : d,
      );
    }
    if (sel.extrudedSolidId) {
      // Skalierung: `points` (2D-Tesselierung fürs Grundriss-Polygon) UND der
      // echte Radius `circle.r` (den `toWalls3d.ts` für die runde 3D-Extrusion
      // nutzt) müssen mitziehen — sonst weicht das 3D-Volumen sichtbar von
      // der Grundriss-Kontur ab (nur `center` mitzuführen genügt nicht).
      const f1 = op === "scale" ? scaleFactor(pts, 1) : 1;
      extrudedSolids = extrudedSolids.map((s) =>
        s.id === sel.extrudedSolidId
          ? {
              ...s,
              points: s.points.map(fn),
              circle: s.circle ? { ...s.circle, center: fn(s.circle.center), r: s.circle.r * f1 } : undefined,
            }
          : s,
      );
    }
    if (sel.columnId) {
      columns = columns.map((c) => (c.id === sel.columnId && !c.locked ? mvColumn(c, fn) : c));
    }
    if (ceilingIds.size > 0)
      ceilings = ceilings.map((c) => (ceilingIds.has(c.id) && !c.locked ? mvCeiling(c, fn) : c));
    if (roofIds.size > 0 && roofTransformAllowed(op)) {
      roofs = roofs.map((r) => (roofIds.has(r.id) && !r.locked ? mvRoof(r, fn) : r));
    }
    if (stairIds.size > 0)
      stairs = stairs.map((s) => (stairIds.has(s.id) && !s.locked ? stairAt(s, fn, 1) : s));
    if (roomIds.size > 0) rooms = rooms.map((r) => (roomIds.has(r.id) && !r.locked ? mvRoom(r, fn) : r));
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
          newSolids.push({
            ...s,
            id: uniqueId("extrude"),
            points: s.points.map(fn),
            circle: s.circle ? { ...s.circle, center: fn(s.circle.center), r: s.circle.r * f } : undefined,
          });
          break;
        }
      }
    }
  }

  return {
    ...project,
    walls: newWalls.length ? [...walls, ...newWalls] : walls,
    drawings2d: newDrawings.length ? [...drawings2d, ...newDrawings] : drawings2d,
    extrudedSolids: newSolids.length ? [...extrudedSolids, ...newSolids] : extrudedSolids,
    columns: newColumns.length ? [...columns, ...newColumns] : columns,
    ceilings: newCeilings.length ? [...ceilings, ...newCeilings] : ceilings,
    roofs: newRoofs.length ? [...roofs, ...newRoofs] : roofs,
    stairs: newStairs.length ? [...stairs, ...newStairs] : stairs,
    rooms: newRooms.length ? [...rooms, ...newRooms] : rooms,
  };
}
