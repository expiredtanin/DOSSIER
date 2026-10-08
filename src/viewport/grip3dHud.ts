// Reine Geometrie-Helfer für den Cursor-HUD während eines 3D-Griff-Drags
// (`Wasm3DViewport.tsx`/`App.tsx::onEdit3dVertex`/`onEdit3dBody`) — Nutzer-
// Report „beim Verschieben von Elementen zeigt es die Werte nicht an": die
// 3D-Griffe mutierten das Modell bisher ohne je den Cursor-HUD (`draft.hud`)
// zu füllen, anders als die 2D-Griff-Bearbeitung (`state/useGripEditing.ts::
// hudFor`/`edgeHudFor`). Eigene (einfachere) Variante statt
// `useGripEditing.ts::resolveGripAnchor` — die ist an dessen FLACHE
// Mehrfachauswahl-Grips-Liste gekoppelt, hier reicht die direkte
// `target`+`index`-Adressierung des 3D-Griffs. Reine Funktionen (Project +
// Target rein, Vec2/hud raus) — kein React-/DOM-Bezug, direkt testbar.

import type { Drawing2D, Project, Vec2 } from "../model/types";
import type { ToolDraft } from "../tools/types";
import { drawingGripVertices, drawingMoveAnchor } from "./drawingGrips";

/** Adressiert das Ziel-Element eines 3D-Griffs — Wand ODER Zeichnung ODER
 * Decke ODER Dach (genau eines gesetzt). */
export interface Grip3dTarget {
  wallId?: string;
  drawingId?: string;
  ceilingId?: string;
  roofId?: string;
}

function ringNeighbor(pts: Vec2[], i: number, closed: boolean): Vec2 | null {
  const n = pts.length;
  if (n < 2) return null;
  const prevIdx = i > 0 ? i - 1 : closed ? n - 1 : null;
  const nextIdx = i < n - 1 ? i + 1 : closed ? 0 : null;
  const refIdx = prevIdx ?? nextIdx;
  return refIdx != null ? pts[refIdx] : null;
}

function drawingIsClosed(d: Drawing2D): boolean {
  const g = d.geom;
  return g.shape === "rect" || g.shape === "image" || (g.shape === "polyline" && !!g.closed);
}

/**
 * Nachbarpunkt eines gezogenen 3D-Vertex-Griffs (für Länge/Winkel relativ zur
 * Nachbarecke, wie im 2D). Wand: die jeweils ANDERE der zwei Ecken. Zeichnung
 * (Linie/Polylinie/Rechteck): Ring-Nachbar über `drawingGripVertices`
 * (dieselbe Indizierung wie die 3D-Vertex-Griffe selbst, s. `computeGrips` in
 * Wasm3DViewport.tsx). Decke/Dach: Ring-Nachbar über `outline` (beides
 * geschlossene Umrisse). `null` ohne sinnvollen Anker (Element nicht
 * gefunden, oder Ziel weder Wand/Zeichnung/Decke/Dach).
 */
export function neighbor3dVertex(project: Project, target: Grip3dTarget, index: number): Vec2 | null {
  if (target.wallId) {
    const wall = project.walls.find((w) => w.id === target.wallId);
    if (!wall) return null;
    return index === 0 ? wall.end : wall.start;
  }
  if (target.drawingId) {
    const d = project.drawings2d.find((x) => x.id === target.drawingId);
    if (!d) return null;
    return ringNeighbor(drawingGripVertices(d), index, drawingIsClosed(d));
  }
  if (target.ceilingId) {
    const c = (project.ceilings ?? []).find((x) => x.id === target.ceilingId);
    return c ? ringNeighbor(c.outline, index, true) : null;
  }
  if (target.roofId) {
    const r = (project.roofs ?? []).find((x) => x.id === target.roofId);
    return r ? ringNeighbor(r.outline, index, true) : null;
  }
  return null;
}

function centroid(pts: Vec2[]): Vec2 | null {
  if (pts.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / pts.length, y: sy / pts.length };
}

/**
 * Verschiebe-Anker (Ausgangspunkt VOR dem Drag) eines Elements — Basis für die
 * Δx/Δy-Anzeige des „move"-Griffs (ganzes Element verschieben). Wand:
 * Achsmitte. Zeichnung: `drawingMoveAnchor` (Schwerpunkt der Vertex-Griffe,
 * dieselbe Position wie der sichtbare Verschiebe-Griff). Decke/Dach:
 * Schwerpunkt des Umrisses. `null` ohne auflösbares Ziel.
 */
export function bodyMoveAnchor(project: Project, target: Grip3dTarget): Vec2 | null {
  if (target.wallId) {
    const wall = project.walls.find((w) => w.id === target.wallId);
    return wall ? { x: (wall.start.x + wall.end.x) / 2, y: (wall.start.y + wall.end.y) / 2 } : null;
  }
  if (target.drawingId) {
    const d = project.drawings2d.find((x) => x.id === target.drawingId);
    return d ? drawingMoveAnchor(d, drawingGripVertices(d)) : null;
  }
  if (target.ceilingId) {
    const c = (project.ceilings ?? []).find((x) => x.id === target.ceilingId);
    return c ? centroid(c.outline) : null;
  }
  if (target.roofId) {
    const r = (project.roofs ?? []).find((x) => x.id === target.roofId);
    return r ? centroid(r.outline) : null;
  }
  return null;
}

/** Baut den `ToolDraft.hud` (Länge/Winkel, VW-Stil) für einen Punkt relativ
 * zu einem Anker — dieselbe Formel wie `useGripEditing.ts::hudFor`. */
export function hudFromAnchor(anchor: Vec2, pt: Vec2): NonNullable<ToolDraft["hud"]> {
  const dx = pt.x - anchor.x;
  const dy = pt.y - anchor.y;
  const angleDeg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  return { at: pt, length: Math.hypot(dx, dy), angleDeg };
}

/** Eindeutiger Schlüssel eines Grip3dTargets — erkennt einen Ziel-Wechsel
 * (neuer Drag) für die Delta-Akkumulation des „move"-Griffs. */
export function grip3dTargetKey(target: Grip3dTarget): string {
  return target.wallId ?? target.drawingId ?? target.ceilingId ?? target.roofId ?? "";
}

// ── Getippte Werteingabe während eines 3D-Griff-Drags ───────────────────────
// Nutzer-Report: „man sieht die Länge und den Winkel, aber man kann nichts
// eingeben" — der Cursor-HUD zeigte die Werte bereits (s. o.), aber Tab öffnete
// keinen Feld-Controller wie im 2D (`useGripEditing.ts::cycleGripEditField`/
// `submitGripEditValue`/`gripEditPoint`). Diese drei Funktionen sind das
// 3D-Äquivalent — bewusst eigenständig statt den 2D-Hook wiederzuverwenden:
// der ist an dessen FLACHE Mehrfachauswahl-Grips-Liste UND an EINZEL-Selektion
// (`selectedWallId`/`selectedDrawingId`) gekoppelt, während die 3D-Griffe
// `target`-adressiert sind und mehrere Elemente gleichzeitig tragen können
// (`editWalls`/`editDrawings`, s. Wasm3DViewport.tsx). Dieselbe Kernformel
// (`grip3dEditPoint` ⇔ `gripEditPoint`) — nur der Name macht die 3D-Herkunft
// eindeutig.

/** Gelockte Länge/Winkel-Werte eines 3D-Feld-Controllers (Tab-Zyklus). */
export interface Grip3dEditLocks {
  length?: number;
  angle?: number;
}

/** Voller Zustand des 3D-Feld-Controllers — lebt in App.tsx (`grip3dEdit`),
 * da nur dort auch die Befehlszeile (`CommandLine`) sitzt. `index` ist bei
 * `kind:"move"` bedeutungslos (kein Vertex-Index, ganzes Element). */
export interface Grip3dEditState {
  target: Grip3dTarget;
  index: number;
  kind: "vertex" | "move";
  anchor: Vec2;
  active: "length" | "angle";
  locks: Grip3dEditLocks;
}

/**
 * Zielpunkt aus Anker + (gelockten/live) Länge/Winkel — identisch zu
 * `useGripEditing.ts::gripEditPoint`. Ungelockte Grössen folgen `raw` (dem
 * zuletzt bekannten, maus-getriebenen Punkt).
 */
export function grip3dEditPoint(anchor: Vec2, locks: Grip3dEditLocks, raw: Vec2): Vec2 {
  const dx = raw.x - anchor.x;
  const dy = raw.y - anchor.y;
  const length = locks.length != null ? locks.length : Math.hypot(dx, dy);
  const angleDeg = locks.angle != null ? locks.angle : (Math.atan2(dy, dx) * 180) / Math.PI;
  const a = (angleDeg * Math.PI) / 180;
  return { x: anchor.x + Math.cos(a) * length, y: anchor.y + Math.sin(a) * length };
}

/**
 * Öffnet (erstes Tab, `prev` null) ODER zykelt (weiteres Tab) den 3D-Feld-
 * Controller — identisch zum 2D-Verhalten (`cycleGripEditField`): Öffnen
 * friert BEIDE Werte an der aktuellen Position ein (Maus verliert bis zu
 * einem expliziten Tab jeden Einfluss); Zykeln wechselt das aktive Feld und
 * LÖST dessen Lock (frei für die Maus), das verlassene Feld bleibt fix.
 */
export function cycleGrip3dEditState(
  prev: Grip3dEditState | null,
  info: { target: Grip3dTarget; index: number; kind: "vertex" | "move"; anchor: Vec2; raw: Vec2 },
): Grip3dEditState {
  if (!prev) {
    const dx = info.raw.x - info.anchor.x;
    const dy = info.raw.y - info.anchor.y;
    const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    return {
      target: info.target,
      index: info.index,
      kind: info.kind,
      anchor: info.anchor,
      active: "length",
      locks: { length: Math.hypot(dx, dy), angle },
    };
  }
  const active = prev.active === "length" ? "angle" : "length";
  const locks = { ...prev.locks };
  delete locks[active];
  return { ...prev, active, locks };
}

/**
 * Getippter Zahlenwert im 3D-Feld-Controller: aktives Feld locken, aufs
 * andere Feld vorrücken (das bleibt unverändert fixiert) — identisch zu
 * `useGripEditing.ts::submitGripEditValue`. Reine Zustands-Transformation;
 * das Anwenden aufs Modell übernimmt App.tsx (`submitGrip3dEditValue`, dort
 * auch der Name für den Aufrufer der Befehlszeile).
 */
export function nextGrip3dEditState(state: Grip3dEditState, value: number): Grip3dEditState {
  const locks = { ...state.locks, [state.active]: value };
  const active = state.active === "length" ? "angle" : "length";
  return { ...state, locks, active };
}

/** Befehlszeilen-Felder (Länge/Winkel) für den 3D-Feld-Controller — dieselbe
 * Form wie `CommandLineField[]`, hier ohne Import (kein Zyklus zur UI). */
export function grip3dEditFields(
  state: Grip3dEditState,
  raw: Vec2,
): { id: string; labelKey: string; value: number; locked: boolean; active: boolean }[] {
  const dx = raw.x - state.anchor.x;
  const dy = raw.y - state.anchor.y;
  const liveLen = Math.hypot(dx, dy);
  const liveAng = ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
  return [
    {
      id: "length",
      labelKey: "cmd.field.length",
      value: state.locks.length ?? liveLen,
      locked: state.locks.length != null,
      active: state.active === "length",
    },
    {
      id: "angle",
      labelKey: "cmd.field.angle",
      value: state.locks.angle ?? liveAng,
      locked: state.locks.angle != null,
      active: state.active === "angle",
    },
  ];
}

// ── Koinzidenz-Gruppe (gemeinsame Ecke mehrerer Wände/Zeichnungen) ──────────
// Nutzer-Wunsch „3D ist noch so unterentwickelt": Anders als der 2D-Plan UND
// der three.js-Fallback (`Viewport3D.tsx::findCoincident`/`findMoveCoincident`)
// kannte der WASM-3D-Griff bislang KEINE Objekt-Snap-Ausschluss- UND KEINE
// Koinzidenz-Mitführ-Logik — `onEdit3dVertex` bekam nie `excludeWallIds`/
// `excludeDrawingIds` übergeben (Snap dadurch beim 3D-Vertex-Drag komplett
// INAKTIV) und ein gezogener Wand-Eckpunkt riss sich von ANDEREN Wänden mit
// derselben Ecke los, statt sie mitzuführen (strukturelle Verbindung ginge
// beim Ziehen verloren). Diese drei Funktionen sind die exakte 1:1-Portierung
// der three.js-Logik, nur fürs `target`-Adressierungsschema.

/** Toleranz (Welt-Meter) für „derselbe Punkt" bei der Koinzidenz-Erkennung —
 * identisch zu `Viewport3D.tsx`s `COINCIDENT_TOL`. */
const COINCIDENT_TOL = 0.05;

/** Ein koinzidenter Endpunkt-Griff eines ANDEREN Elements (gemeinsame Ecke). */
export interface CoincidentVertex {
  target: Grip3dTarget;
  index: number;
}

/** Alle Eckpunkte eines Elements (Wand: start/end; Zeichnung: Griff-Vertices).
 * Nur Wand/Zeichnung — Decke/Dach kennt `snapFor3dVertex`/der 2D-Exclude-Satz
 * ohnehin nicht (dieselbe Einschränkung wie im three.js-Pfad). */
function elementVertexPoints(project: Project, target: Grip3dTarget): Vec2[] {
  if (target.wallId) {
    const w = project.walls.find((x) => x.id === target.wallId);
    return w ? [w.start, w.end] : [];
  }
  if (target.drawingId) {
    const d = project.drawings2d.find((x) => x.id === target.drawingId);
    return d ? drawingGripVertices(d) : [];
  }
  return [];
}

/** Punkt EINES bestimmten Vertex-Index eines Elements, oder `null`. */
function vertexPointOf(project: Project, target: Grip3dTarget, index: number): Vec2 | null {
  return elementVertexPoints(project, target)[index] ?? null;
}

/**
 * Endpunkt-Griffe ANDERER Wände/Zeichnungen, die mit `p` zusammenfallen
 * (gemeinsame Ecke, Toleranz {@link COINCIDENT_TOL}) — identisch zu
 * `Viewport3D.tsx::findCoincident`. `self` wird ausgeschlossen.
 */
export function findCoincidentVertices(project: Project, p: Vec2, self: Grip3dTarget): CoincidentVertex[] {
  const out: CoincidentVertex[] = [];
  const near = (q: Vec2) => Math.hypot(q.x - p.x, q.y - p.y) <= COINCIDENT_TOL;
  for (const w of project.walls) {
    if (w.id === self.wallId) continue;
    if (near(w.start)) out.push({ target: { wallId: w.id }, index: 0 });
    if (near(w.end)) out.push({ target: { wallId: w.id }, index: 1 });
  }
  for (const d of project.drawings2d) {
    if (d.id === self.drawingId) continue;
    drawingGripVertices(d).forEach((v, i) => {
      if (near(v)) out.push({ target: { drawingId: d.id }, index: i });
    });
  }
  return out;
}

/** Ein koinzidenter Endpunkt-Griff fürs Körper-Verschieben — trägt zusätzlich
 * die LIVE-Position (wird beim Mitführen inkrementell fortgeschrieben). */
export interface MoveCoincidentVertex extends CoincidentVertex {
  pos: Vec2;
}

/**
 * Koinzidente Sibling-Vertices für ALLE Ecken eines Elements (Körper-Drag,
 * z. B. eine ganze Wand verschieben) — dedupliziert je (target,index).
 * Identisch zu `Viewport3D.tsx::findMoveCoincident`.
 */
export function findMoveCoincidentVertices(project: Project, self: Grip3dTarget): MoveCoincidentVertex[] {
  const seen = new Set<string>();
  const out: MoveCoincidentVertex[] = [];
  for (const corner of elementVertexPoints(project, self)) {
    for (const c of findCoincidentVertices(project, corner, self)) {
      const key = `${c.target.wallId ?? ""}|${c.target.drawingId ?? ""}|${c.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pos = vertexPointOf(project, c.target, c.index);
      if (pos) out.push({ ...c, pos: { ...pos } });
    }
  }
  return out;
}
