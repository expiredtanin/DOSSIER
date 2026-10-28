// Konstruktionslinie (Hilfslinie) — wie `line`, aber committet `shape:"xline"`
// (unendliche Ausrichtungslinie, s. `Drawing2DGeom["xline"]`). Zwei Punkte
// legen nur die Richtung fest; Rendering/Snapping verlängern weit darüber
// hinaus. Schritte:
//   1) „Startpunkt:" → Punkt
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
  ToolDraft,
  Vec2,
} from "../types";
import { addItems, opsMutation } from "../../core";
import type { CoreOp } from "../../core";

const EPS = 1e-6;
const DEG = Math.PI / 180;
const XLINE_PREVIEW_EXT_M = 30; // nur für die Live-Vorschau — echte Länge kommt aus generatePlan
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

interface XlineIdle extends CommandState {
  phase: "start";
}
interface XlineDrawing extends CommandState {
  phase: "end";
  a: Vec2;
  cursor: Vec2 | null;
}
type XlineState = XlineIdle | XlineDrawing;

/** Vorschau: kurzes Segment PLUS Verlängerung in beide Richtungen (deutet „unendlich" an). */
function xlineDraft(a: Vec2, cursor: Vec2 | null): ToolDraft {
  const preview: DraftShape[] = [];
  if (cursor && segLen(a, cursor) >= EPS) {
    const ux = (cursor.x - a.x) / segLen(a, cursor);
    const uy = (cursor.y - a.y) / segLen(a, cursor);
    preview.push({
      kind: "line",
      a: { x: a.x - ux * XLINE_PREVIEW_EXT_M, y: a.y - uy * XLINE_PREVIEW_EXT_M },
      b: { x: cursor.x + ux * XLINE_PREVIEW_EXT_M, y: cursor.y + uy * XLINE_PREVIEW_EXT_M },
    });
  }
  const draft: ToolDraft = { preview, vertices: [a] };
  if (cursor && segLen(a, cursor) >= EPS) draft.hud = segmentHud(a, cursor);
  return draft;
}

function appendXline(a: Vec2, b: Vec2, ctx: CommandContext): CoreOp[] {
  const d: Drawing2D = {
    id: uniqueId("dr2d"),
    type: "drawing2d",
    levelId: ctx.level.id,
    categoryCode: ctx.defaultCategoryCode,
    geom: { shape: "xline", a, b },
  };
  return addItems("drawings2d", [d]);
}

export const xlineCommand: Command = {
  name: "xline",
  labelKey: "cmd.xline.label",
  prompt: (s) => ((s as XlineState).phase === "end" ? "cmd.xline.end" : "cmd.xline.start"),
  accepts: () => ["point", "number"],
  options: () => [],
  init: (): XlineIdle => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as XlineState;
    if (input.kind !== "point") return [s, { draft: s.phase === "end" ? xlineDraft(s.a, s.cursor) : null }];
    const pt = input.point;
    if (s.phase !== "end") {
      const next: XlineDrawing = { phase: "end", a: pt, cursor: pt, lastPoint: pt };
      return [next, { draft: xlineDraft(pt, pt) }];
    }
    if (segLen(s.a, pt) < EPS) {
      return [{ phase: "start", lastPoint: null }, { draft: null, done: true }];
    }
    const a = s.a;
    return [
      { phase: "start", lastPoint: null },
      { draft: null, done: true, commit: opsMutation(() => appendXline(a, pt, ctx)) },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as XlineState;
    if (s.phase !== "end") return [s, { draft: null }];
    const next: XlineDrawing = { ...s, cursor: point };
    return [next, { draft: xlineDraft(s.a, point) }];
  },

  onConfirm: (): [CommandState, CommandResult] => [
    { phase: "start", lastPoint: null },
    { draft: null, done: true },
  ],
  onCancel: (): [CommandState, CommandResult] => [
    { phase: "start", lastPoint: null },
    { draft: null, done: true },
  ],

  fields: (state) => ((state as XlineState).phase === "end" ? LINE_FIELDS : []),
  pointFromFields: (state, locks, cursor) => {
    const s = state as XlineState;
    if (s.phase !== "end") return null;
    return lineEndFromFields(s.a, locks, cursor);
  },
  fieldValues: (state, _locks, cursor): Record<string, number> => {
    const s = state as XlineState;
    if (s.phase !== "end" || !cursor) return {};
    return {
      length: segLen(s.a, cursor),
      angle: ((segAngleDeg(s.a, cursor) % 360) + 360) % 360,
    };
  },
};
