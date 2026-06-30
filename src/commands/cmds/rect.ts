// Rectangle — zwei Ecken (portiert rectTool). Schritte:
//   1) „Erste Ecke:"            → Punkt
//   2) „Gegenüberliegende Ecke:" → Punkt → commit Drawing2D rect → done
//
// Getippte Maße: die zweite Ecke kann als `r<breite>,<höhe>` relativ zur ersten
// eingegeben werden (die Engine löst `r…` relativ zu lastPoint auf).

import type { Drawing2D } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandContext,
  CommandField,
  CommandResult,
  CommandState,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

const EPS = 1e-6;

/** Tab-Felder des zweiten-Ecke-Schritts: Breite, Höhe. */
const RECT_FIELDS: CommandField[] = [
  { id: "width", labelKey: "cmd.field.width" },
  { id: "height", labelKey: "cmd.field.height" },
];

/**
 * Gegenüberliegende Ecke aus gelockten Feldern (width/height) + Cursor: eine
 * gelockte Kantenlänge nimmt ihren Betrag, das Vorzeichen (Quadrant) folgt dem
 * Cursor relativ zur ersten Ecke `a`; ungelockt folgt die Kante direkt dem Cursor.
 */
function rectCornerFromFields(a: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const cur = cursor ?? a;
  const dx = cur.x - a.x;
  const dy = cur.y - a.y;
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  const w = "width" in locks ? sx * Math.abs(locks.width) : dx;
  const h = "height" in locks ? sy * Math.abs(locks.height) : dy;
  return { x: a.x + w, y: a.y + h };
}

interface RectIdle extends CommandState {
  phase: "corner1";
}
interface RectDrawing extends CommandState {
  phase: "corner2";
  a: Vec2;
  cursor: Vec2 | null;
}
type RectState = RectIdle | RectDrawing;

function rectGeom(a: Vec2, b: Vec2): { min: Vec2; max: Vec2 } {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  };
}

/** Vorschau (geschlossenes Rechteck) + HUD (Breite × Höhe). */
function rectDraft(a: Vec2, cursor: Vec2 | null): ToolDraft {
  if (!cursor) return { preview: [], vertices: [a] };
  const g = rectGeom(a, cursor);
  const pts: Vec2[] = [
    g.min,
    { x: g.max.x, y: g.min.y },
    g.max,
    { x: g.min.x, y: g.max.y },
  ];
  const preview: DraftShape[] = [{ kind: "poly", pts, closed: true }];
  const w = g.max.x - g.min.x;
  const h = g.max.y - g.min.y;
  return {
    preview,
    vertices: [a],
    hud: { at: cursor, text: `${w.toFixed(2)} × ${h.toFixed(2)} m` },
  };
}

function appendRect(p: Project, a: Vec2, b: Vec2, ctx: CommandContext): Project {
  const g = rectGeom(a, b);
  if (g.max.x - g.min.x < EPS || g.max.y - g.min.y < EPS) return p; // Null-Rechteck
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "rect", min: g.min, max: g.max },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "corner1", lastPoint: null },
  { draft: null, done: true },
];

export const rectCommand: Command = {
  name: "rect",
  labelKey: "cmd.rect.label",
  prompt: (s) => ((s as RectState).phase === "corner2" ? "cmd.rect.second" : "cmd.rect.first"),
  accepts: () => ["point", "number"],
  options: () => [],
  init: (): RectIdle => ({ phase: "corner1", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as RectState;
    if (input.kind !== "point") {
      return [s, { draft: s.phase === "corner2" ? rectDraft(s.a, s.cursor) : null }];
    }
    const pt = input.point;
    if (s.phase !== "corner2") {
      const ns: RectDrawing = { phase: "corner2", a: pt, cursor: pt, lastPoint: pt };
      return [ns, { draft: rectDraft(pt, pt) }];
    }
    const a = s.a;
    return [
      { phase: "corner1", lastPoint: null },
      { draft: null, done: true, commit: (p) => appendRect(p, a, pt, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as RectState;
    if (s.phase !== "corner2") return [s, { draft: null }];
    const ns: RectDrawing = { ...s, cursor: point };
    return [ns, { draft: rectDraft(s.a, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),

  // Tab-Feld-Zyklus nur im „corner2"-Schritt: Breite + Höhe (signiert nach Cursor).
  fields: (state) => ((state as RectState).phase === "corner2" ? RECT_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as RectState;
    if (s.phase !== "corner2") return null;
    return rectCornerFromFields(s.a, locks, cursor);
  },
};
