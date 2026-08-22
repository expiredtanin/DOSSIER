// Konkrete Werkzeuge (Phase 1: select / wall / line) + Registry.
// docs/design/drawing-tools.md §3, §4, §10.

import type { Ceiling, Drawing2D, Project, Vec2, Wall } from "../model/types";
import { wallTypeThickness } from "../model/types";
import { wallCorners } from "../model/geometry";
import { normalizeOutline, ceilingArea } from "../geometry/ceiling";
import type { DraftShape, Tool, ToolContext, ToolDraft, ToolId } from "./types";
import { uniqueId } from "./types";

const EPS = 1e-6;
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/** Dicke des aktiven Wandtyps (Meter); Fallback, falls unbekannt. */
function activeWallThickness(ctx: ToolContext): number {
  const wt = ctx.project.wallTypes.find((t) => t.id === ctx.activeWallTypeId);
  return wt ? wallTypeThickness(wt) : 0.2;
}

// ── Select ──────────────────────────────────────────────────────────────────
// Reines Platzhalter-Werkzeug: die Auswahl-/Marquee-Logik bleibt in PlanView;
// der Controller ruft dieses Werkzeug für "select" gar nicht erst auf.
const selectTool: Tool = {
  id: "select",
  labelKey: "tool.select",
  hintKey: () => "tool.select.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// ── Wall ─────────────────────────────────────────────────────────────────────
// Zeichnet eine Achs-Polylinie; jedes Segment wird ein eigenständiges Wall.
// Die Gehrung an Ecken entsteht automatisch aus computeJoins (generatePlan).

interface WallDrawing {
  phase: "drawing";
  points: Vec2[];
  cursor: Vec2 | null;
}
type WallState = { phase: "idle" } | WallDrawing;

/** Baut die Band-Vorschau für eine Achs-Polylinie + lebendes Segment. */
function wallDraft(points: Vec2[], cursor: Vec2 | null, ctx: ToolContext): ToolDraft {
  const thickness = activeWallThickness(ctx);
  const preview: DraftShape[] = [];
  const all = cursor ? [...points, cursor] : points;
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i];
    const b = all[i + 1];
    if (segLen(a, b) < EPS) continue;
    preview.push({ kind: "poly", pts: wallCorners(a, b, thickness), closed: true });
    preview.push({ kind: "line", a, b }); // Achse
  }
  const draft: ToolDraft = { preview, vertices: points };
  // HUD am lebenden Segment: Länge + Winkel.
  if (cursor && points.length > 0) {
    const a = points[points.length - 1];
    if (segLen(a, cursor) >= EPS) {
      draft.hud = {
        at: cursor,
        text: `${segLen(a, cursor).toFixed(2)} m · ${Math.abs(
          ((segAngleDeg(a, cursor) + 360) % 360),
        ).toFixed(0)}°`,
      };
    }
  }
  return draft;
}

/** Hängt je Achssegment ein Wall des aktiven Typs ans Projekt (immutabel). */
function appendWalls(project: Project, pts: Vec2[], ctx: ToolContext): Project {
  const height =
    ctx.level.floorHeight && ctx.level.floorHeight > 0 ? ctx.level.floorHeight : 2.6;
  const newWalls: Wall[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (segLen(a, b) < EPS) continue;
    newWalls.push({
      id: uniqueId("W"),
      type: "wall",
      floorId: ctx.level.id,
      categoryCode: ctx.defaultCategoryCode,
      start: a,
      end: b,
      wallTypeId: ctx.activeWallTypeId,
      height,
    });
  }
  if (newWalls.length === 0) return project;
  return { ...project, walls: [...project.walls, ...newWalls] };
}

const wallTool: Tool = {
  id: "wall",
  labelKey: "tool.wall",
  floorOnly: true,
  hintKey: (s) =>
    (s as WallState).phase === "drawing" ? "tool.wall.nextPoint" : "tool.wall.firstPoint",
  init: () => ({ phase: "idle" }),
  onClick: (state, p, ctx) => {
    const s = state as WallState;
    const points = s.phase === "drawing" ? [...s.points, p.point] : [p.point];
    const next: WallState = { phase: "drawing", points, cursor: p.point };
    return [next, { draft: wallDraft(points, p.point, ctx) }];
  },
  onMove: (state, p, ctx) => {
    const s = state as WallState;
    if (s.phase !== "drawing") return [s, { draft: { preview: [], vertices: [] } }];
    const next: WallState = { ...s, cursor: p.point };
    return [next, { draft: wallDraft(s.points, p.point, ctx) }];
  },
  onCommitGesture: (state, ctx) => {
    const s = state as WallState;
    if (s.phase !== "drawing" || s.points.length < 2) {
      return [{ phase: "idle" }, { draft: null, done: true }];
    }
    const pts = s.points;
    return [
      { phase: "idle" },
      { draft: null, done: true, commit: (proj) => appendWalls(proj, pts, ctx) },
    ];
  },
  onCancel: () => [{ phase: "idle" }, { draft: null, done: true }],
  onUndoPoint: (state, ctx) => {
    const s = state as WallState;
    if (s.phase === "drawing" && s.points.length > 1) {
      const points = s.points.slice(0, -1);
      const next: WallState = { phase: "drawing", points, cursor: s.cursor };
      return [next, { draft: wallDraft(points, s.cursor, ctx) }];
    }
    return [{ phase: "idle" }, { draft: null, done: true }];
  },
};

// ── Ceiling ────────────────────────────────────────────────────────────────
// Zeichnet einen GESCHLOSSENEN Umriss (wie eine geschlossene Polylinie) und
// committet daraus eine `Ceiling`. Der reguläre Zeichenpfad läuft über den
// gekoppelten `ceiling`-Befehl (TOOL_COMMAND); dieses Legacy-Tool ist eine
// vollständige, funktionsfähige Alternative (kein Stub).

interface CeilDrawing {
  phase: "drawing";
  points: Vec2[];
  cursor: Vec2 | null;
}
type CeilState = { phase: "idle" } | CeilDrawing;

function ceilDraft(points: Vec2[], cursor: Vec2 | null): ToolDraft {
  const all = cursor ? [...points, cursor] : points;
  const preview: DraftShape[] = [{ kind: "poly", pts: all, closed: all.length >= 3 }];
  const draft: ToolDraft = { preview, vertices: points };
  if (cursor && points.length > 0) {
    const a = points[points.length - 1];
    if (segLen(a, cursor) >= EPS) {
      draft.hud = {
        at: cursor,
        text: `${segLen(a, cursor).toFixed(2)} m · ${Math.abs(
          (segAngleDeg(a, cursor) + 360) % 360,
        ).toFixed(0)}°`,
      };
    }
  }
  return draft;
}

function appendCeiling(project: Project, pts: Vec2[], ctx: ToolContext): Project {
  const outline = normalizeOutline(pts);
  if (!outline || ceilingArea(outline) < 1e-4) return project;
  const hasCat = project.layers.some((c) => c.code === "30");
  const c: Ceiling = {
    id: uniqueId("C"),
    type: "ceiling",
    floorId: ctx.level.id,
    categoryCode: hasCat ? "30" : ctx.defaultCategoryCode,
    outline,
    wallTypeId: ctx.activeWallTypeId,
  };
  return { ...project, ceilings: project.ceilings ? [...project.ceilings, c] : [c] };
}

const ceilingTool: Tool = {
  id: "ceiling",
  labelKey: "tool.ceiling",
  floorOnly: true,
  hintKey: (s) =>
    (s as CeilState).phase === "drawing"
      ? "tool.ceiling.nextPoint"
      : "tool.ceiling.firstPoint",
  init: () => ({ phase: "idle" }),
  onClick: (state, p, ctx) => {
    const s = state as CeilState;
    if (s.phase !== "drawing") {
      return [{ phase: "drawing", points: [p.point], cursor: p.point }, { draft: ceilDraft([p.point], p.point) }];
    }
    // Klick auf den Startpunkt schließt den Umriss (ab 3 Punkten) und committet.
    if (s.points.length >= 3 && segLen(p.point, s.points[0]) < EPS) {
      const pts = s.points;
      return [{ phase: "idle" }, { draft: null, done: true, commit: (proj) => appendCeiling(proj, pts, ctx) }];
    }
    const points = [...s.points, p.point];
    return [{ phase: "drawing", points, cursor: p.point }, { draft: ceilDraft(points, p.point) }];
  },
  onMove: (state, p) => {
    const s = state as CeilState;
    if (s.phase !== "drawing") return [s, { draft: { preview: [], vertices: [] } }];
    return [{ ...s, cursor: p.point }, { draft: ceilDraft(s.points, p.point) }];
  },
  onCommitGesture: (state, ctx) => {
    const s = state as CeilState;
    if (s.phase !== "drawing" || s.points.length < 3) {
      return [{ phase: "idle" }, { draft: null, done: true }];
    }
    const pts = s.points;
    return [{ phase: "idle" }, { draft: null, done: true, commit: (proj) => appendCeiling(proj, pts, ctx) }];
  },
  onCancel: () => [{ phase: "idle" }, { draft: null, done: true }],
  onUndoPoint: (state) => {
    const s = state as CeilState;
    if (s.phase === "drawing" && s.points.length > 1) {
      const points = s.points.slice(0, -1);
      return [{ phase: "drawing", points, cursor: s.cursor }, { draft: ceilDraft(points, s.cursor) }];
    }
    return [{ phase: "idle" }, { draft: null, done: true }];
  },
};

// ── Window / Door (Öffnungen) ─────────────────────────────────────────────────
// Beide sind an den gekoppelten Befehl `fenster`/`tuer` (TOOL_COMMAND) gebunden:
// der interaktive Ablauf (Host-Wand picken → Position → committen) läuft komplett
// in der CommandEngine. Diese Tool-Objekte sind reine Platzhalter (wie `select`);
// der Controller ruft sie nicht auf, sobald der gekoppelte Befehl läuft.
const windowTool: Tool = {
  id: "window",
  labelKey: "tool.window",
  floorOnly: true,
  hintKey: () => "tool.window.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

const doorTool: Tool = {
  id: "door",
  labelKey: "tool.door",
  floorOnly: true,
  hintKey: () => "tool.door.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// ── Stair (Treppe) ───────────────────────────────────────────────────────────
// An den gekoppelten Befehl `stair` (TOOL_COMMAND) gebunden: der interaktive
// Ablauf (Startpunkt → Laufrichtung/Ende → committen) läuft komplett in der
// CommandEngine. Dieses Tool-Objekt ist ein reiner Platzhalter (wie window/door);
// der Controller ruft es nicht auf, sobald der gekoppelte Befehl läuft.
const stairTool: Tool = {
  id: "stair",
  labelKey: "tool.stair",
  floorOnly: true,
  hintKey: () => "tool.stair.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// ── Room (Raum) ──────────────────────────────────────────────────────────────
// An den gekoppelten Befehl `room` (TOOL_COMMAND) gebunden: der interaktive
// Ablauf (Klick-innen zur Erkennung ODER manueller Umriss) läuft komplett in der
// CommandEngine. Dieses Tool-Objekt ist ein reiner Platzhalter (wie stair/window);
// der Controller ruft es nicht auf, sobald der gekoppelte Befehl läuft.
const roomTool: Tool = {
  id: "room",
  labelKey: "tool.room",
  floorOnly: true,
  hintKey: () => "tool.room.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// ── Line ─────────────────────────────────────────────────────────────────────
// Zwei-Klick-Strecke → Drawing2D{shape:"line"}.

interface LineDrawing {
  phase: "drawing";
  a: Vec2;
  cursor: Vec2 | null;
}
type LineState = { phase: "idle" } | LineDrawing;

function lineDraft(a: Vec2, cursor: Vec2 | null): ToolDraft {
  const preview: DraftShape[] = [];
  if (cursor && segLen(a, cursor) >= EPS) preview.push({ kind: "line", a, b: cursor });
  const draft: ToolDraft = { preview, vertices: [a] };
  if (cursor && segLen(a, cursor) >= EPS) {
    draft.hud = {
      at: cursor,
      text: `${segLen(a, cursor).toFixed(2)} m · ${Math.abs(
        (segAngleDeg(a, cursor) + 360) % 360,
      ).toFixed(0)}°`,
    };
  }
  return draft;
}

function appendLine(project: Project, a: Vec2, b: Vec2, ctx: ToolContext): Project {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "line", a, b },
    // Kein expliziter Linienstil → erbt Farbe/Strichstärke aus der aktiven Ebene
    // (Kategorie). Ein Linienstil-Picker kann das später überschreiben.
  };
  return { ...project, drawings2d: [...project.drawings2d, d] };
}

const lineTool: Tool = {
  id: "line",
  labelKey: "tool.line",
  hintKey: (s) =>
    (s as LineState).phase === "drawing" ? "tool.line.secondPoint" : "tool.line.firstPoint",
  init: () => ({ phase: "idle" }),
  onClick: (state, p, ctx) => {
    const s = state as LineState;
    if (s.phase !== "drawing") {
      return [{ phase: "drawing", a: p.point, cursor: p.point }, { draft: lineDraft(p.point, p.point) }];
    }
    // Zweiter Klick: Strecke abschließen (Null-Strecke verwerfen).
    if (segLen(s.a, p.point) < EPS) {
      return [{ phase: "idle" }, { draft: null, done: true }];
    }
    const a = s.a;
    const b = p.point;
    return [
      { phase: "idle" },
      { draft: null, done: true, commit: (proj) => appendLine(proj, a, b, ctx) },
    ];
  },
  onMove: (state, p) => {
    const s = state as LineState;
    if (s.phase !== "drawing") return [s, { draft: { preview: [], vertices: [] } }];
    return [{ ...s, cursor: p.point }, { draft: lineDraft(s.a, p.point) }];
  },
  // Linie braucht genau zwei Punkte; Doppelklick/Enter bricht den offenen
  // Entwurf ab (kein gültiges zweites Ende gesetzt).
  onCommitGesture: () => [{ phase: "idle" }, { draft: null, done: true }],
  onCancel: () => [{ phase: "idle" }, { draft: null, done: true }],
};

// ── Polyline ─────────────────────────────────────────────────────────────────
// Mehrteilige 2D-Polylinie → Drawing2D{shape:"polyline"}. Abschluss per Doppel-/
// Rechtsklick/Enter (offen) ODER Klick auf den Startpunkt (geschlossen).

interface PolyDrawing {
  phase: "drawing";
  points: Vec2[];
  cursor: Vec2 | null;
}
type PolyState = { phase: "idle" } | PolyDrawing;

function polyDraft(points: Vec2[], cursor: Vec2 | null): ToolDraft {
  const preview: DraftShape[] = [];
  const all = cursor ? [...points, cursor] : points;
  for (let i = 0; i < all.length - 1; i++) {
    if (segLen(all[i], all[i + 1]) >= EPS) preview.push({ kind: "line", a: all[i], b: all[i + 1] });
  }
  const draft: ToolDraft = { preview, vertices: points };
  if (cursor && points.length > 0) {
    const a = points[points.length - 1];
    if (segLen(a, cursor) >= EPS) {
      draft.hud = {
        at: cursor,
        text: `${segLen(a, cursor).toFixed(2)} m · ${Math.abs(
          (segAngleDeg(a, cursor) + 360) % 360,
        ).toFixed(0)}°`,
      };
    }
  }
  return draft;
}

function appendPolyline(project: Project, pts: Vec2[], closed: boolean, ctx: ToolContext): Project {
  if (pts.length < 2) return project;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "polyline", pts, closed },
    // Kein expliziter Linienstil → erbt Farbe/Strichstärke aus der aktiven Ebene
    // (Kategorie). Ein Linienstil-Picker kann das später überschreiben.
  };
  return { ...project, drawings2d: [...project.drawings2d, d] };
}

const polylineTool: Tool = {
  id: "polyline",
  labelKey: "tool.polyline",
  hintKey: (s) =>
    (s as PolyState).phase === "drawing" ? "tool.polyline.nextPoint" : "tool.polyline.firstPoint",
  init: () => ({ phase: "idle" }),
  onClick: (state, p, ctx) => {
    const s = state as PolyState;
    if (s.phase !== "drawing") {
      return [{ phase: "drawing", points: [p.point], cursor: p.point }, { draft: polyDraft([p.point], p.point) }];
    }
    // Klick auf den Startpunkt schließt die Polylinie (ab 3 Punkten).
    if (s.points.length >= 3 && segLen(p.point, s.points[0]) < EPS) {
      const pts = s.points;
      return [{ phase: "idle" }, { draft: null, done: true, commit: (proj) => appendPolyline(proj, pts, true, ctx) }];
    }
    const points = [...s.points, p.point];
    return [{ phase: "drawing", points, cursor: p.point }, { draft: polyDraft(points, p.point) }];
  },
  onMove: (state, p) => {
    const s = state as PolyState;
    if (s.phase !== "drawing") return [s, { draft: { preview: [], vertices: [] } }];
    return [{ ...s, cursor: p.point }, { draft: polyDraft(s.points, p.point) }];
  },
  onCommitGesture: (state, ctx) => {
    const s = state as PolyState;
    if (s.phase !== "drawing" || s.points.length < 2) {
      return [{ phase: "idle" }, { draft: null, done: true }];
    }
    const pts = s.points;
    return [{ phase: "idle" }, { draft: null, done: true, commit: (proj) => appendPolyline(proj, pts, false, ctx) }];
  },
  onCancel: () => [{ phase: "idle" }, { draft: null, done: true }],
  onUndoPoint: (state) => {
    const s = state as PolyState;
    if (s.phase === "drawing" && s.points.length > 1) {
      const points = s.points.slice(0, -1);
      return [{ phase: "drawing", points, cursor: s.cursor }, { draft: polyDraft(points, s.cursor) }];
    }
    return [{ phase: "idle" }, { draft: null, done: true }];
  },
};

// ── Rectangle ────────────────────────────────────────────────────────────────
// Zwei Ecken (Klick-Klick) → Drawing2D{shape:"rect"} (achsparallel, min/max sortiert).

interface RectDrawing {
  phase: "drawing";
  p0: Vec2;
  cursor: Vec2 | null;
}
type RectState = { phase: "idle" } | RectDrawing;

function rectCorners(a: Vec2, b: Vec2): Vec2[] {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

function rectDraft(p0: Vec2, cursor: Vec2 | null): ToolDraft {
  const preview: DraftShape[] = [];
  if (cursor) preview.push({ kind: "poly", pts: rectCorners(p0, cursor), closed: true });
  const draft: ToolDraft = { preview, vertices: [p0] };
  if (cursor) {
    const w = Math.abs(cursor.x - p0.x);
    const h = Math.abs(cursor.y - p0.y);
    draft.hud = { at: cursor, text: `${w.toFixed(2)} × ${h.toFixed(2)} m` };
  }
  return draft;
}

function appendRect(project: Project, a: Vec2, b: Vec2, ctx: ToolContext): Project {
  const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
  const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
  if (Math.abs(max.x - min.x) < EPS || Math.abs(max.y - min.y) < EPS) return project;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "rect", min, max },
    // Kein expliziter Linienstil → erbt Farbe/Strichstärke aus der aktiven Ebene
    // (Kategorie). Ein Linienstil-Picker kann das später überschreiben.
  };
  return { ...project, drawings2d: [...project.drawings2d, d] };
}

const rectTool: Tool = {
  id: "rect",
  labelKey: "tool.rect",
  hintKey: (s) =>
    (s as RectState).phase === "drawing" ? "tool.rect.secondCorner" : "tool.rect.firstCorner",
  init: () => ({ phase: "idle" }),
  onClick: (state, p, ctx) => {
    const s = state as RectState;
    if (s.phase !== "drawing") {
      return [{ phase: "drawing", p0: p.point, cursor: p.point }, { draft: rectDraft(p.point, p.point) }];
    }
    const a = s.p0;
    const b = p.point;
    return [{ phase: "idle" }, { draft: null, done: true, commit: (proj) => appendRect(proj, a, b, ctx) }];
  },
  onMove: (state, p) => {
    const s = state as RectState;
    if (s.phase !== "drawing") return [s, { draft: { preview: [], vertices: [] } }];
    return [{ ...s, cursor: p.point }, { draft: rectDraft(s.p0, p.point) }];
  },
  onCommitGesture: () => [{ phase: "idle" }, { draft: null, done: true }],
  onCancel: () => [{ phase: "idle" }, { draft: null, done: true }],
};

// Kreis: Platzhalter-Werkzeug (analog window/door), gekoppelt an den
// `circle`-Befehl (TOOL_COMMAND in App.tsx). Der eigentliche Ablauf
// (Mittelpunkt → Radius) läuft über die Command-Engine — EIN Pfad für
// Toolbar-Klick und getipptes „circle". Nicht floorOnly (freie 2D-Zeichnung).
const circleTool: Tool = {
  id: "circle",
  labelKey: "tool.circle",
  hintKey: () => "tool.circle.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Bogen: Platzhalter-Werkzeug, gekoppelt an den `arc`-Befehl (3 Klicks:
// Mitte → Start/Radius → Ende). Wie Kreis nicht floorOnly.
const arcTool: Tool = {
  id: "arc",
  labelKey: "tool.arc",
  hintKey: () => "tool.arc.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Ellipse: Platzhalter-Werkzeug, gekoppelt an den `ellipse`-Befehl (zwei
// Bounding-Box-Ecken). Wie Kreis/Bogen nicht floorOnly.
const ellipseTool: Tool = {
  id: "ellipse",
  labelKey: "tool.ellipse",
  hintKey: () => "tool.ellipse.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Spline: Platzhalter-Werkzeug, gekoppelt an den `spline`-Befehl (Wegpunkte,
// wie Polylinie, aber geglättet). Nicht floorOnly.
const splineTool: Tool = {
  id: "spline",
  labelKey: "tool.spline",
  hintKey: () => "tool.spline.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Bezier: Platzhalter-Werkzeug, gekoppelt an den `bezier`-Befehl (manuelle
// Kontrollpunkt-Kette). Nicht floorOnly.
const bezierTool: Tool = {
  id: "bezier",
  labelKey: "tool.bezier",
  hintKey: () => "tool.bezier.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Bemassung: Platzhalter-Werkzeug, gekoppelt an den `dimension`-Befehl (zwei
// Punkte + Lage der Masslinie). Nicht floorOnly.
const dimensionTool: Tool = {
  id: "dimension",
  labelKey: "tool.dimension",
  hintKey: () => "tool.dimension.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Text: Platzhalter-Werkzeug, gekoppelt an den `text`-Befehl (Ankerpunkt →
// getippte Zeile). Wie Kreis/Bogen nicht floorOnly (freies 2D-Element).
const textTool: Tool = {
  id: "text",
  labelKey: "tool.text",
  hintKey: () => "tool.text.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Textspalte: Platzhalter-Werkzeug, gekoppelt an den `textbox`-Befehl (Anker →
// Spaltenbreite → getippte Zeile). Freies 2D-Element (nicht floorOnly).
const textboxTool: Tool = {
  id: "textbox",
  labelKey: "tool.textbox",
  hintKey: () => "tool.textbox.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// Bild einfügen: KEIN Klick-Platzieren wie die übrigen Zeichen-Werkzeuge —
// die Datei-Auswahl ist async (Dateidialog), daher fängt `onSelectTool`
// (App.tsx) die ID VOR der normalen Werkzeug-Aktivierung ab und öffnet direkt
// den Datei-Dialog (s. dortigen Kommentar). Dieses Objekt existiert nur, damit
// `TOOLS`/`ToolsPanel` eine vollständige Abbildung + Label/Hint haben.
const imageTool: Tool = {
  id: "image",
  labelKey: "tool.image",
  hintKey: () => "tool.image.hint",
  init: () => ({ phase: "idle" }),
  onClick: (s) => [s, { draft: null }],
  onMove: (s) => [s, { draft: null }],
  onCommitGesture: (s) => [s, { draft: null, done: true }],
  onCancel: (s) => [s, { draft: null, done: true }],
};

// ── Registry ─────────────────────────────────────────────────────────────────

const TOOLS: Record<ToolId, Tool> = {
  select: selectTool,
  wall: wallTool,
  ceiling: ceilingTool,
  window: windowTool,
  door: doorTool,
  stair: stairTool,
  room: roomTool,
  line: lineTool,
  polyline: polylineTool,
  rect: rectTool,
  circle: circleTool,
  arc: arcTool,
  ellipse: ellipseTool,
  spline: splineTool,
  bezier: bezierTool,
  dimension: dimensionTool,
  text: textTool,
  textbox: textboxTool,
  image: imageTool,
};

/** Liefert das Werkzeug zur ID. */
export function getTool(id: ToolId): Tool {
  return TOOLS[id];
}

