// Circle — Mittelpunkt + Radius. Schritte:
//   1) „Mittelpunkt:" → Punkt
//   2) „Radius:"       → Punkt (Abstand) ODER getippte Zahl (Radius) → commit
//
// Radius akzeptiert sowohl einen Maus-Punkt (Abstand zum Mittelpunkt) als auch
// eine getippte nackte Zahl. Der Kreis wird in generatePlan als geschlossene
// Polygon-Approximation gerendert.

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

interface CircleIdle extends CommandState {
  phase: "center";
}
interface CircleDrawing extends CommandState {
  phase: "radius";
  center: Vec2;
  cursor: Vec2 | null;
}
type CircleState = CircleIdle | CircleDrawing;

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Tab-Feld des Radius-Schritts: der Radius selbst. */
const CIRCLE_FIELDS: CommandField[] = [{ id: "radius", labelKey: "cmd.field.radius" }];

/**
 * Punkt auf dem Kreis aus gelocktem Radius (oder Cursor-Abstand), so dass
 * dist(center, point) = Radius. Die Richtung folgt dem Cursor (sonst +X).
 */
function circlePointFromFields(center: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const r = "radius" in locks ? Math.abs(locks.radius) : cursor ? dist(center, cursor) : 0;
  if (cursor) {
    const d = dist(center, cursor);
    if (d > EPS) {
      return { x: center.x + ((cursor.x - center.x) / d) * r, y: center.y + ((cursor.y - center.y) / d) * r };
    }
  }
  return { x: center.x + r, y: center.y };
}

/** Punkte einer Kreis-Approximation (für die Vorschau). */
function circlePts(center: Vec2, r: number): Vec2[] {
  const N = 48;
  const pts: Vec2[] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    pts.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  return pts;
}

/** Vorschau (Kreis) + HUD (Radius). */
function circleDraft(center: Vec2, r: number, at: Vec2 | null): ToolDraft {
  if (r < EPS) return { preview: [], vertices: [center] };
  const preview: DraftShape[] = [{ kind: "poly", pts: circlePts(center, r), closed: true }];
  const draft: ToolDraft = { preview, vertices: [center] };
  if (at) draft.hud = { at, text: `r ${r.toFixed(2)} m` };
  return draft;
}

function appendCircle(p: Project, center: Vec2, r: number, ctx: CommandContext): Project {
  if (r < EPS) return p;
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "circle", center, r },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

const idle = (): [CommandState, CommandResult] => [
  { phase: "center", lastPoint: null },
  { draft: null, done: true },
];

export const circleCommand: Command = {
  name: "circle",
  labelKey: "cmd.circle.label",
  prompt: (s) => ((s as CircleState).phase === "radius" ? "cmd.circle.radius" : "cmd.circle.center"),
  accepts: (s) => ((s as CircleState).phase === "radius" ? ["point", "number"] : ["point"]),
  options: () => [],
  init: (): CircleIdle => ({ phase: "center", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as CircleState;
    if (s.phase !== "radius") {
      if (input.kind !== "point") return [s, { draft: null }];
      const ns: CircleDrawing = { phase: "radius", center: input.point, cursor: input.point, lastPoint: input.point };
      return [ns, { draft: circleDraft(input.point, 0, null) }];
    }
    // Radius-Schritt: Zahl = Radius, Punkt = Abstand zum Mittelpunkt.
    let r: number;
    if (input.kind === "number") r = input.value;
    else if (input.kind === "point") r = dist(s.center, input.point);
    else {
      const rr = s.cursor ? dist(s.center, s.cursor) : 0;
      return [s, { draft: circleDraft(s.center, rr, s.cursor) }];
    }
    const center = s.center;
    return [
      { phase: "center", lastPoint: null },
      { draft: null, done: true, commit: (p) => appendCircle(p, center, r, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as CircleState;
    if (s.phase !== "radius") return [s, { draft: null }];
    const r = dist(s.center, point);
    const ns: CircleDrawing = { ...s, cursor: point };
    return [ns, { draft: circleDraft(s.center, r, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => idle(),
  onCancel: (): [CommandState, CommandResult] => idle(),

  // Tab-Feld-Zyklus nur im „radius"-Schritt: ein Radius-Feld; der gelockte Wert
  // committet direkt (Punkt liegt auf dem Kreis, dist(center,point)=radius).
  fields: (state) => ((state as CircleState).phase === "radius" ? CIRCLE_FIELDS : []),
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as CircleState;
    if (s.phase !== "radius" || !cursor) return {};
    return { radius: dist(s.center, cursor) };
  },
  pointFromFields: (state, locks, cursor) => {
    const s = state as CircleState;
    if (s.phase !== "radius") return null;
    return circlePointFromFields(s.center, locks, cursor);
  },
};
