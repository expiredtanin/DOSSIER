// Konstruktionslinie (Hilfslinie) — wie `line`, aber committet `shape:"xline"`
// (unendliche Ausrichtungslinie, s. `Drawing2DGeom["xline"]`). Zwei Punkte
// legen nur die Richtung fest; Rendering/Snapping verlängern weit darüber
// hinaus. Schritte:
//   1) „Startpunkt:" → Punkt
//   2) „Richtungspunkt:" → Punkt (Tab-Felder Länge/Winkel wie bei Line) → commit

import { segmentHud } from "../../tools/types";
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
import { createMutation, createPreview } from "../createCore";

const EPS = 1e-6;
const DEG = Math.PI / 180;
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
function xlineDraft(ctx: CommandContext, a: Vec2, cursor: Vec2 | null): ToolDraft {
  // Vorschau (Kern): beidseitig um 30 m verlängert — die echte Länge kommt aus der Plan-Ableitung.
  const preview: DraftShape[] = cursor ? createPreview(ctx, { cmd: "xline" }, [a, cursor]).shapes : [];
  const draft: ToolDraft = { preview, vertices: [a] };
  if (cursor && segLen(a, cursor) >= EPS) draft.hud = segmentHud(a, cursor);
  return draft;
}

/** Commit (Kern, `cmd_draw.rs`): Konstruktionslinie durch a, b. */
const appendXline = (a: Vec2, b: Vec2, ctx: CommandContext) => createMutation(ctx, { cmd: "xline", a, b });

export const xlineCommand: Command = {
  name: "xline",
  labelKey: "cmd.xline.label",
  prompt: (s) => ((s as XlineState).phase === "end" ? "cmd.xline.end" : "cmd.xline.start"),
  accepts: () => ["point", "number"],
  options: () => [],
  init: (): XlineIdle => ({ phase: "start", lastPoint: null }),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as XlineState;
    if (input.kind !== "point") return [s, { draft: s.phase === "end" ? xlineDraft(ctx, s.a, s.cursor) : null }];
    const pt = input.point;
    if (s.phase !== "end") {
      const next: XlineDrawing = { phase: "end", a: pt, cursor: pt, lastPoint: pt };
      return [next, { draft: xlineDraft(ctx, pt, pt) }];
    }
    if (segLen(s.a, pt) < EPS) {
      return [{ phase: "start", lastPoint: null }, { draft: null, done: true }];
    }
    const a = s.a;
    return [
      { phase: "start", lastPoint: null },
      { draft: null, done: true, commit: appendXline(a, pt, ctx) },
    ];
  },

  onMove: (state, point, _snap, ctx): [CommandState, CommandResult] => {
    const s = state as XlineState;
    if (s.phase !== "end") return [s, { draft: null }];
    const next: XlineDrawing = { ...s, cursor: point };
    return [next, { draft: xlineDraft(ctx, s.a, point) }];
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
