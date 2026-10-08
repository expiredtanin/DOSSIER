// Strahl (Nutzer-Wunsch: „Ray, halb-unendliche Linie — nur xline, beidseitig
// unendlich, existiert") — wie `xline`, aber nur EINSEITIG (über den
// Richtungspunkt hinaus) verlängert; der Startpunkt bleibt ein fester Anker.
// Schritte:
//   1) „Anker:"           → Punkt
//   2) „Richtungspunkt:" → Punkt (Tab-Felder Länge/Winkel wie bei Line) → commit

import type { Drawing2D } from "../../model/types";
import { segmentHud, uniqueId } from "../../tools/types";
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
const DEG = Math.PI / 180;
const RAY_PREVIEW_EXT_M = 30; // nur für die Live-Vorschau — echte Länge kommt aus generatePlan
const segLen = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
const segAngleDeg = (a: Vec2, b: Vec2): number =>
  (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

const LINE_FIELDS: CommandField[] = [
  { id: "length", labelKey: "cmd.field.length" },
  { id: "angle", labelKey: "cmd.field.angle" },
];

function lineEndFromFields(a: Vec2, locks: Record<string, number>, cursor: Vec2 | null): Vec2 {
  const ref = cursor ?? a;
  const length = "length" in locks ? locks.length : segLen(a, ref);
  const angleDeg = "angle" in locks ? locks.angle : segAngleDeg(a, ref);
  const ang = angleDeg * DEG;
  return { x: a.x + Math.cos(ang) * length, y: a.y + Math.sin(ang) * length };
}

interface RayIdle extends CommandState {
  phase: "start";
}
interface RayDrawing extends CommandState {
  phase: "end";
  a: Vec2;
  cursor: Vec2 | null;
}
type RayState = RayIdle | RayDrawing;

/** Vorschau: kurzes Segment PLUS Verlängerung NUR über den Cursor hinaus (Anker bleibt fest). */
function rayDraft(a: Vec2, cursor: Vec2 | null): ToolDraft {
  const preview: DraftShape[] = [];
  if (cursor && segLen(a, cursor) >= EPS) {
    const len = segLen(a, cursor);
    const ux = (cursor.x - a.x) / len;
    const uy = (cursor.y - a.y) / len;
    preview.push({
      kind: "line",
      a,
      b: { x: cursor.x + ux * RAY_PREVIEW_EXT_M, y: cursor.y + uy * RAY_PREVIEW_EXT_M },
    });
  }
  const draft: ToolDraft = { preview, vertices: [a] };
  if (cursor && segLen(a, cursor) >= EPS) draft.hud = segmentHud(a, cursor);
  return draft;
}

function appendRay(p: Project, a: Vec2, b: Vec2, ctx: CommandContext): Project {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "ray", a, b },
  };
  return { ...p, drawings2d: [...p.drawings2d, d] };
}

export const rayCommand: Command = {
  name: "ray",
  labelKey: "cmd.ray.label",
  prompt: (s) => ((s as RayState).phase === "end" ? "cmd.ray.end" : "cmd.ray.start"),
  accepts: () => ["point", "number"],
  options: () => [],
  init: (): RayIdle => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as RayState;
    if (input.kind !== "point") return [s, { draft: s.phase === "end" ? rayDraft(s.a, s.cursor) : null }];
    const pt = input.point;
    if (s.phase !== "end") {
      const next: RayDrawing = { phase: "end", a: pt, cursor: pt, lastPoint: pt };
      return [next, { draft: rayDraft(pt, pt) }];
    }
    if (segLen(s.a, pt) < EPS) {
      return [{ phase: "start", lastPoint: null }, { draft: null, done: true }];
    }
    const a = s.a;
    return [
      { phase: "start", lastPoint: null },
      { draft: null, done: true, commit: (p) => appendRay(p, a, pt, ctx) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as RayState;
    if (s.phase !== "end") return [s, { draft: null }];
    const next: RayDrawing = { ...s, cursor: point };
    return [next, { draft: rayDraft(s.a, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => [
    { phase: "start", lastPoint: null },
    { draft: null, done: true },
  ],
  onCancel: (): [CommandState, CommandResult] => [
    { phase: "start", lastPoint: null },
    { draft: null, done: true },
  ],

  fields: (state) => ((state as RayState).phase === "end" ? LINE_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as RayState;
    if (s.phase !== "end") return null;
    return lineEndFromFields(s.a, locks, cursor);
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as RayState;
    if (s.phase !== "end" || !cursor) return {};
    return {
      length: segLen(s.a, cursor),
      angle: ((segAngleDeg(s.a, cursor) % 360) + 360) % 360,
    };
  },
};
